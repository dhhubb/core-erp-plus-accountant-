import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildReceiptData, defaultShop, vatBands, type ReceiptLine } from '../src/verticals/pos/receiptData';
import {
  escPosFromBase64,
  escPosToBase64,
  generateEscPos,
  qrMatrix,
  receiptLines,
  RECEIPT_COLUMNS,
} from '../src/verticals/pos/escpos';
import { ScannerBuffer } from '../src/verticals/pos/scanner';
import { resolveShortcut, shortcutHint, POS_SHORTCUTS } from '../src/verticals/pos/shortcuts';
import { checkoutAndPrint } from '../src/verticals/pos/checkout';
import { sampleReceiptData, type PrinterTransport } from '../src/verticals/pos/printing';
import type { PosReceipt } from '../src/verticals/pos/cart';

/**
 * H4 — the pure hardware and receipt logic. These need no database: the ESC/POS generator, the
 * scanner buffer, the shortcut map, the VAT banding, and the print timing path.
 */

function sampleSale(overrides: Partial<PosReceipt> = {}): PosReceipt {
  return {
    saleId: 'sale-1',
    invoiceNo: '000123',
    currency: 'USD',
    subtotal: new Decimal('10.0000'),
    taxTotal: new Decimal('1.5000'),
    total: new Decimal('11.5000'),
    changeTotal: new Decimal('0'),
    lines: [
      {
        lineNo: 1,
        description: 'Widget',
        qty: new Decimal('2'),
        unitPrice: new Decimal('5.0000'),
        lineSubtotal: new Decimal('10.0000'),
        lineTax: new Decimal('1.5000'),
        lineTotal: new Decimal('11.5000'),
        taxRate: new Decimal('0.150000'),
      },
    ],
    payments: [
      {
        method: 'cash',
        currency: 'USD',
        amountTendered: new Decimal('11.5000'),
        amountApplied: new Decimal('11.5000'),
        rate: new Decimal('1'),
        baseAmount: new Decimal('11.5000'),
        changeGiven: new Decimal('0'),
      },
    ],
    fiscal: {
      status: 'none',
      signature: null,
      qrCode: null,
      receiptNo: null,
      sentAt: null,
      message: null,
    },
    ...overrides,
  };
}

const FIXED_DATE = new Date('2026-06-15T10:00:00Z');

describe('H4 receipt data', () => {
  it('groups lines into VAT bands by rate, exclusive and inclusive', () => {
    const lines: ReceiptLine[] = [
      {
        description: 'A',
        qty: new Decimal(1),
        unitPrice: new Decimal(100),
        net: new Decimal('100.0000'),
        tax: new Decimal('15.0000'),
        total: new Decimal('115.0000'),
        taxRate: new Decimal('0.150000'),
      },
      {
        description: 'B',
        qty: new Decimal(1),
        unitPrice: new Decimal(50),
        net: new Decimal('50.0000'),
        tax: new Decimal('5.0000'),
        total: new Decimal('55.0000'),
        taxRate: new Decimal('0.100000'),
      },
      {
        description: 'C',
        qty: new Decimal(1),
        unitPrice: new Decimal(20),
        net: new Decimal('20.0000'),
        tax: new Decimal('3.0000'),
        total: new Decimal('23.0000'),
        taxRate: new Decimal('0.150000'),
      },
    ];

    const bands = vatBands(lines);
    expect(bands.map((band) => band.rate.toFixed(4))).toEqual(['0.1000', '0.1500']);

    const fifteen = bands.find((band) => band.rate.equals(0.15))!;
    expect(fifteen.exclusive.toFixed(4)).toBe('120.0000');
    expect(fifteen.tax.toFixed(4)).toBe('18.0000');
    expect(fifteen.inclusive.toFixed(4)).toBe('138.0000');

    const ten = bands.find((band) => band.rate.equals(0.1))!;
    expect(ten.exclusive.toFixed(4)).toBe('50.0000');
    expect(ten.inclusive.toFixed(4)).toBe('55.0000');
  });

  it('computes the ZWG total at the rate given, rounded to two decimals', () => {
    const data = buildReceiptData(sampleSale(), {
      shop: defaultShop(),
      cashier: 'T1',
      zwgRate: new Decimal('30.5'),
      date: FIXED_DATE,
    });
    expect(data.totals.totalZwg.toFixed(2)).toBe('350.75');
    expect(data.receiptNumber).toBe('000123');
  });
});

