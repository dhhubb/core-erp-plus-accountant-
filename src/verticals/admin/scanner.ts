/**
 * The USB-wedge barcode scanner detector.
 *
 * A wedge scanner types a barcode as a fast burst of keystrokes and ends with Enter. A human types
 * slowly. This detector tells the two apart: it buffers a burst while the gap between keys stays
 * under `gapMs`, and `onEnter` returns the whole burst when it is long enough to be a scan.
 *
 * It is a plain class, with the clock injected, so it can be unit-tested without a DOM.
 */
export interface WedgeDetectorOptions {
  /** The maximum gap between two keys of one scan, in milliseconds. */
  gapMs?: number;
  /** The shortest burst that counts as a scan. */
  minLength?: number;
  /** The clock, in milliseconds. Defaults to Date.now. */
  now?: () => number;
}

export const WEDGE_DEFAULT_GAP_MS = 50;
export const WEDGE_DEFAULT_MIN_LENGTH = 4;

export class WedgeDetector {
  private readonly gapMs: number;
  private readonly minLength: number;
  private readonly now: () => number;
  private lastKeyAt = 0;
  private buffer = '';

  constructor(options: WedgeDetectorOptions = {}) {
    this.gapMs = options.gapMs ?? WEDGE_DEFAULT_GAP_MS;
    this.minLength = options.minLength ?? WEDGE_DEFAULT_MIN_LENGTH;
    this.now = options.now ?? (() => Date.now());
  }

  /** Feed one printable key. Returns true when the key was part of a fast burst. */
  key(char: string): boolean {
    const at = this.now();
    const fast = at - this.lastKeyAt <= this.gapMs;
    this.lastKeyAt = at;
    if (fast) this.buffer += char;
    else this.buffer = char;
    return fast;
  }

  /**
   * The Enter key. Returns the buffered burst when it is long enough to be a scan, otherwise the
   * caller's own text (a manual entry). Always resets the buffer.
   */
  enter(fallback: string): string {
    const scanned = this.buffer.length >= this.minLength ? this.buffer : fallback;
    this.buffer = '';
    return scanned;
  }

  reset(): void {
    this.buffer = '';
    this.lastKeyAt = 0;
  }
}
