'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminGet } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/laybys/:id — one layby: the deposit paid, the customer and the reservations (the goods held
 * aside). Read-only; the actions live on the list page so a completion always refreshes the page.
 */

interface LaybyDetail {
  id: string;
  layby_no: string;
  status: string;
  due_date: string;
  currency: string;
  subtotal: string;
  tax_total: string;
  total: string;
  deposit_paid: string;
  cancellation_fee: string;
  invoice_id: string | null;
  is_overdue: boolean;
  created_at: string;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  reservations: Array<{
    id: string;
    product_id: string;
    variant_id: string | null;
    qty: string;
    unit_price: string;
    unit_cost: string;
    status: string;
  }>;
}

export default function LaybyDetailPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<LaybyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await adminGet<LaybyDetail>(`/api/admin/laybys/${params.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ padding: 24, maxWidth: 900 }}>
      <h1>Layby</h1>
      <OpsNav current="/admin/laybys" />
      <p>
        <Link href="/admin/laybys">← All laybys</Link>
      </p>

      {error && (
        <p role="alert" data-testid="layby-detail-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      {detail && (
        <div data-testid="layby-detail">
          <h2>
            {detail.layby_no} — {detail.status}
          </h2>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
            <dt>Customer</dt>
            <dd data-testid="layby-customer">{detail.customer?.name ?? '—'}</dd>
            <dt>Due date</dt>
            <dd style={detail.is_overdue ? { color: '#c0392b', fontWeight: 700 } : undefined}>
              {detail.due_date}
              {detail.is_overdue ? ' (overdue)' : ''}
            </dd>
            <dt>Subtotal</dt>
            <dd>{detail.subtotal}</dd>
            <dt>VAT</dt>
            <dd>{detail.tax_total}</dd>
            <dt>Total</dt>
            <dd>
              {detail.total} {detail.currency}
            </dd>
            <dt>Deposit paid</dt>
            <dd data-testid="layby-deposit">{detail.deposit_paid}</dd>
            <dt>Cancellation fee</dt>
            <dd>{detail.cancellation_fee}</dd>
            <dt>Invoice</dt>
            <dd>{detail.invoice_id ?? '—'}</dd>
          </dl>

          <h3>Reservations</h3>
          <table
            data-testid="layby-reservations"
            style={{ borderCollapse: 'collapse', width: '100%' }}
          >
            <thead>
              <tr>
                <th align="left">Product</th>
                <th align="right">Qty</th>
                <th align="right">Unit price</th>
                <th align="right">Unit cost</th>
                <th align="left">Status</th>
              </tr>
            </thead>
            <tbody>
              {detail.reservations.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.variant_id ?? row.product_id}</code>
                  </td>
                  <td align="right">{row.qty}</td>
                  <td align="right">{row.unit_price}</td>
                  <td align="right">{row.unit_cost}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
