import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { connectionString } from './env';

/**
 * One process-wide pool. Next.js dev/hot-reload would otherwise leak a pool per reload, so the
 * pool is cached on globalThis.
 */
const globalForPg = globalThis as unknown as { __erpPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.__erpPool) {
    const pool = new Pool({
      connectionString: connectionString(),
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    globalForPg.__erpPool = pool;
  }
  return globalForPg.__erpPool;
}

export async function closePool(): Promise<void> {
  if (globalForPg.__erpPool) {
    await globalForPg.__erpPool.end();
    delete globalForPg.__erpPool;
  }
}

export type { PoolClient };

/** Parameterised query helper. Never build SQL by string concatenation of values. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
