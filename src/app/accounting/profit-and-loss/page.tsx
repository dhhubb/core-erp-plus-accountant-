'use client';

import { useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { currentMonth, money, useReport } from '@/verticals/accounting/client';

interface Line {
  code: string;
  name: string;
  amount: string;
}

interface Response {
  period: { from: string; to: string };
  revenue: Line[];
  cost_of_sales: Line[];
  operating_expenses: Line[];
  total_revenue: string;
  total_cost_of_sales: string;
  gross_profit: string;
  total_operating_expenses: string;
  net_profit: string;
}

function Section({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <>
      <tr>
        <th colSpan={2} style={{ textAlign: 'left', paddingTop: 8 }}>
          {title}
        </th>
      </tr>
      {lines.map((line) => (
        <tr key={`${title}-${line.code}`} data-testid="pnl-line">
          <td>
            {line.code} {line.name}
          </td>
          <td style={{ textAlign: 'right' }}>{money(line.amount)}</td>
        </tr>
      ))}
    </>
  );
}

export default function ProfitAndLossPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const query = `from=${from}&to=${to}`;
  const state = useReport<Response>(`/api/accounting/profit-and-loss?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Profit &amp; loss</h1>
      <AccountingNav current="/accounting/profit-and-loss" />
      <ReportToolbar
        basePath="/api/accounting/profit-and-loss"
        query={query}
        csvFilename={`profit-and-loss-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <table data-testid="pnl-table">
          <tbody>
            <Section title="Revenue" lines={state.data.revenue} />
            <tr data-testid="pnl-total-revenue">
              <td>
                <strong>Total revenue</strong>
              </td>
              <td style={{ textAlign: 'right' }}>
                <strong>{money(state.data.total_revenue)}</strong>
              </td>
            </tr>
            <Section title="Cost of sales" lines={state.data.cost_of_sales} />
            <tr data-testid="pnl-gross-profit">
              <td>
                <strong>Gross profit</strong>
              </td>
              <td style={{ textAlign: 'right' }}>
                <strong>{money(state.data.gross_profit)}</strong>
              </td>
            </tr>
            <Section title="Operating expenses" lines={state.data.operating_expenses} />
            <tr data-testid="pnl-net-profit">
              <td>
                <strong>Net profit</strong>
              </td>
              <td style={{ textAlign: 'right' }}>
                <strong>{money(state.data.net_profit)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
