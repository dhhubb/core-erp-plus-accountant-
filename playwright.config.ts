import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Playwright config for the keyboard-only till test (R3 test 13).
 *
 * The dev server is started by the test itself (see the global setup in the spec), so this config
 * only declares the browser and the base URL. Vitest owns tests/**; Playwright owns e2e/**.
 */
function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1]) out[match[1]] = match[2] ?? '';
  }
  return out;
}

export const POS_ENV = {
  ...loadEnvFile(path.resolve(__dirname, '.env.local')),
  ...loadEnvFile(path.resolve(__dirname, '.env.test')),
};

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // The test starts its own dev server on its own dist dir, so it never clashes with a running
  // `npm run dev` and `npm run build` cannot clobber it.
  webServer: {
    command: 'npm run dev -- --port 12100 --hostname 127.0.0.1',
    url: 'http://127.0.0.1:12100/pos',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { NEXT_DIST_DIR: '.next-e2e' },
  },
  use: {
    baseURL: process.env.POS_BASE_URL ?? 'http://127.0.0.1:12100',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
