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

interface Section {
  amount: string;
  lines: Line[];
}

interface Response {
  period: { from: string; to: string };
  opening_cash: string;
  closing_cash: string;
  net_change: string;
  operating: Section;
  investing: Section;
  financing: Section;
  reconciles: boolean;
}

function SectionRows({ title, section, testId }: { title: string; section: Section; testId: string }) {
  return (
    <>
      <tr>
        <th colSpan={2} style={{ textAlign: 'left', paddingTop: 8 }}>
          {title}
        </th>
      </tr>
      {section.lines.map((line) => (
        <tr key={`${testId}-${line.code}`} data-testid="cf-line">
          <td>
            {line.code} {line.name}
          </td>
          <td style={{ textAlign: 'right' }}>{money(line.amount)}</td>
        </tr>
      ))}
      <tr data-testid={testId}>
        <td>
          <strong>Net cash from {title.toLowerCase()}</strong>
        </td>
        <td style={{ textAlign: 'right' }}>
          <strong>{money(section.amount)}</strong>
        </td>
      </tr>
    </>
  );
}

export default function CashFlowPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const query = `from=${from}&to=${to}`;
  const state = useReport<Response>(`/api/accounting/cash-flow?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Statement of cash flows</h1>
      <AccountingNav current="/accounting/cash-flow" />
      <ReportToolbar
        basePath="/api/accounting/cash-flow"
        query={query}
        csvFilename={`cash-flow-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <>
          <table data-testid="cash-flow-table">
            <tbody>
              <tr>
                <td>Opening cash</td>
                <td style={{ textAlign: 'right' }}>{money(state.data.opening_cash)}</td>
              </tr>
              <SectionRows
                title="Operating activities"
                section={state.data.operating}
                testId="cf-operating"
              />
              <SectionRows
                title="Investing activities"
                section={state.data.investing}
                testId="cf-investing"
              />
              <SectionRows
                title="Financing activities"
                section={state.data.financing}
                testId="cf-financing"
              />
              <tr data-testid="cf-net-change">
                <td>
                  <strong>Net change in cash</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.net_change)}</strong>
                </td>
              </tr>
              <tr data-testid="cf-closing-cash">
                <td>
                  <strong>Closing cash</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.closing_cash)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <p data-testid="cf-reconcile">
            {state.data.reconciles
              ? 'Reconciled: opening cash plus the net change equals closing cash'
              : 'Does not reconcile'}
          </p>
        </>
      )}
    </main>
  );
}
