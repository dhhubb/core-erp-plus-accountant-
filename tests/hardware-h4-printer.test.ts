import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeEscPosBase64, relayEscPos, relayEscPosBase64 } from '../src/branch/printer';
import { escPosToBase64, generateEscPos } from '../src/verticals/pos/escpos';
import { sampleReceiptData } from '../src/verticals/pos/printing';

/**
 * H4 — the branch's ESC/POS relay (decision 16: the branch opens the socket, outbound only).
 *
 * A real TCP server stands in for the printer on the shop LAN and receives the raw bytes. Nothing
 * is mocked: a genuine socket is opened, the bytes are written, and the server reads them back.
 */

const FIXED_DATE = new Date('2026-06-15T10:00:00Z');

interface FakePrinter {
  server: Server;
  port: number;
  received: () => Promise<Buffer>;
}

/** A TCP server that collects everything written to it, like a printer's raw port. */
async function startFakePrinter(): Promise<FakePrinter> {
  const chunks: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    received: async () => {
      // Give the socket a moment to flush before reading.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Buffer.concat(chunks);
    },
  };
}

let active: FakePrinter | null = null;
afterEach(async () => {
  if (active) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('H4 printer relay', () => {
  it('writes the exact ESC/POS bytes to the printer on the shop LAN', async () => {
    const printer = await startFakePrinter();
    active = printer;

    const receipt = sampleReceiptData('T1', FIXED_DATE);
    const bytes = generateEscPos(receipt);

    const result = await relayEscPos(Buffer.from(bytes), {
      host: '127.0.0.1',
      port: printer.port,
    });
    expect(result.printed).toBe(true);
    expect(result.bytes).toBe(bytes.length);

    const received = await printer.received();
    expect(received.length).toBe(bytes.length);
    // The printer receives the raw bytes, not base64: the first two bytes are ESC @.
    expect(Array.from(received.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(received.equals(Buffer.from(bytes))).toBe(true);
  });

  it('decodes the base64 transport body back to the raw bytes before writing', async () => {
    const printer = await startFakePrinter();
    active = printer;

    const bytes = generateEscPos(sampleReceiptData('T1', FIXED_DATE));
    const base64 = escPosToBase64(bytes);

    const result = await relayEscPosBase64(base64, { host: '127.0.0.1', port: printer.port });
    expect(result.printed).toBe(true);

    const received = await printer.received();
    expect(received.equals(Buffer.from(bytes))).toBe(true);
    // The decoded bytes are raw: they start with the init command, not with the base64 text.
    expect(Array.from(received.slice(0, 2))).toEqual([0x1b, 0x40]);
  });

  it('fails with a clear error when the printer is unreachable', async () => {
    // Port 1 on loopback has no listener.
    await expect(relayEscPos(Buffer.from([0x1b, 0x40]), { host: '127.0.0.1', port: 1 })).rejects.toThrow(
      /printer 127\.0\.0\.1:1/,
    );
  });

  it('round-trips arbitrary bytes through base64', () => {
    const bytes = Buffer.from([0x00, 0x1b, 0xff, 0x7f, 0x80, 0x01]);
    const decoded = decodeEscPosBase64(bytes.toString('base64'));
    expect(decoded.equals(bytes)).toBe(true);
  });
});
