/**
 * Nightly branch backup. Separate command: `npm run branch:backup`.
 *
 * Dumps the branch's own Postgres with pg_dump, encrypts the dump, uploads it, and records the run
 * in public.sync_backups. With no BRANCH_BACKUP_UPLOAD_URL configured it writes the encrypted file
 * to BRANCH_BACKUP_DIR (default ./.branch-backups), which is what a branch with no cloud uses.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { databaseUrl } from '../src/core/env';
import { defaultUploader, runBackup } from '../src/sync/backup';
import { branchIdentity } from '../src/sync/config';

const execFileAsync = promisify(execFile);

function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env.branch']) {
    const resolved = path.resolve(__dirname, '..', file);
    if (!existsSync(resolved)) continue;
    for (const line of readFileSync(resolved, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && match[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2] ?? '';
      }
    }
  }
}

async function dumpDatabase(): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', databaseUrl()],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const { orgId, branchId } = branchIdentity();
  if (!orgId || !branchId) {
    throw new Error('BRANCH_ORG_ID and BRANCH_ID must be set to run a branch backup');
  }

  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    const dump = await dumpDatabase();
    const result = await runBackup({
      client,
      orgId,
      branchId,
      dump,
      uploader: defaultUploader(),
    });
    // eslint-disable-next-line no-console
    console.log(
      `backup ${result.status}: ${result.objectKey} (${result.byteSize} bytes, sha256 ${result.checksum})`,
    );
    if (result.status === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error((error as Error).message);
  process.exitCode = 1;
});
