import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { testDatabaseUrl } from '../../src/core/env';
import type { AuthClaims } from '../../src/core/auth';
import { applyUserContext } from '../../src/core/auth';

/**
 * Tests run against the real local Postgres started with `supabase start`. Nothing is mocked.
 * The pool is connected as `postgres` (which bypasses RLS) so fixtures can be seeded; individual
 * assertions then run inside `asUser()` with SET LOCAL ROLE authenticated.
 */
export const testPool = new Pool({
  connectionString: testDatabaseUrl(),
  max: 60,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 20_000,
});

export async function sql<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await testPool.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await sql<T>(text, params);
  return rows[0];
}

/** Run a function inside a transaction on a dedicated connection. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already aborted */
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run a function as the given user: the connection drops into the `authenticated` role and the
 * JWT claims are set, exactly as a request path does. RLS is therefore genuinely exercised.
 */
export async function asUser<T>(
  claims: AuthClaims,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return tx(async (client) => {
    await applyUserContext(client, claims);
    return fn(client);
  });
}

/** Expected failure: returns the error instead of throwing, so tests can assert on it. */
export async function expectError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  // 40001 serialization_failure, 40P01 deadlock_detected
  return code === '40001' || code === '40P01';
}

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}
