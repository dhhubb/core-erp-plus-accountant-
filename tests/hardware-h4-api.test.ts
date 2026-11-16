import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as printerGet, PUT as printerPut } from '../src/app/api/pos/printer/route';
import { POST as printRelay } from '../src/app/api/branch/print/route';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { escPosToBase64, generateEscPos } from '../src/verticals/pos/escpos';
import { sampleReceiptData } from '../src/verticals/pos/printing';

/**
 * H4 — the printer API and the branch relay route, driven through the real handlers with a real
 * access token. The relay writes to a real TCP socket (a stand-in printer on the LAN); nothing is
 * mocked.
 */

const FIXED_DATE = new Date('2026-06-15T10:00:00Z');

function request(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

let printerServer: Server | null = null;
let printerChunks: Buffer[] = [];
let printerPort = 0;

async function startPrinter(): Promise<number> {
  printerChunks = [];
  printerServer = createServer((socket: Socket) => {
    socket.on('data', (chunk: Buffer) => printerChunks.push(chunk));
  });
  await new Promise<void>((resolve) => printerServer!.listen(0, '127.0.0.1', () => resolve()));
  const address = printerServer.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  printerPort = address.port;
  return printerPort;
}

beforeEach(() => {
  process.env.BRANCH_MODE = 'branch';
});

afterEach(async () => {
  delete process.env.BRANCH_MODE;
  if (printerServer) {
    await new Promise<void>((resolve) => printerServer!.close(() => resolve()));
    printerServer = null;
  }
});

describe('H4 printer API', () => {
  let tenant: Tenant;
  let token: string;

  beforeEach(async () => {
    tenant = await createTenant('H4 API');
    token = tenantToken(tenant);
  });

  it('GET returns the browser default before anything is configured', async () => {
    const response = await printerGet(request(token, '/api/pos/printer'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'browser',
      host: null,
      port: 9100,
      label: 'default',
    });
  });

  it('PUT saves a network printer and GET reads it back', async () => {
    const put = await printerPut(
      request(token, '/api/pos/printer', {
        method: 'PUT',
        body: JSON.stringify({ mode: 'network', host: '192.168.1.50', port: 9100 }),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      mode: 'network',
      host: '192.168.1.50',
      port: 9100,
      label: 'default',
    });

    const get = await printerGet(request(token, '/api/pos/printer'));
    expect(await get.json()).toEqual({
      mode: 'network',
      host: '192.168.1.50',
      port: 9100,
      label: 'default',
    });
  });

  it('PUT rejects a network printer with no host and a port out of range', async () => {
    const noHost = await printerPut(
      request(token, '/api/pos/printer', {
        method: 'PUT',
        body: JSON.stringify({ mode: 'network' }),
      }),
    );
    expect(noHost.status).toBe(422);
    expect((await noHost.json()).error).toContain('host');

    const badPort = await printerPut(
      request(token, '/api/pos/printer', {
        method: 'PUT',
        body: JSON.stringify({ mode: 'browser', port: 99999 }),
      }),
    );
    expect(badPort.status).toBe(422);
  });

  it('requires a bearer token', async () => {
    const response = await printerGet(
      new Request('http://localhost/api/pos/printer', { headers: { accept: 'application/json' } }),
    );
    expect(response.status).toBe(401);
  });
});

describe('H4 branch print relay route', () => {
  let tenant: Tenant;
  let token: string;

  beforeEach(async () => {
    tenant = await createTenant('H4 relay');
    token = tenantToken(tenant);
  });

  it('relays the decoded ESC/POS bytes to the printer socket', async () => {
    const port = await startPrinter();
    const bytes = generateEscPos(sampleReceiptData('T1', FIXED_DATE));

    const response = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ host: '127.0.0.1', port, base64: escPosToBase64(bytes) }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { printed: boolean; bytes: number };
    expect(payload.printed).toBe(true);
    expect(payload.bytes).toBe(bytes.length);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const received = Buffer.concat(printerChunks);
    expect(received.equals(Buffer.from(bytes))).toBe(true);
    expect(Array.from(received.slice(0, 2))).toEqual([0x1b, 0x40]);
  });

  it('rejects a body with no bytes, no host, or a bad port', async () => {
    const noBytes = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ host: '127.0.0.1', port: 9100 }),
      }),
    );
    expect(noBytes.status).toBe(422);

    const noHost = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ base64: 'G0A=', port: 9100 }),
      }),
    );
    expect(noHost.status).toBe(422);

    const badPort = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ host: '127.0.0.1', base64: 'G0A=', port: 70000 }),
      }),
    );
    expect(badPort.status).toBe(422);
  });

  it('reports 502 when the printer is unreachable', async () => {
    const response = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ host: '127.0.0.1', port: 1, base64: 'G0A=' }),
      }),
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('127.0.0.1:1');
  });

  it('refuses to relay on the cloud (printing is a branch-only operation)', async () => {
    delete process.env.BRANCH_MODE;
    const response = await printRelay(
      request(token, '/api/branch/print', {
        method: 'POST',
        body: JSON.stringify({ host: '127.0.0.1', port: 9100, base64: 'G0A=' }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('branch-only');
  });
});
