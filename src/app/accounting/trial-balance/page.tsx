'use client';

import { useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { currentMonth, money, useReport } from '@/verticals/accounting/client';

interface TrialBalanceRow {
  code: string;
  name: string;
  account_type: string;
  section: string;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

interface Response {
  period: { from: string; to: string };
  rows: TrialBalanceRow[];
}

export default function TrialBalancePage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [includeZero, setIncludeZero] = useState(false);

  const query = `from=${from}&to=${to}${includeZero ? '&include_zero=1' : ''}`;
  const state = useReport<Response>(`/api/accounting/trial-balance?${query}`);

  const totals = useMemo(() => {
    const rows = state.data?.rows ?? [];
    const sum = (pick: (row: TrialBalanceRow) => string) =>
      rows.reduce((total, row) => total + Number(pick(row)), 0).toFixed(4);
    return {
      opening: sum((row) => row.opening),
      debit: sum((row) => row.debit),
      credit: sum((row) => row.credit),
      closing: sum((row) => row.closing),
    };
  }, [state.data]);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Trial balance</h1>
      <AccountingNav current="/accounting/trial-balance" />
      <ReportToolbar
        basePath="/api/accounting/trial-balance"
        query={query}
        csvFilename={`trial-balance-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <label style={{ display: 'block', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={includeZero}
          onChange={(event) => setIncludeZero(event.target.checked)}
        />{' '}
        Include accounts with no movement
      </label>
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <table data-testid="trial-balance-rows">
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th>Section</th>
              <th style={{ textAlign: 'right' }}>Opening</th>
              <th style={{ textAlign: 'right' }}>Debit</th>
              <th style={{ textAlign: 'right' }}>Credit</th>
              <th style={{ textAlign: 'right' }}>Closing</th>
            </tr>
          </thead>
          <tbody>
            {state.data.rows.map((row) => (
              <tr key={row.code} data-testid="trial-balance-row">
                <td>{row.code}</td>
                <td>{row.name}</td>
                <td>{row.section}</td>
                <td style={{ textAlign: 'right' }}>{money(row.opening)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.debit)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.credit)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.closing)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="trial-balance-totals">
              <td colSpan={3}>Total</td>
              <td style={{ textAlign: 'right' }}>{money(totals.opening)}</td>
              <td style={{ textAlign: 'right' }}>{money(totals.debit)}</td>
              <td style={{ textAlign: 'right' }}>{money(totals.credit)}</td>
              <td style={{ textAlign: 'right' }}>{money(totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </main>
  );
}
