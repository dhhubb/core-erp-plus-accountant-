'use client';

import { useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { AsAtToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { money, todayIso, useReport } from '@/verticals/accounting/client';

interface AgingRow {
  contact_id: string;
  contact_name: string;
  current: string;
  days_1_30: string;
  days_31_60: string;
  days_61_90: string;
  over_90: string;
  total: string;
}

interface Response {
  as_of: string;
  rows: AgingRow[];
  totals: AgingRow;
  control_account: string;
  reconciles: boolean;
}

/**
 * Both aging reports share this view; only the endpoint and the control-account label differ. The
 * control account is the ledger balance the aged open items must reconcile with (ADR-0065).
 */
export function AgingReport({
  title,
  current,
  endpoint,
  csvPrefix,
  controlLabel,
}: {
  title: string;
  current: string;
  endpoint: string;
  csvPrefix: string;
  controlLabel: string;
}) {
  const [asOf, setAsOf] = useState(todayIso());
  const query = `as_of=${asOf}`;
  const state = useReport<Response>(`${endpoint}?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>{title}</h1>
      <AccountingNav current={current} />
      <AsAtToolbar
        basePath={endpoint}
        query={query}
        csvFilename={`${csvPrefix}-${asOf}.csv`}
        asOf={asOf}
        onAsOf={setAsOf}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <>
          <table data-testid="aging-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th style={{ textAlign: 'right' }}>Current</th>
                <th style={{ textAlign: 'right' }}>1–30</th>
                <th style={{ textAlign: 'right' }}>31–60</th>
                <th style={{ textAlign: 'right' }}>61–90</th>
                <th style={{ textAlign: 'right' }}>90+</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={row.contact_id} data-testid="aging-row">
                  <td>{row.contact_name}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.current)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.days_1_30)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.days_31_60)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.days_61_90)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.over_90)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="aging-totals">
                <td>
                  <strong>Total</strong>
                </td>
                <td style={{ textAlign: 'right' }}>{money(state.data.totals.current)}</td>
                <td style={{ textAlign: 'right' }}>{money(state.data.totals.days_1_30)}</td>
                <td style={{ textAlign: 'right' }}>{money(state.data.totals.days_31_60)}</td>
                <td style={{ textAlign: 'right' }}>{money(state.data.totals.days_61_90)}</td>
                <td style={{ textAlign: 'right' }}>{money(state.data.totals.over_90)}</td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.totals.total)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
          <p data-testid="aging-reconcile">
            {controlLabel} control account {money(state.data.control_account)} ·{' '}
            {state.data.reconciles ? 'reconciled' : 'does not reconcile'}
          </p>
        </>
      )}
    </main>
  );
}
