/**
 * Environment access. Values are read lazily so tests can set them before first use.
 */

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Connection URL used by request paths and by the CLI/scripts. */
export function databaseUrl(): string {
  return required('DATABASE_URL', process.env.DATABASE_URL);
}

/** Connection URL used by tests. Falls back to DATABASE_URL. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? databaseUrl();
}

/**
 * Request paths connect with the normal database URL and then drop into the `authenticated`
 * role for the duration of the transaction (see withUserContext). The Supabase service role
 * key is never used on a request path.
 */
export function connectionString(): string {
  return databaseUrl();
}