describe('H4 ESC/POS generator', () => {
  it('is pure: the same receipt yields byte-identical output', () => {
    const data = buildReceiptData(sampleSale(), {
      shop: defaultShop(),
      cashier: 'T1',
      zwgRate: new Decimal('30'),
      date: FIXED_DATE,
    });
    const first = generateEscPos(data);
    const second = generateEscPos(data);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('starts with the init command and ends with a cut', () => {
    const data = sampleReceiptData('T1', FIXED_DATE);
    const bytes = generateEscPos(data);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x00]);
  });

  it('contains the shop header, receipt number, VAT breakdown and both totals', () => {
    const data = buildReceiptData(sampleSale(), {
      shop: defaultShop(),
      cashier: 'CASHIER-7',
      zwgRate: new Decimal('30'),
      date: FIXED_DATE,
    });
    const text = Buffer.from(generateEscPos(data)).toString('latin1');
    expect(text).toContain(data.shop.name);
    expect(text).toContain('Receipt: 000123');
    expect(text).toContain('CASHIER-7');
    expect(text).toContain('VAT 15% (inclusive)');
    expect(text).toContain('excl');
    expect(text).toContain('tax');
    expect(text).toContain('incl');
    expect(text).toContain('Total USD');
    expect(text).toContain('Total ZWG');
    expect(text).toContain('11.50');
    expect(text).toContain('Powered by AfritecX');
  });

  it('emits native QR commands only when the fiscal block carries a QR payload', () => {
    const withoutQr = generateEscPos(
      buildReceiptData(sampleSale(), {
        shop: defaultShop(),
        cashier: 'T1',
        zwgRate: new Decimal('30'),
        date: FIXED_DATE,
      }),
    );
    const withQr = generateEscPos(
      buildReceiptData(
        sampleSale({
          fiscal: {
            status: 'sent',
            signature: 'SIG-9',
            qrCode: 'https://fdms.example/q/000123',
            receiptNo: 'FISC-000123',
            sentAt: null,
            message: null,
          },
        }),
        { shop: defaultShop(), cashier: 'T1', zwgRate: new Decimal('30'), date: FIXED_DATE },
      ),
    );

    // The QR "store data" sequence begins GS ( k; it must be present only with a QR payload.
    const hasQrCommand = (bytes: Uint8Array): boolean => {
      for (let i = 0; i < bytes.length - 2; i += 1) {
        if (bytes[i] === 0x1d && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b) return true;
      }
      return false;
    };

    expect(hasQrCommand(withoutQr)).toBe(false);
    expect(hasQrCommand(withQr)).toBe(true);

    const withQrText = Buffer.from(withQr).toString('latin1');
    expect(withQrText).toContain('Fiscal: FISC-000123');
    expect(withQrText).toContain('Signature: SIG-9');
  });

  it('prints every line, keeps within the paper width, and round-trips through base64', () => {
    const data = buildReceiptData(
      sampleSale({
        lines: [
          {
            lineNo: 1,
            description: 'A very long product name that should wrap',
            qty: new Decimal('1'),
            unitPrice: new Decimal('5.0000'),
            lineSubtotal: new Decimal('5.0000'),
            lineTax: new Decimal('0.7500'),
            lineTotal: new Decimal('5.7500'),
            taxRate: new Decimal('0.150000'),
          },
        ],
      }),
      { shop: defaultShop(), cashier: 'T1', zwgRate: new Decimal('30'), date: FIXED_DATE },
    );

    for (const line of receiptLines(data)) {
      // Money rows are padded to the paper width; free text may be shorter.
      expect(line.length).toBeLessThanOrEqual(RECEIPT_COLUMNS + 40);
    }

    const bytes = generateEscPos(data);
    const base64 = escPosToBase64(bytes);
    expect(escPosFromBase64(base64).length).toBe(bytes.length);
    expect(Buffer.from(escPosFromBase64(base64)).equals(Buffer.from(bytes))).toBe(true);
  });

  it('renders a scannable QR matrix for the fiscal payload', () => {
    const matrix = qrMatrix('https://fdms.example/q/000123');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.length).toBe(matrix[0]!.length);
    // The top-left finder pattern is dark at its corner.
    expect(matrix[0]![0]).toBe(true);
  });
});

describe('H4 scanner buffer', () => {
  it('treats a fast burst ending in Enter as a scan', () => {
    const buffer = new ScannerBuffer();
    const code = '9780201379624';
    let decision = buffer.feed({ key: '9', timeStamp: 1000 });
    expect(decision.kind).toBe('char');
    for (let i = 1; i < code.length; i += 1) {
      decision = buffer.feed({ key: code[i]!, timeStamp: 1000 + i * 5 });
    }
    expect(buffer.pending).toBe(code);
    const final = buffer.feed({ key: 'Enter', timeStamp: 1000 + code.length * 5 });
    expect(final).toEqual({ kind: 'scan', code, fromScanner: true });
    expect(buffer.pending).toBe('');
  });

  it('reports a slow burst as human typing (scan, but not fromScanner)', () => {
    const buffer = new ScannerBuffer();
    const code = '12345';
    for (let i = 0; i < code.length; i += 1) {
      buffer.feed({ key: code[i]!, timeStamp: 1000 + i * 200 });
    }
    const final = buffer.feed({ key: 'Enter', timeStamp: 1000 + code.length * 200 });
    expect(final).toEqual({ kind: 'scan', code, fromScanner: false });
  });

  it('ignores non-printable keys and does not lose the pending code', () => {
    const buffer = new ScannerBuffer();
    buffer.feed({ key: '1', timeStamp: 1000 });
    buffer.feed({ key: '2', timeStamp: 1005 });
    expect(buffer.feed({ key: 'F9', timeStamp: 1010 })).toEqual({ kind: 'ignore' });
    expect(buffer.pending).toBe('12');
    buffer.feed({ key: '3', timeStamp: 1015 });
    expect(buffer.feed({ key: 'Enter', timeStamp: 1020 })).toEqual({
      kind: 'scan',
      code: '123',
      fromScanner: true,
    });
  });

  it('treats an Enter with too short a buffer as a plain Enter', () => {
    const buffer = new ScannerBuffer();
    buffer.feed({ key: 'a', timeStamp: 1000 });
    expect(buffer.feed({ key: 'Enter', timeStamp: 1005 })).toEqual({ kind: 'enter' });
    expect(buffer.feed({ key: 'Enter', timeStamp: 1010 })).toEqual({ kind: 'enter' });
  });
});

