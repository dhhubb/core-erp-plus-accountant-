import { afterAll } from 'vitest';
import { closeTestPool } from './db';

afterAll(async () => {
  await closeTestPool();
});
