import { connect, type Socket } from 'node:net';

/**
 * The branch printer relay (H4, decision 16).
 *
 * The branch is the only side that opens the socket to the printer on the shop LAN. The till sends
 * the ESC/POS bytes (base64 in the request body); the branch decodes them to raw bytes and writes
 * them straight to `host:port` (the printer's raw port, default 9100). The cloud never prints: it
 * has no printer and the branch makes outbound connections only.
 *
 * The write is bounded by a timeout so a wedged printer cannot hold the till's request open.
 */

export interface RelayResult {
  printed: boolean;
  bytes: number;
  /** The printer host the bytes went to. */
  host: string;
  port: number;
}

export interface RelayOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
}

/** Decode the base64 transport body into raw ESC/POS bytes. */
export function decodeEscPosBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

/**
 * Write the raw bytes to the printer's raw port. Resolves once the socket has flushed the bytes and
 * the printer has acknowledged (or the timeout fires). Rejects with a clear message on any socket
 * error, so the till can fall back to the browser dialog.
 */
export function relayEscPos(bytes: Buffer, options: RelayOptions): Promise<RelayResult> {
  const port = options.port ?? 9100;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return new Promise<RelayResult>((resolve, reject) => {
    let settled = false;
    const socket: Socket = connect({ host: options.host, port });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      finish(() => reject(new Error(`printer ${options.host}:${port} timed out`))),
    );
    socket.on('error', (error: Error) =>
      finish(() => reject(new Error(`printer ${options.host}:${port} error: ${error.message}`))),
    );
    socket.on('connect', () => {
      socket.write(bytes, (error?: Error | null) => {
        if (error) {
          finish(() => reject(new Error(`printer write failed: ${error.message}`)));
          return;
        }
        // The bytes are on the wire; the printer buffers them. Close cleanly.
        finish(() => resolve({ printed: true, bytes: bytes.length, host: options.host, port }));
      });
    });
  });
}

/** Decode a base64 body and relay it. The one call the route handler makes. */
export async function relayEscPosBase64(
  base64: string,
  options: RelayOptions,
): Promise<RelayResult> {
  return relayEscPos(decodeEscPosBase64(base64), options);
}
