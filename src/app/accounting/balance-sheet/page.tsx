'use client';

import { useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { AsAtToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { money, todayIso, useReport } from '@/verticals/accounting/client';

interface Line {
  code: string;
  name: string;
  amount: string;
}

interface Response {
  as_of: string;
  assets: { current: Line[]; non_current: Line[]; total: string };
  liabilities: { current: Line[]; non_current: Line[]; total: string };
  equity: { accounts: Line[]; total: string };
  difference: string;
  balanced: boolean;
}

function Lines({ lines, testId }: { lines: Line[]; testId: string }) {
  return (
    <>
      {lines.map((line) => (
        <tr key={`${testId}-${line.code}`} data-testid={testId}>
          <td>
            {line.code} {line.name}
          </td>
          <td style={{ textAlign: 'right' }}>{money(line.amount)}</td>
        </tr>
      ))}
    </>
  );
}

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(todayIso());
  const query = `as_of=${asOf}`;
  const state = useReport<Response>(`/api/accounting/balance-sheet?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Statement of financial position</h1>
      <AccountingNav current="/accounting/balance-sheet" />
      <AsAtToolbar
        basePath="/api/accounting/balance-sheet"
        query={query}
        csvFilename={`balance-sheet-${asOf}.csv`}
        asOf={asOf}
        onAsOf={setAsOf}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <>
          <table data-testid="balance-sheet-table">
            <tbody>
              <tr>
                <th colSpan={2} style={{ textAlign: 'left' }}>
                  Assets
                </th>
              </tr>
              <tr>
                <td colSpan={2} style={{ color: '#666' }}>
                  Current
                </td>
              </tr>
              <Lines lines={state.data.assets.current} testId="bs-asset-line" />
              <tr>
                <td colSpan={2} style={{ color: '#666' }}>
                  Non-current
                </td>
              </tr>
              <Lines lines={state.data.assets.non_current} testId="bs-asset-line" />
              <tr data-testid="bs-total-assets">
                <td>
                  <strong>Total assets</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.assets.total)}</strong>
                </td>
              </tr>
              <tr>
                <th colSpan={2} style={{ textAlign: 'left', paddingTop: 8 }}>
                  Liabilities
                </th>
              </tr>
              <Lines lines={state.data.liabilities.current} testId="bs-liability-line" />
              <Lines lines={state.data.liabilities.non_current} testId="bs-liability-line" />
              <tr data-testid="bs-total-liabilities">
                <td>
                  <strong>Total liabilities</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.liabilities.total)}</strong>
                </td>
              </tr>
              <tr>
                <th colSpan={2} style={{ textAlign: 'left', paddingTop: 8 }}>
                  Equity
                </th>
              </tr>
              <Lines lines={state.data.equity.accounts} testId="bs-equity-line" />
              <tr data-testid="bs-total-equity">
                <td>
                  <strong>Total equity</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.equity.total)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <p data-testid="bs-balance-check">
            {state.data.balanced
              ? 'Balanced: assets equal liabilities plus equity'
              : `Out of balance by ${money(state.data.difference)}`}
          </p>
        </>
      )}
    </main>
  );
}
