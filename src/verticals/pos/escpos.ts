import QRCode from 'qrcode';
import { formatDate, formatMoney, formatRate, type ReceiptData } from './receiptData';

/**
 * ESC/POS byte generator (H4).
 *
 * `generateEscPos(receiptData)` is a PURE function: the same receipt always produces the same bytes,
 * so it can be asserted against golden bytes and reproduced anywhere. It returns a `Uint8Array` —
 * the raw bytes a thermal printer consumes.
 *
 * The bytes are transported two ways and only two ways:
 *   * base64, when they must survive JSON (the browser -> branch relay call), and
 *   * raw bytes, when the branch relays straight to the printer socket (decision 16).
 * Base64 is a transport encoding, never a storage or interchange format for the printer itself.
 */

/** ESC/POS control codes. */
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CMD_INIT = [ESC, 0x40];
const CMD_ALIGN_LEFT = [ESC, 0x61, 0x00];
const CMD_ALIGN_CENTER = [ESC, 0x61, 0x01];
const CMD_BOLD_ON = [ESC, 0x45, 0x01];
const CMD_BOLD_OFF = [ESC, 0x45, 0x00];
const CMD_SIZE_NORMAL = [GS, 0x21, 0x00];
const CMD_SIZE_DOUBLE = [GS, 0x21, 0x11];
const CMD_CUT = [GS, 0x56, 0x00];

/** 58mm thermal paper holds 32 columns in font A. */
export const RECEIPT_COLUMNS = 32;

/** A growable byte buffer for building the ESC/POS stream. */
class ByteBuilder {
  private bytes: number[] = [];

  raw(values: readonly number[]): this {
    for (const value of values) this.bytes.push(value & 0xff);
    return this;
  }

  /** Append text as bytes. Receipt text is ASCII; anything else is masked to one byte. */
  text(value: string): this {
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0x3f;
      this.bytes.push(code <= 0xff ? code : 0x3f);
    }
    return this;
  }

  line(value = ''): this {
    this.text(value);
    this.bytes.push(LF);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Left/right align a label and an amount across the receipt width. */
function moneyRow(label: string, amount: string, width = RECEIPT_COLUMNS): string {
  const gap = Math.max(1, width - label.length - amount.length);
  return `${label}${' '.repeat(gap)}${amount}`;
}

/** A dashed rule that fills the receipt width. */
function rule(char = '-', width = RECEIPT_COLUMNS): string {
  return char.repeat(width);
}

/**
 * The receipt's printable blocks, independent of any output format. The screen receipt and the
 * ESC/POS bytes are both rendered from this, so they can never disagree about the VAT breakdown or
 * the totals.
 */
export type ReceiptBlock =
  | {
      kind: 'text';
      text: string;
      align: 'left' | 'center';
      bold: boolean;
      size: 'normal' | 'double';
    }
  | { kind: 'rule' }
  | { kind: 'qr'; data: string };

/** Build the receipt's printable blocks from its data. Pure. */
export function receiptBlocks(data: ReceiptData): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];
  const text = (
    value: string,
    options: { align?: 'left' | 'center'; bold?: boolean; size?: 'normal' | 'double' } = {},
  ): void => {
    blocks.push({
      kind: 'text',
      text: value,
      align: options.align ?? 'left',
      bold: options.bold ?? false,
      size: options.size ?? 'normal',
    });
  };

  // Header.
  text(data.shop.logoText, { align: 'center' });
  text(data.shop.name, { align: 'center', bold: true, size: 'double' });
  for (const address of data.shop.addressLines) text(address, { align: 'center' });
  text(data.shop.vatNumber, { align: 'center' });
  blocks.push({ kind: 'rule' });

  // Meta.
  text(`Receipt: ${data.receiptNumber}`);
  text(`Invoice: ${data.invoiceNo}`);
  text(`Date: ${formatDate(data.date)}`);
  text(`Cashier: ${data.cashier}`);
  blocks.push({ kind: 'rule' });

  // Lines.
  for (const line of data.lines) {
    text(line.description);
    text(
      moneyRow(
        `  ${line.qty.toString()} x ${formatMoney(line.unitPrice)}`,
        formatMoney(line.total),
      ),
    );
  }
  blocks.push({ kind: 'rule' });

  // Totals and the VAT breakdown (exclusive and inclusive per rate).
  text(moneyRow('Subtotal', formatMoney(data.totals.subtotal)));
  for (const band of data.vatBands) {
    text(`VAT ${formatRate(band.rate)} (inclusive)`);
    text(moneyRow('  excl', formatMoney(band.exclusive)));
    text(moneyRow('  tax', formatMoney(band.tax)));
    text(moneyRow('  incl', formatMoney(band.inclusive)));
  }
  text(moneyRow('Total USD', formatMoney(data.totals.total)), { bold: true });
  text(moneyRow('Total ZWG', formatMoney(data.totals.totalZwg)), { bold: true });
  text(moneyRow('  @ rate', formatMoney(data.totals.zwgRate)));
  blocks.push({ kind: 'rule' });

  // Payments.
  for (const payment of data.payments) {
    text(
      moneyRow(`${payment.method} ${payment.currency}`, formatMoney(payment.amountTendered)),
    );
    if (payment.changeGiven.greaterThan(0)) {
      text(moneyRow('Change', formatMoney(payment.changeGiven)));
    }
  }
  blocks.push({ kind: 'rule' });

  // Fiscal block: the QR when the device returned one, else "pending".
  if (data.fiscal.status === 'sent') {
    if (data.fiscal.receiptNo) text(`Fiscal: ${data.fiscal.receiptNo}`, { align: 'center' });
    if (data.fiscal.signature) text(`Signature: ${data.fiscal.signature}`, { align: 'center' });
    if (data.fiscal.qrCode) blocks.push({ kind: 'qr', data: data.fiscal.qrCode });
  } else {
    text('Fiscal: pending', { align: 'center' });
  }

  text(data.footer, { align: 'center' });

  return blocks;
}

