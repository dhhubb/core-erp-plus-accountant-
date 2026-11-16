'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';

/**
 * /admin/pricing-preview — the live price preview.
 *
 * The operator picks a variant (by product then variant), an optional customer group, a time, and a
 * manual discount. The server calls app.get_price and returns the precedence breakdown, so this page
 * shows exactly what the till would charge: 1. price list 2. promotion 3. manual discount, with the
 * role's limit. A discount above the limit is a 422 shown inline.
 */

interface ProductRow {
  id: string;
  sku: string;
  name: string;
}

interface VariantRow {
  id: string;
  sku: string;
  name: string;
}

interface GroupRow {
  id: string;
  name: string;
}

interface PreviewStep {
  step: number;
  name: string;
  detail: string;
  amount: string;
  limit: string | null;
}

interface Preview {
  currency: string;
  list_price: string;
  unit_price: string;
  discount: string;
  source_price_list_name: string | null;
  source_price_list_kind: string | null;
  source_promotion_name: string | null;
  manual_discount: string;
  manual_max_amount: string;
  effective_price: string;
  steps: PreviewStep[];
}

export default function PricingPreviewPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [productId, setProductId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [role, setRole] = useState('');
  const [qty, setQty] = useState('1');
  const [manualDiscount, setManualDiscount] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void adminGet<{ products: ProductRow[] }>('/api/admin/products')
      .then((payload) => setProducts(payload.products))
      .catch((err: Error) => setError(err.message));
    void adminGet<{ customer_groups: GroupRow[] }>('/api/admin/customer-groups')
      .then((payload) => setGroups(payload.customer_groups))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!productId) {
      setVariants([]);
      return;
    }
    void adminGet<{ variants: VariantRow[] }>(`/api/admin/variants?product_id=${productId}`)
      .then((payload) => setVariants(payload.variants))
      .catch((err: Error) => setError(err.message));
  }, [productId]);

  const run = useCallback(async () => {
    setError(null);
    setPreview(null);
    try {
      const payload = await adminPost<Preview>('/api/admin/pricing-preview', {
        variant_id: variantId,
        group_id: groupId || null,
        role: role || null,
        qty,
        manual_discount: manualDiscount || null,
        reason: reason || null,
      });
      setPreview(payload);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [variantId, groupId, role, qty, manualDiscount, reason]);

  return (
    <main style={{ padding: 24, maxWidth: 900 }}>
      <h1>Live price preview</h1>
      <PricingNav current="/admin/pricing-preview" />

      {error && (
        <p role="alert" data-testid="preview-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <section style={{ display: 'grid', gap: 8, margin: '12px 0', maxWidth: 520 }}>
        <label>
          Product
          <select
            aria-label="Product"
            value={productId}
            onChange={(event) => {
              setProductId(event.target.value);
              setVariantId('');
            }}
          >
            <option value="">— choose a product —</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.sku} — {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Variant
          <select aria-label="Variant" value={variantId} onChange={(event) => setVariantId(event.target.value)}>
            <option value="">— choose a variant —</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.sku} — {variant.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Customer group
          <select aria-label="Customer group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">— none —</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <input aria-label="Role" placeholder="e.g. member" value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          Quantity
          <input aria-label="Quantity" value={qty} onChange={(event) => setQty(event.target.value)} />
        </label>
        <label>
          Manual discount
          <input
            aria-label="Manual discount"
            placeholder="amount"
            value={manualDiscount}
            onChange={(event) => setManualDiscount(event.target.value)}
          />
        </label>
        <label>
          Reason
          <input aria-label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button type="button" data-testid="preview-run" disabled={!variantId} onClick={() => void run()}>
          Preview price
        </button>
      </section>

      {preview && (
        <section data-testid="preview-result">
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th align="right">#</th>
                <th align="left">Step</th>
                <th align="left">Detail</th>
                <th align="right">Amount</th>
                <th align="right">Limit</th>
              </tr>
            </thead>
            <tbody>
              {preview.steps.map((step) => (
                <tr key={step.step} data-testid={`step-${step.step}`}>
                  <td align="right">{step.step}</td>
                  <td>{step.name}</td>
                  <td>{step.detail}</td>
                  <td align="right">
                    {step.amount} {preview.currency}
                  </td>
                  <td align="right">{step.limit ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl style={{ marginTop: 16 }}>
            <dt>List price</dt>
            <dd data-testid="list-price">
              {preview.list_price} {preview.currency}
            </dd>
            <dt>After promotions</dt>
            <dd data-testid="unit-price">
              {preview.unit_price} {preview.currency}
            </dd>
            <dt>Manual discount</dt>
            <dd data-testid="manual-discount">
              {preview.manual_discount} {preview.currency} (limit {preview.manual_max_amount})
            </dd>
            <dt>Effective price</dt>
            <dd data-testid="effective-price">
              {preview.effective_price} {preview.currency}
            </dd>
          </dl>
        </section>
      )}
    </main>
  );
}
