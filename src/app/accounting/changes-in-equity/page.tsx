'use client';

import { useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { currentMonth, money, useReport } from '@/verticals/accounting/client';

interface Row {
  kind: string;
  code: string | null;
  name: string | null;
  opening: string;
  movement: string;
  closing: string;
}

interface Response {
  period: { from: string; to: string };
  rows: Row[];
  opening_equity: string;
  profit_for_period: string;
  other_movements: string;
  closing_equity: string;
}

function label(row: Row): string {
  if (row.kind === 'profit_for_period') return 'Profit for the period';
  if (row.code && row.name) return `${row.code} ${row.name}`;
  return row.name ?? 'Equity';
}

export default function ChangesInEquityPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const query = `from=${from}&to=${to}`;
  const state = useReport<Response>(`/api/accounting/changes-in-equity?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Statement of changes in equity</h1>
      <AccountingNav current="/accounting/changes-in-equity" />
      <ReportToolbar
        basePath="/api/accounting/changes-in-equity"
        query={query}
        csvFilename={`changes-in-equity-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <table data-testid="equity-table">
          <thead>
            <tr>
              <th>Equity</th>
              <th style={{ textAlign: 'right' }}>Opening</th>
              <th style={{ textAlign: 'right' }}>Movement</th>
              <th style={{ textAlign: 'right' }}>Closing</th>
            </tr>
          </thead>
          <tbody>
            {state.data.rows.map((row) => (
              <tr key={row.kind + (row.code ?? '')} data-testid="equity-row">
                <td>{label(row)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.opening)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.movement)}</td>
                <td style={{ textAlign: 'right' }}>{money(row.closing)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="equity-closing">
              <td>
                <strong>Closing equity</strong>
              </td>
              <td style={{ textAlign: 'right' }}>{money(state.data.opening_equity)}</td>
              <td style={{ textAlign: 'right' }}>{money(state.data.profit_for_period)}</td>
              <td style={{ textAlign: 'right' }}>
                <strong>{money(state.data.closing_equity)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </main>
  );
}