/** The receipt as plain text lines (no control codes), for the on-screen receipt and tests. */
export function receiptLines(data: ReceiptData): string[] {
  return receiptBlocks(data)
    .filter((block): block is Extract<ReceiptBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text);
}

/** The native ESC/POS commands that draw a QR code from the given data. */
function qrCommands(data: string, moduleSize = 6): number[] {
  const bytes = new TextEncoder().encode(data);
  const len = bytes.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;

  return [
    // Select model 2.
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    // Module size.
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize & 0xff,
    // Error correction level M.
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
    // Store the data in the symbol storage area.
    GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...bytes,
    // Print the stored symbol.
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ];
}

/**
 * Generate the ESC/POS byte stream for a receipt. Pure: no clock, no I/O, no global state. The
 * receipt's `date` is part of the input, so the same input always yields the same bytes.
 */
export function generateEscPos(data: ReceiptData): Uint8Array {
  const out = new ByteBuilder();
  out.raw(CMD_INIT);

  let align: 'left' | 'center' = 'left';
  let bold = false;
  let size: 'normal' | 'double' = 'normal';

  const applyStyle = (next: {
    align: 'left' | 'center';
    bold: boolean;
    size: 'normal' | 'double';
  }): void => {
    if (next.align !== align) {
      out.raw(next.align === 'center' ? CMD_ALIGN_CENTER : CMD_ALIGN_LEFT);
      align = next.align;
    }
    if (next.size !== size) {
      out.raw(next.size === 'double' ? CMD_SIZE_DOUBLE : CMD_SIZE_NORMAL);
      size = next.size;
    }
    if (next.bold !== bold) {
      out.raw(next.bold ? CMD_BOLD_ON : CMD_BOLD_OFF);
      bold = next.bold;
    }
  };

  for (const block of receiptBlocks(data)) {
    if (block.kind === 'rule') {
      applyStyle({ align: 'left', bold: false, size: 'normal' });
      out.line(rule());
      continue;
    }
    if (block.kind === 'qr') {
      out.raw(CMD_ALIGN_CENTER);
      align = 'center';
      out.raw(qrCommands(block.data));
      out.line();
      continue;
    }
    applyStyle({ align: block.align, bold: block.bold, size: block.size });
    out.line(block.text);
  }

  // Reset to normal, feed a little, and cut.
  applyStyle({ align: 'left', bold: false, size: 'normal' });
  out.line();
  out.line();
  out.raw(CMD_CUT);

  return out.build();
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 is the transport encoding for the relay call; the printer still receives raw bytes. */
export function escPosToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    const remaining = bytes.length - i;
    output += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    output += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    output += remaining > 1 ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : '=';
    output += remaining > 2 ? BASE64_ALPHABET[triplet & 0x3f] : '=';
  }
  return output;
}

export function escPosFromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i] ?? 'A');
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1] ?? 'A');
    const c2 = BASE64_ALPHABET.indexOf(clean[i + 2] ?? 'A');
    const c3 = BASE64_ALPHABET.indexOf(clean[i + 3] ?? 'A');
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (byteIndex < length) bytes[byteIndex++] = (triplet >> 16) & 0xff;
    if (byteIndex < length) bytes[byteIndex++] = (triplet >> 8) & 0xff;
    if (byteIndex < length) bytes[byteIndex++] = triplet & 0xff;
  }
  return bytes;
}

/**
 * Render a receipt's fiscal QR payload to a boolean module matrix (true = dark), for the on-screen
 * 58mm receipt. Uses the `qrcode` encoder, so the screen shows a scannable symbol with no network
 * call.
 */
export function qrMatrix(data: string): boolean[][] {
  const symbol = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const size = symbol.modules.size;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) {
      row.push(symbol.modules.data[r * size + c] === 1);
    }
    rows.push(row);
  }
  return rows;
}
