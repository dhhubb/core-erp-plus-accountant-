/**
 * Nightly encrypted branch backup.
 *
 * The branch's durable state is its own Postgres (ADR-0023). This module produces an encrypted dump
 * and uploads it to cloud storage, so a dead branch disk is recoverable. The dump is encrypted
 * before it leaves the branch: the branch never uploads plaintext.
 *
 * Encryption is AES-256-GCM with a 32-byte key from BRANCH_BACKUP_KEY (hex or base64). The output
 * file is `iv (12 bytes) || auth tag (16 bytes) || ciphertext`, and the recorded checksum is the
 * sha256 of the WHOLE encrypted file, so a truncated or tampered upload is detected.
 *
 * Uploading is behind an interface. The default uploader PUTs to BRANCH_BACKUP_UPLOAD_URL (a
 * presigned cloud URL); with no URL configured it writes to BRANCH_BACKUP_DIR, which is what a
 * branch with no cloud configured (or a test) uses.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parse the 32-byte key from BRANCH_BACKUP_KEY (hex or base64). */
export function backupKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.BRANCH_BACKUP_KEY;
  if (!raw || raw.trim() === '') {
    throw new Error('Missing required environment variable: BRANCH_BACKUP_KEY');
  }
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('BRANCH_BACKUP_KEY must decode to 32 bytes (AES-256)');
  }
  return key;
}

/** Encrypt a plaintext dump: iv || tag || ciphertext. */
export function encryptDump(plaintext: Buffer, key: Buffer, iv = randomBytes(IV_BYTES)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypt a dump produced by encryptDump. Throws when the auth tag does not verify. */
export function decryptDump(payload: Buffer, key: Buffer): Buffer {
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** The sha256 of the encrypted file, as the checksum stored on the backup row. */
export function checksumOf(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** Constant-time checksum comparison. */
export function checksumMatches(payload: Buffer, expected: string): boolean {
  const actual = Buffer.from(checksumOf(payload), 'hex');
  const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && timingSafeEqual(actual, want);
}

export interface UploadResult {
  objectKey: string;
  byteSize: number;
}

/** How an encrypted dump reaches cloud storage. */
export type Uploader = (objectKey: string, payload: Buffer) => Promise<UploadResult>;

/** The object key for a run: one immutable key per branch and timestamp. */
export function backupObjectKey(orgId: string, branchId: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `branches/${orgId}/${branchId}/backup-${stamp}.dump.enc`;
}

/** PUT the encrypted dump to a presigned cloud URL. */
export function httpUploader(uploadUrl: string, fetchImpl: typeof fetch = fetch): Uploader {
  return async (objectKey, payload) => {
    const response = await fetchImpl(`${uploadUrl.replace(/\/+$/, '')}/${objectKey}`, {
      method: 'PUT',
      body: new Uint8Array(payload),
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`backup upload failed (${response.status})`);
    }
    return { objectKey, byteSize: payload.length };
  };
}

/** Write the encrypted dump to a local directory. Used when no upload URL is configured. */
export function directoryUploader(dir: string): Uploader {
  return async (objectKey, payload) => {
    const target = path.join(dir, objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, payload);
    return { objectKey: target, byteSize: payload.length };
  };
}

/** The uploader this branch should use: a presigned URL when set, else a local directory. */
export function defaultUploader(env: NodeJS.ProcessEnv = process.env): Uploader {
  const url = env.BRANCH_BACKUP_UPLOAD_URL?.trim();
  if (url) return httpUploader(url);
  return directoryUploader(env.BRANCH_BACKUP_DIR?.trim() || './.branch-backups');
}

export interface BackupRunInput {
  client: PoolClient;
  orgId: string;
  branchId: string;
  /** The plaintext dump. */
  dump: Buffer;
  uploader: Uploader;
  key?: Buffer;
  now?: () => Date;
}

export interface BackupRunResult {
  backupId: string;
  objectKey: string;
  byteSize: number;
  checksum: string;
  status: 'uploaded' | 'failed';
  error: string | null;
}

/**
 * Run one backup: record 'running', encrypt, upload, then record the outcome. The dump is never
 * written in plaintext: it is encrypted in memory before the uploader sees it. A failure is
 * recorded as 'failed' with the error, so the status page shows the last run honestly.
 */
export async function runBackup(input: BackupRunInput): Promise<BackupRunResult> {
  const key = input.key ?? backupKey();
  const now = input.now ?? (() => new Date());

  const started = await input.client.query<{ app: string }>(
    'select app.record_sync_backup($1, $2, $3) as app',
    [input.orgId, input.branchId, 'running'],
  );
  const backupId = started.rows[0]!.app;

  const encrypted = encryptDump(input.dump, key);
  const checksum = checksumOf(encrypted);
  const objectKey = backupObjectKey(input.orgId, input.branchId, now());

  try {
    const uploaded = await input.uploader(objectKey, encrypted);
    await input.client.query('select app.record_sync_backup($1, $2, $3, $4, $5, $6, $7)', [
      input.orgId,
      input.branchId,
      'uploaded',
      uploaded.objectKey,
      uploaded.byteSize,
      checksum,
      null,
    ]);
    return {
      backupId,
      objectKey: uploaded.objectKey,
      byteSize: uploaded.byteSize,
      checksum,
      status: 'uploaded',
      error: null,
    };
  } catch (error) {
    const message = (error as Error).message;
    await input.client.query('select app.record_sync_backup($1, $2, $3, $4, $5, $6, $7)', [
      input.orgId,
      input.branchId,
      'failed',
      objectKey,
      null,
      checksum,
      message,
    ]);
    return { backupId, objectKey, byteSize: encrypted.length, checksum, status: 'failed', error: message };
  }
}
