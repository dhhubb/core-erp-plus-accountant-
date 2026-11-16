import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * H1 — HTTPS on the LAN. Supporting test (the H1 spec's "test 17" is covered by test 51; this pins
 * the certificate script the branch uses to serve TLS to the tills).
 *
 * The script is run for real and its output is checked with openssl, so the test proves the branch
 * can issue a certificate a till will accept on a LAN IP. Nothing is mocked.
 */

const dir = mkdtempSync(join(tmpdir(), 'erp-branch-https-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('H1 branch HTTPS on the LAN', () => {
  it('issues a self-signed certificate whose subjectAltName carries the LAN host', () => {
    const host = '192.168.10.10';
    const out = execFileSync('bash', ['scripts/branch-https.sh', host, dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    const crt = join(dir, 'branch.crt');
    const key = join(dir, 'branch.key');
    expect(existsSync(crt)).toBe(true);
    expect(existsSync(key)).toBe(true);
    expect(out).toContain('start:branch');

    // The certificate is valid and carries the host as a SAN, which is what a till checks.
    const text = execFileSync(
      'openssl',
      ['x509', '-in', crt, '-noout', '-text', '-ext', 'subjectAltName'],
      { encoding: 'utf8' },
    );
    expect(text).toContain(`IP Address:${host}`);
    expect(text).toMatch(/Subject:.*CN\s*=\s*192\.168\.10\.10/);
  });
});
