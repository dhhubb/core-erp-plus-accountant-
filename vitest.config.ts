import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests run against a real local Postgres started with `supabase start`.
    // Concurrency tests need real parallel connections, so run files sequentially.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
