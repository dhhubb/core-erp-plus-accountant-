/**
 * Keyboard-wedge barcode scanner support (H4).
 *
 * A keyboard-wedge scanner is a keyboard: it types the barcode characters and then sends Enter. The
 * till reads the keystrokes directly, at the document level, so a scan works no matter which element
 * has focus. The same buffer also serves a human who types a barcode by hand and presses Enter, so
 * there is one code path for both.
 *
 * The module is pure and DOM-agnostic: it classifies a stream of key events. The POS page wires it
 * to real keydown events.
 */

/** The minimum barcode length a burst must reach before Enter submits it. */
export const SCANNER_MIN_LENGTH = 3;

/** A burst typed faster than this average gap (ms/char) is treated as a scanner, not a human. */
export const SCANNER_MAX_AVG_GAP_MS = 50;

export interface KeyEventLike {
  key: string;
  timeStamp: number;
}

export type ScanDecision =
  | { kind: 'ignore' }
  /** A printable character that joined the pending buffer. */
  | { kind: 'char'; value: string }
  /** Enter closed a long-enough buffer; `code` is the barcode. */
  | { kind: 'scan'; code: string; fromScanner: boolean }
  /** Enter with too short a buffer (or an empty one). */
  | { kind: 'enter' };

/**
 * A small state machine that turns a key stream into scan decisions. Feed it every keydown; it
 * reports whether the key is part of a barcode burst, a completed scan, or a plain Enter.
 */
export class ScannerBuffer {
  private buffer = '';
  private firstAt = 0;
  private lastAt = 0;

  constructor(private readonly options: { minLength?: number } = {}) {}

  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.firstAt = 0;
    this.lastAt = 0;
  }

  feed(event: KeyEventLike): ScanDecision {
    const minLength = this.options.minLength ?? SCANNER_MIN_LENGTH;

    if (event.key === 'Enter') {
      const code = this.buffer;
      const chars = code.length;
      const spanMs = chars > 1 ? this.lastAt - this.firstAt : 0;
      const avgGap = chars > 1 ? spanMs / (chars - 1) : Number.POSITIVE_INFINITY;
      const fromScanner = chars >= minLength && avgGap <= SCANNER_MAX_AVG_GAP_MS;
      this.reset();
      if (code.length >= minLength) {
        return { kind: 'scan', code, fromScanner };
      }
      return { kind: 'enter' };
    }

    // A single printable character is a barcode character. Anything else (Shift, F-keys, arrows)
    // is ignored and leaves the buffer intact, so pressing F9 mid-entry never loses the code.
    if (event.key.length !== 1) {
      return { kind: 'ignore' };
    }

    if (this.buffer === '') this.firstAt = event.timeStamp;
    this.buffer += event.key;
    this.lastAt = event.timeStamp;
    return { kind: 'char', value: event.key };
  }
}
