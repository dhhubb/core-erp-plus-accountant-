'use client';

import Decimal from 'decimal.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/verticals/pos/api';
import { enqueueSale, countPending, type OutboxSale } from '@/verticals/pos/outbox';
import { syncOnce } from '@/verticals/pos/sync';
import { RegisterServiceWorker } from '@/branch/RegisterServiceWorker';
import { useBranchHealth, type BranchHealthState } from '@/branch/useBranchHealth';
import {
  cartTotals,
  remainingBase,
  tenderedBase,
  useCart,
  type CartLine,
  type PosReceipt,
} from '@/verticals/pos/cart';

/**
 * The till. Keyboard only: a scanner types the barcode and presses Enter (one action), F9 tenders
 * exact cash, Enter confirms and prints. A one-item exact-cash sale is three actions.
 *
 * The action counter is shown on screen so the flow is observable, and it is what the Playwright
 * keyboard test asserts.
 */

const ZWG_SEED_RATE = new Decimal('30');

interface SearchHit {
  variant_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  barcode: string | null;
  match_type: string;
}

function displayMoney(value: Decimal): string {
  return value.toFixed(2);
}

export default function PosPage() {
  const {
    lines,
    tenders,
    actions,
    status,
    error,
    receipt,
    zwgRate,
    addLine,
    addTender,
    bumpActions,
    setZwgRate,
    setStatus,
    setError,
    setReceipt,
    clear,
  } = useCart();

  const [scan, setScan] = useState('');
  const [tillId, setTillId] = useState('TILL-1');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [taxCode, setTaxCode] = useState('VAT15');
  const [taxRate, setTaxRate] = useState(new Decimal('0.15'));
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The branch's connectivity, polled from the branch rather than read from navigator.onLine.
  // A shop LAN with the internet down shows "cloud offline" even though the browser is "online".
  const health = useBranchHealth();

  const totals = useMemo(() => cartTotals(lines), [lines]);
  const remaining = useMemo(() => remainingBase(lines, tenders, zwgRate), [lines, tenders, zwgRate]);

  /** Exact cash for the remaining balance, in the requested currency. */
  const exactCash = useCallback(
    (currency: 'USD' | 'ZWG'): Decimal =>
      currency === 'USD'
        ? remaining
        : remaining.times(zwgRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    [remaining, zwgRate],
  );

  // Load the terminal context: the open shift, the branch's warehouse and the VAT rate in force.
  // A keyboard-only run never needs to click, so the shift is opened for the till automatically.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const contextRes = await apiFetch(`/api/pos/shifts?till_id=${encodeURIComponent(tillId)}`);
      if (!contextRes.ok) return;
      const context = (await contextRes.json()) as {
        shift_id: string | null;
        warehouse_id: string | null;
        tax_code: string;
        tax_rate: string;
      };
      if (cancelled) return;
      setWarehouseId(context.warehouse_id);
      setTaxCode(context.tax_code);
      setTaxRate(new Decimal(context.tax_rate));
      if (context.shift_id) {
        setShiftId(context.shift_id);
        return;
      }
      const openRes = await apiFetch('/api/pos/shifts', {
        method: 'POST',
        body: JSON.stringify({ till_id: tillId, opening_float: '0' }),
      });
      if (openRes.ok) {
        const opened = (await openRes.json()) as { shift_id: string };
        if (!cancelled) setShiftId(opened.shift_id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tillId]);

  useEffect(() => {
    setZwgRate(ZWG_SEED_RATE);
  }, [setZwgRate]);

  // The offline outbox sync loop. On load, count what survived the reload; then keep trying to
  // drain it. Only one request is ever in flight (syncOnce guards it), and an entry is removed
  // only when the server reports it committed or duplicate.
  const drain = useCallback(async () => {
    setSyncing(true);
    try {
      await syncOnce();
    } finally {
      setSyncing(false);
      setPending(await countPending());
    }
  }, []);

  useEffect(() => {
    void (async () => setPending(await countPending()))();
  }, []);

  useEffect(() => {
    const onOnline = () => void drain();
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => void drain(), 15_000);
    // Try immediately as well, so a backlog left by a previous session drains on load.
    void drain();
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [drain]);

  // The scanner behaves as a keyboard: it types the barcode and sends Enter. Keep focus on the
  // scan field so no mouse is ever needed.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live lookup as the operator types, so an ambiguous barcode can be chosen with the arrow keys.
  useEffect(() => {
    const query = scan.trim();
    if (query === '') {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const response = await apiFetch(`/api/pos/search?q=${encodeURIComponent(query)}`);
      if (!response.ok || cancelled) return;
      const payload = (await response.json()) as { results: SearchHit[] };
      if (!cancelled) {
        setHits(payload.results);
        setSelected(0);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scan]);

  const addHit = useCallback(
    async (hit: SearchHit) => {
      // Resolve the price the same way the sale will, so the till's total (and therefore F9 exact
      // cash) matches the invoice to the cent. The scan itself is still one operator action.
      let unitPrice = new Decimal(0);
      try {
        const response = await apiFetch('/api/pos/price', {
          method: 'POST',
          body: JSON.stringify({ items: [{ variant_id: hit.variant_id, qty: '1.0000' }] }),
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            lines: Array<{ variant_id: string; unit_price: string }>;
          };
          const priced = payload.lines.find((line) => line.variant_id === hit.variant_id);
          if (priced) unitPrice = new Decimal(priced.unit_price);
        }
      } catch {
        /* fall through with a zero price; the sale will still price server-side */
      }

      const lineSubtotal = unitPrice.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const lineTax = lineSubtotal.times(taxRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      addLine({
        variantId: hit.variant_id,
        barcode: hit.barcode,
        name: `${hit.product_name}${hit.variant_name ? ` — ${hit.variant_name}` : ''}`,
        qty: new Decimal(1),
        unitPrice,
        taxRate,
        lineSubtotal,
        lineTax,
        lineTotal: lineSubtotal.plus(lineTax),
      });
      setScan('');
      setHits([]);
    },
    [addLine, taxRate],
  );

  /**
   * A scanner types the barcode and presses Enter in well under the debounce window, so Enter
   * resolves the code immediately rather than waiting for the live lookup. One scan is one action.
   */
  const scanNow = useCallback(
    async (code: string) => {
      const response = await apiFetch(`/api/pos/search?q=${encodeURIComponent(code)}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { results: SearchHit[] };
      const exact = payload.results.find((hit) => hit.barcode === code) ?? payload.results[0];
      if (exact) await addHit(exact);
    },
    [addHit],
  );

  const postSale = useCallback(async () => {
    if (lines.length === 0 || tenders.length === 0) return;
    setStatus('posting');
    setError(null);

    // The id is generated once, here, at sale time. It is the server's idempotency key, so a
    // retry — live, queued or synced — can never ring the sale twice.
    const clientSaleId = crypto.randomUUID();

    const saleBody = {
      warehouse_id: warehouseId,
      shift_id: shiftId,
      client_sale_id: clientSaleId,
      tax_code: taxCode,
      lines: lines.map((line) => ({
        variant_id: line.variantId,
        barcode: line.barcode,
        qty: line.qty.toFixed(4),
        unit_price: line.unitPrice.toFixed(4),
      })),
      tenders: tenders.map((tender) => ({
        method: tender.method,
        currency: tender.currency,
        amount_tendered: tender.amountTendered.toFixed(4),
      })),
    };

    /** The outbox entry, in the exact shape the sync endpoint accepts. */
    const queuedSale: Omit<OutboxSale, 'attempts' | 'nextAttemptAt' | 'lastError'> = {
      clientSaleId,
      shiftId,
      warehouseId: warehouseId ?? '',
      soldAt: new Date().toISOString(),
      currency: 'USD',
      lines: lines.map((line) => ({
        variantId: line.variantId,
        barcode: line.barcode,
        qty: line.qty.toFixed(4),
        unitPrice: line.unitPrice.toFixed(4),
        promotionIds: [],
      })),
      tenders: tenders.map((tender) => ({
        method: tender.method,
        currency: tender.currency,
        amountTendered: tender.amountTendered.toFixed(4),
      })),
    };

    let response: Response;
    try {
      response = await apiFetch('/api/pos/sales', {
        method: 'POST',
        body: JSON.stringify(saleBody),
      });
    } catch {
      // The network is down. The sale is already complete from the customer's point of view, so
      // it goes to the outbox rather than being lost. This is the offline path.
      await enqueueSale(queuedSale);
      setPending(await countPending());
      setStatus('queued');
      return;
    }

    if (!response.ok) {
      // 429 (rate limited) and 5xx are transient: queue and let the sync loop retry. A 4xx like
      // "insufficient stock" is a real refusal the cashier must see, so it is surfaced.
      if (response.status === 429 || response.status >= 500) {
        await enqueueSale(queuedSale);
        setPending(await countPending());
        setStatus('queued');
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setStatus('error');
      setError(payload.error ?? `sale failed (${response.status})`);
      return;
    }

    try {
      const payload = (await response.json()) as {
        sale_id: string;
        invoice_no: string;
        currency: string;
        subtotal: string;
        tax_total: string;
        total: string;
        change_total: string;
        lines: Array<{
          line_no: number;
          description: string | null;
          qty: string;
          unit_price: string;
          line_subtotal: string;
          line_tax: string;
          line_total: string;
          tax_rate: string;
        }>;
        payments: Array<{
          method: string;
          currency: string;
          amount_tendered: string;
          amount_applied: string;
          rate: string;
          base_amount: string;
          change_given: string;
        }>;
      };

      const nextReceipt: PosReceipt = {
        saleId: payload.sale_id,
        invoiceNo: payload.invoice_no,
        currency: payload.currency,
        subtotal: new Decimal(payload.subtotal),
        taxTotal: new Decimal(payload.tax_total),
        total: new Decimal(payload.total),
        changeTotal: new Decimal(payload.change_total),
        lines: payload.lines.map((line) => ({
          lineNo: line.line_no,
          description: line.description,
          qty: new Decimal(line.qty),
          unitPrice: new Decimal(line.unit_price),
          lineSubtotal: new Decimal(line.line_subtotal),
          lineTax: new Decimal(line.line_tax),
          lineTotal: new Decimal(line.line_total),
          taxRate: new Decimal(line.tax_rate),
        })),
        payments: payload.payments.map((payment) => ({
          method: payment.method,
          currency: payment.currency,
          amountTendered: new Decimal(payment.amount_tendered),
          amountApplied: new Decimal(payment.amount_applied),
          rate: new Decimal(payment.rate),
          baseAmount: new Decimal(payment.base_amount),
          changeGiven: new Decimal(payment.change_given),
        })),
      };

      setReceipt(nextReceipt);
      setStatus('paid');
    } catch (caught) {
      setStatus('error');
      setError((caught as Error).message);
    }
  }, [lines, tenders, warehouseId, shiftId, taxCode, setStatus, setError, setReceipt]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // One action per operator key. This counter is the observable proof of the 3-action flow.
      if (event.key === 'F9') {
        event.preventDefault();
        bumpActions();
        if (remaining.greaterThan(0)) {
          addTender({ method: 'cash', currency: 'USD', amountTendered: exactCash('USD') });
        }
        return;
      }

      if (event.key === 'F10') {
        event.preventDefault();
        bumpActions();
        if (remaining.greaterThan(0)) {
          addTender({ method: 'cash', currency: 'ZWG', amountTendered: exactCash('ZWG') });
        }
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        bumpActions();

        // A scan in the field is the first action: the barcode plus Enter adds the item. The code
        // is resolved immediately, because a scanner sends Enter long before the debounce fires.
        if (scan.trim() !== '') {
          const hit = hits.length > 0 ? hits[Math.min(selected, hits.length - 1)] : null;
          if (hit && hits.some((candidate) => candidate.barcode === scan.trim())) {
            void addHit(hit);
          } else {
            void scanNow(scan.trim());
          }
          return;
        }

        if (status === 'paid' || status === 'queued' || status === 'error') {
          clear();
          return;
        }

        // Nothing left to tender: confirm and print.
        if (remaining.isZero() && tenders.length > 0) {
          void postSale();
        }
        return;
      }

      if (event.key === 'ArrowDown' && hits.length > 0) {
        event.preventDefault();
        setSelected((current) => Math.min(current + 1, hits.length - 1));
      }
      if (event.key === 'ArrowUp' && hits.length > 0) {
        event.preventDefault();
        setSelected((current) => Math.max(current - 1, 0));
      }
    },
    [
      scan,
      hits,
      selected,
      remaining,
      tenders.length,
      status,
      addHit,
      scanNow,
      addTender,
      bumpActions,
      clear,
      exactCash,
      postSale,
    ],
  );

  return (
    <main className="pos" onMouseDown={(event) => event.preventDefault()}>
      <style>{POS_STYLES}</style>
      <RegisterServiceWorker />

      <section className="left">
        <h1>POS</h1>
        <CloudBadge health={health} />
        <p className="hint">
          Scan (barcode + Enter) · F9 exact cash · F10 exact ZWG cash · Enter confirm &amp; print
        </p>

        <label className="scan-label">
          Scan
          <input
            ref={inputRef}
            data-testid="scan"
            className="scan"
            value={scan}
            autoFocus
            autoComplete="off"
            onChange={(event) => setScan(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        {hits.length > 0 && (
          <ul className="hits" data-testid="hits">
            {hits.map((hit, index) => (
              <li key={hit.variant_id} className={index === selected ? 'hit selected' : 'hit'}>
                {hit.product_name} {hit.variant_name} · {hit.sku}
              </li>
            ))}
          </ul>
        )}

        <table className="cart" data-testid="cart">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line: CartLine) => (
              <tr key={line.key} data-testid="cart-line">
                <td>{line.name}</td>
                <td>{line.qty.toString()}</td>
                <td>{displayMoney(line.unitPrice)}</td>
                <td>{displayMoney(line.lineTotal)}</td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Cart empty
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="totals">
          <span>Subtotal {displayMoney(totals.subtotal)}</span>
          <span>VAT {displayMoney(totals.taxTotal)}</span>
          <strong data-testid="total">Total {displayMoney(totals.total)}</strong>
          <span data-testid="remaining">Remaining {displayMoney(remaining)}</span>
        </div>

        <div className="tenders" data-testid="tenders">
          {tenders.map((tender, index) => (
            <div key={index}>
              {tender.currency} {tender.method} {displayMoney(tender.amountTendered)}
            </div>
          ))}
        </div>

        <div className="status">
          <span data-testid="actions">Actions {actions}</span>
          <span data-testid="status">{status}</span>
          <span data-testid="pending">Pending {pending}</span>
          {syncing && <span data-testid="syncing">syncing</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </section>

      <section className="right" data-testid="receipt">
        {receipt ? <Receipt receipt={receipt} /> : <p className="hint">No receipt yet.</p>}
      </section>
    </main>
  );
}

/**
 * The branch/cloud status badge. Shown always, because a cashier must know whether the cloud is
 * reachable before they need it. `incompatible` is a warning, not an outage: the branch still sells,
 * but it will not push until the versions match.
 */
function CloudBadge({ health }: { health: BranchHealthState }) {
  if (!health.branchReachable) {
    return (
      <p className="badge badge-down" data-testid="cloud-badge" data-status="branch-down">
        Branch unreachable — sales queue locally
      </p>
    );
  }

  if (health.cloudStatus === 'online') {
    return (
      <p className="badge badge-up" data-testid="cloud-badge" data-status="online">
        Cloud online
      </p>
    );
  }

  if (health.cloudStatus === 'incompatible') {
    return (
      <p className="badge badge-warn" data-testid="cloud-badge" data-status="incompatible">
        Cloud version mismatch (branch {health.protocolVersion}, cloud {health.cloudProtocolVersion})
        — sync paused
      </p>
    );
  }

  return (
    <p className="badge badge-off" data-testid="cloud-badge" data-status="offline">
      Cloud offline — sales queue locally
    </p>
  );
}

function Receipt({ receipt }: { receipt: PosReceipt }) {
  const taxByRate = new Map<string, Decimal>();
  for (const line of receipt.lines) {
    const key = line.taxRate.toFixed(4);
    taxByRate.set(key, (taxByRate.get(key) ?? new Decimal(0)).plus(line.lineTax));
  }

  return (
    <article className="receipt">
      <header>
        <h2>ERP Core</h2>
        <p>Tax invoice {receipt.invoiceNo}</p>
      </header>

      <table>
        <tbody>
          {receipt.lines.map((line) => (
            <tr key={line.lineNo}>
              <td>
                {line.description ?? 'Item'} {line.qty.toString()} × {displayMoney(line.unitPrice)}
              </td>
              <td className="right">{displayMoney(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl>
        <div>
          <dt>Subtotal</dt>
          <dd>{displayMoney(receipt.subtotal)}</dd>
        </div>
        {[...taxByRate.entries()].map(([rate, tax]) => (
          <div key={rate}>
            <dt>VAT {(Number(rate) * 100).toFixed(0)}%</dt>
            <dd>{displayMoney(tax)}</dd>
          </div>
        ))}
        <div>
          <dt>Total</dt>
          <dd data-testid="receipt-total">{displayMoney(receipt.total)}</dd>
        </div>
      </dl>

      <section className="payments">
        {receipt.payments.map((payment, index) => (
          <p key={index}>
            {payment.currency} {payment.method} {displayMoney(payment.amountTendered)}
            {payment.changeGiven.greaterThan(0) && <> · change {displayMoney(payment.changeGiven)}</>}
          </p>
        ))}
      </section>

      <footer>
        <p>Thank you</p>
      </footer>
    </article>
  );
}

/** 58mm thermal receipt. @page sets the paper width; the article is sized to match. */
const POS_STYLES = `
  @page { width: 58mm; margin: 0; }
  :root { color-scheme: light; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pos { display: grid; grid-template-columns: 1fr 58mm; gap: 16px; padding: 12px; }
  .left { min-width: 0; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #555; font-size: 12px; margin: 0 0 10px; }
  .scan-label { display: block; font-size: 12px; color: #555; }
  .scan { width: 100%; font-size: 18px; padding: 8px; }
  .hits { list-style: none; margin: 6px 0; padding: 0; border: 1px solid #ddd; }
  .hit { padding: 6px 8px; font-size: 14px; }
  .hit.selected { background: #eef; }
  .cart { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 14px; }
  .cart th, .cart td { text-align: left; border-bottom: 1px solid #eee; padding: 6px 4px; }
  .cart .empty { color: #888; }
  .totals { display: flex; gap: 16px; font-size: 14px; align-items: baseline; }
  .totals strong { font-size: 18px; }
  .tenders { margin-top: 8px; font-size: 14px; }
  .status { margin-top: 10px; display: flex; gap: 16px; font-size: 13px; color: #444; }
  .error { color: #b00; }
  .badge { display: inline-block; margin: 0 0 8px; padding: 2px 8px; border-radius: 10px;
           font-size: 12px; font-weight: 600; }
  .badge-up { background: #e6f4ea; color: #1a7f37; }
  .badge-off { background: #fdecea; color: #b3261e; }
  .badge-warn { background: #fff4e5; color: #b26a00; }
  .badge-down { background: #eee; color: #555; }
  .right { border-left: 1px dashed #bbb; padding-left: 12px; }
  .receipt { width: 58mm; font-size: 12px; }
  .receipt header, .receipt footer { text-align: center; }
  .receipt h2 { font-size: 14px; margin: 0; }
  .receipt table { width: 100%; border-collapse: collapse; }
  .receipt td { padding: 1px 0; vertical-align: top; }
  .receipt .right { text-align: right; }
  .receipt dl { margin: 6px 0; }
  .receipt dl div { display: flex; justify-content: space-between; }
  .receipt dt, .receipt dd { margin: 0; }
  .receipt .payments { border-top: 1px dashed #999; padding-top: 4px; }
  .receipt .payments p { margin: 2px 0; }
  @media print {
    .left { display: none; }
    .right { border: 0; padding: 0; }
  }
`;