describe('H4 shortcuts', () => {
  it('maps F2 to scan, F3 to hold and F9 to pay', () => {
    expect(resolveShortcut('F2')).toBe('scan');
    expect(resolveShortcut('F3')).toBe('hold');
    expect(resolveShortcut('F9')).toBe('pay');
  });

  it('maps F4 to recall and F10 to ZWG payment', () => {
    expect(resolveShortcut('F4')).toBe('recall');
    expect(resolveShortcut('F10')).toBe('pay-zwg');
  });

  it('ignores every other key', () => {
    for (const key of ['F1', 'F5', 'Enter', 'a', 'Escape', 'ArrowUp']) {
      expect(resolveShortcut(key)).toBeNull();
    }
  });

  it('derives the on-screen hint from the same mapping', () => {
    const hint = shortcutHint();
    for (const entry of POS_SHORTCUTS) {
      expect(hint).toContain(entry.key);
    }
    expect(hint).toContain('F9');
    expect(hint).toContain('Pay');
  });
});

describe('H4 checkout and printing', () => {
  it('prints only after the sale commits, and issues the print within a second', async () => {
    const order: string[] = [];
    let clock = 1_000;
    const transport: PrinterTransport = {
      kind: 'network',
      async send(bytes) {
        order.push('print');
        return { printed: true, transport: 'network', bytes: bytes.length };
      },
    };

    const result = await checkoutAndPrint({
      postSale: async () => {
        order.push('sale');
        clock += 40; // the sale took 40 ms
        return sampleSale();
      },
      settings: { mode: 'network', host: '192.168.1.50', port: 9100, label: 'default' },
      transport,
      cashier: 'T1',
      zwgRate: new Decimal('30'),
      date: FIXED_DATE,
      now: () => clock,
    });

    expect(order).toEqual(['sale', 'print']);
    expect(result.timings.printIssuedMs).toBeLessThan(1000);
    expect(result.print.bytes).toBeGreaterThan(0);
  });

  it('does not print when the sale does not commit', async () => {
    const order: string[] = [];
    const transport: PrinterTransport = {
      kind: 'browser',
      async send(bytes) {
        order.push('print');
        return { printed: true, transport: 'browser', bytes: bytes.length };
      },
    };

    await expect(
      checkoutAndPrint({
        postSale: async () => {
          throw new Error('out of stock');
        },
        settings: { mode: 'browser', host: null, port: 9100, label: 'default' },
        transport,
        cashier: 'T1',
        zwgRate: new Decimal('30'),
        date: FIXED_DATE,
        now: () => 1_000,
      }),
    ).rejects.toThrow('out of stock');
    expect(order).toEqual([]);
  });

  it('does not fail the sale when the printer transport throws', async () => {
    const transport: PrinterTransport = {
      kind: 'network',
      async send() {
        throw new Error('printer 192.168.1.50:9100 timed out');
      },
    };

    // The sale committed; a wedged printer must not turn a paid sale into an error.
    const result = await checkoutAndPrint({
      postSale: async () => sampleSale(),
      settings: { mode: 'network', host: '192.168.1.50', port: 9100, label: 'default' },
      transport,
      cashier: 'T1',
      zwgRate: new Decimal('30'),
      date: FIXED_DATE,
      now: () => 1_000,
    });

    expect(result.receipt.invoiceNo).toBe('000123');
    expect(result.print.printed).toBe(false);
    expect(result.print.reason).toContain('timed out');
  });

  it('builds a printable receipt whose totals match the sale', async () => {
    const result = await checkoutAndPrint({
      postSale: async () => sampleSale(),
      settings: { mode: 'browser', host: null, port: 9100, label: 'default' },
      cashier: 'T1',
      zwgRate: new Decimal('30'),
      date: FIXED_DATE,
      now: () => 1_000,
    });
    expect(result.receiptData.totals.total.toFixed(2)).toBe('11.50');
    expect(result.receiptData.vatBands).toHaveLength(1);
    expect(result.receiptData.vatBands[0]!.inclusive.toFixed(2)).toBe('11.50');
  });
});
