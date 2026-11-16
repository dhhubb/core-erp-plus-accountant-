import {
  formatDate,
  formatMoney,
  formatRate,
  type ReceiptData,
} from './receiptData';
import { qrMatrix } from './escpos';

/**
 * The on-screen 58mm thermal receipt (H4).
 *
 * It is EXACTLY 58mm wide, because the browser print path relies on `@page { width: 58mm }` and a
 * slip that is wider than the paper is clipped. It shows, top to bottom: the shop logo and name,
 * the address and VAT number, the receipt number, date and cashier, the lines, the VAT breakdown
 * (exclusive and inclusive at each rate), the totals in USD and ZWG, the fiscal QR code when the
 * device returned one, and the footer.
 *
 * It renders from the same `ReceiptData` the ESC/POS generator consumes, so the screen slip and the
 * printed slip can never disagree.
 */

/** The receipt width. Kept as one constant so the paper width and the layout cannot drift apart. */
export const RECEIPT_WIDTH_MM = 58;

const receiptStyle: React.CSSProperties = {
  width: `${RECEIPT_WIDTH_MM}mm`,
  maxWidth: `${RECEIPT_WIDTH_MM}mm`,
  boxSizing: 'border-box',
  padding: '2mm 1.5mm',
  background: '#fff',
  color: '#000',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '9px',
  lineHeight: 1.35,
};

const center: React.CSSProperties = { textAlign: 'center' };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '2mm' };
const rule: React.CSSProperties = {
  borderTop: '1px dashed #000',
  margin: '1.5mm 0',
};

function QrCode({ data }: { data: string }) {
  const matrix = qrMatrix(data);
  const size = matrix.length;
  const quiet = 2;
  const total = size + quiet * 2;
  return (
    <svg
      data-testid="receipt-qr"
      role="img"
      aria-label="Fiscal QR code"
      width="28mm"
      height="28mm"
      viewBox={`0 0 ${total} ${total}`}
      style={{ display: 'block', margin: '1.5mm auto' }}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={total} height={total} fill="#fff" />
      {matrix.map((row, r) =>
        row.map((dark, c) =>
          dark ? (
            <rect
              key={`${r}-${c}`}
              x={c + quiet}
              y={r + quiet}
              width={1}
              height={1}
              fill="#000"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function Receipt58mm({ data }: { data: ReceiptData }) {
  return (
    <article className="receipt-58" data-testid="receipt-58" style={receiptStyle}>
      <header style={center}>
        {data.shop.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            data-testid="receipt-logo"
            src={data.shop.logoUrl}
            alt={data.shop.name}
            style={{ maxWidth: '30mm', maxHeight: '12mm', margin: '0 auto' }}
          />
        ) : (
          <div data-testid="receipt-logo" style={{ fontWeight: 700, letterSpacing: '1px' }}>
            {data.shop.logoText}
          </div>
        )}
        <div data-testid="receipt-shop" style={{ fontWeight: 700, fontSize: '11px' }}>
          {data.shop.name}
        </div>
        {data.shop.addressLines.map((line) => (
          <div key={line} data-testid="receipt-address">
            {line}
          </div>
        ))}
        <div data-testid="receipt-vat-number">{data.shop.vatNumber}</div>
        <div data-testid="receipt-tax-invoice">Tax invoice {data.invoiceNo}</div>
      </header>

      <div style={rule} />

      <div style={row}>
        <span>Receipt</span>
        <span data-testid="receipt-number">{data.receiptNumber}</span>
      </div>
      <div style={row}>
        <span>Invoice</span>
        <span data-testid="receipt-invoice">{data.invoiceNo}</span>
      </div>
      <div style={row}>
        <span>Date</span>
        <span data-testid="receipt-date">{formatDate(data.date)}</span>
      </div>
      <div style={row}>
        <span>Cashier</span>
        <span data-testid="receipt-cashier">{data.cashier}</span>
      </div>

      <div style={rule} />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {data.lines.map((line, index) => (
            <tr key={`${line.description}-${index}`} data-testid="receipt-line">
              <td style={{ padding: 0 }} colSpan={2}>
                {line.description}
              </td>
            </tr>
          ))}
          {data.lines.map((line, index) => (
            <tr key={`qty-${index}`}>
              <td style={{ padding: 0 }}>
                {line.qty.toString()} x {formatMoney(line.unitPrice)}
              </td>
              <td style={{ padding: 0, textAlign: 'right' }}>{formatMoney(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={rule} />

      <div style={row}>
        <span>Subtotal</span>
        <span data-testid="receipt-subtotal">{formatMoney(data.totals.subtotal)}</span>
      </div>

      {data.vatBands.map((band) => (
        <div key={band.rate.toFixed(4)} data-testid="receipt-vat-band">
          <div>VAT {formatRate(band.rate)} (inclusive)</div>
          <div style={row}>
            <span>excl {formatMoney(band.exclusive)}</span>
            <span>tax {formatMoney(band.tax)}</span>
          </div>
          <div style={row}>
            <span>incl</span>
            <span data-testid="receipt-vat-inclusive">{formatMoney(band.inclusive)}</span>
          </div>
        </div>
      ))}

      <div style={{ ...row, fontWeight: 700 }}>
        <span>Total USD</span>
        <span data-testid="receipt-total">{formatMoney(data.totals.total)}</span>
      </div>
      <div style={{ ...row, fontWeight: 700 }}>
        <span>Total ZWG</span>
        <span data-testid="receipt-total-zwg">{formatMoney(data.totals.totalZwg)}</span>
      </div>
      <div style={{ ...row, fontSize: '8px' }}>
        <span>rate (ZWG/USD)</span>
        <span data-testid="receipt-rate">{formatMoney(data.totals.zwgRate)}</span>
      </div>

      <div style={rule} />

      {data.payments.map((payment, index) => (
        <div key={index} data-testid="receipt-payment">
          <div style={row}>
            <span>
              {payment.method} {payment.currency}
            </span>
            <span>{formatMoney(payment.amountTendered)}</span>
          </div>
          {payment.changeGiven.greaterThan(0) && (
            <div style={row}>
              <span>Change</span>
              <span>{formatMoney(payment.changeGiven)}</span>
            </div>
          )}
        </div>
      ))}

      <div style={rule} />

      <div style={center}>
        {data.fiscal.status === 'sent' ? (
          <div data-testid="receipt-fiscal-sent">
            {data.fiscal.receiptNo && <div>Fiscal {data.fiscal.receiptNo}</div>}
            {data.fiscal.signature && <div>Sig {data.fiscal.signature}</div>}
            {data.fiscal.qrCode && <QrCode data={data.fiscal.qrCode} />}
          </div>
        ) : (
          <div data-testid="receipt-fiscal-pending">Fiscal pending</div>
        )}
        <div data-testid="receipt-footer" style={{ marginTop: '1mm' }}>
          {data.footer}
        </div>
      </div>
    </article>
  );
}
