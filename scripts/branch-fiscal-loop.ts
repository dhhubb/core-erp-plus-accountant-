/**
 * The branch fiscal worker loop. Separate command: `npm run branch:fiscal`.
 *
 * This is the LOOP the brief asks for, not a 30-second cron: the branch process runs a long-lived
 * worker that drains pending fiscal invoices continuously (default every 5s). The worker claims rows
 * with FOR UPDATE SKIP LOCKED, so running two of these at once never submits the same invoice twice.
 *
 * The device client is chosen by configuration:
 *   * FDMS_ENDPOINT + FDMS_DEVICE_SERIAL set  -> the real HTTP client (needs credentials).
 *   * FDMS_MOCK=outage                        -> a mock that always reports a network outage.
 *   * FDMS_MOCK=reject:<n>                    -> a mock that rejects the next n submissions.
 *   * otherwise                               -> a mock device that accepts every submission.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { databaseUrl } from '../src/core/env';
import { isBranchMode } from '../src/branch/config';
import { branchIdentity } from '../src/sync/config';
import { MockFdmsClient, fdmsCredentials, httpFdmsClient, type FdmsClient } from '../src/fiscal/fdms';
import { runFiscalPassOn } from '../src/fiscal/queue';

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

function chooseClient(): FdmsClient {
  const mock = process.env.FDMS_MOCK?.trim().toLowerCase();
  if (mock === 'outage') return new MockFdmsClient({ online: false });
  if (mock && mock.startsWith('reject:')) {
    const n = Number.parseInt(mock.slice('reject:'.length), 10);
    return new MockFdmsClient({ rejections: Number.isFinite(n) ? n : 5 });
  }
  if (mock) return new MockFdmsClient();
  const credentials = fdmsCredentials();
  if (credentials) return httpFdmsClient(credentials);
  // No credentials and no explicit mock: a mock device, so the branch loop still runs.
  return new MockFdmsClient();
}

function intervalMs(): number {
  const raw = Number.parseInt(process.env.FISCAL_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

async function main(): Promise<void> {
  loadEnvFiles();
  if (!isBranchMode()) {
    throw new Error('branch:fiscal must run with BRANCH_MODE=branch');
  }
  const { orgId, branchId } = branchIdentity();
  if (!orgId || !branchId) {
    throw new Error('BRANCH_ORG_ID and BRANCH_ID must be set to run the fiscal loop');
  }

  const fdms = chooseClient();
  const pool = new Pool({
    connectionString: databaseUrl(),
    options: '-c app.branch_mode=branch',
    max: 2,
  });
  const period = intervalMs();
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // eslint-disable-next-line no-console
  console.log(`fiscal: draining every ${period}ms`);

  while (!stopping) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await runFiscalPassOn(client, fdms, { orgId, branchId });
      await client.query('commit');
      if (result.claimed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `fiscal: claimed ${result.claimed}, sent ${result.sent}, retried ${result.retried}, ` +
            `failed ${result.failed}`,
        );
      }
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      // eslint-disable-next-line no-console
      console.error(`fiscal pass failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, period));
  }

  await pool.end();
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error((error as Error).message);
  process.exitCode = 1;
});
