/**
 * The branch sync loop. Separate command: `npm run branch:sync`.
 *
 * Runs the push+pull runner on a timer until stopped. The runner never throws out of a tick, so the
 * loop is a plain interval: a tick that cannot reach the cloud backs off (the runner holds the
 * attempt counters) and the branch keeps selling. With no CLOUD_URL configured the loop is a no-op
 * tick (a valid offline state); a later cloud URL is picked up on the next tick.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { databaseUrl } from '../src/core/env';
import { isBranchMode } from '../src/branch/config';
import { branchIdentity } from '../src/sync/config';
import { newRunnerState, runSyncTick } from '../src/sync/runner';

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

function intervalMs(): number {
  const raw = Number.parseInt(process.env.SYNC_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

async function main(): Promise<void> {
  loadEnvFiles();
  if (!isBranchMode()) {
    throw new Error('branch:sync must run with BRANCH_MODE=branch');
  }
  const { orgId, branchId } = branchIdentity();
  if (!orgId || !branchId) {
    throw new Error('BRANCH_ORG_ID and BRANCH_ID must be set to run the sync loop');
  }

  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const state = newRunnerState();
  const period = intervalMs();
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const client = await pool.connect();
    try {
      const result = await runSyncTick({ client, orgId, branchId, state });
      // eslint-disable-next-line no-console
      console.log(
        `sync: pushed ${result.pushed} (applied ${result.applied}), pulled ${result.pulled}, ` +
          `cursor ${result.cursor}${result.error ? `, error ${result.error}` : ''}`,
      );
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
