'use client';

import { useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { currentMonth, money, useReport } from '@/verticals/accounting/client';

interface VatRow {
  bucket: string;
  tax_rate: string;
  net: string;
  tax: string;
  gross: string;
}

interface Response {
  period: { from: string; to: string };
  rows: VatRow[];
  output_vat: string;
  input_vat: string;
  net_vat: string;
}

export default function VatReturnPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const query = `from=${from}&to=${to}`;
  const state = useReport<Response>(`/api/accounting/vat-return?${query}`);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>VAT return</h1>
      <AccountingNav current="/accounting/vat-return" />
      <ReportToolbar
        basePath="/api/accounting/vat-return"
        query={query}
        csvFilename={`vat-return-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error} />
      {state.loading && <p>Loading…</p>}
      {state.data && (
        <>
          <table data-testid="vat-return-table">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Rate</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th style={{ textAlign: 'right' }}>VAT</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={`${row.bucket}-${row.tax_rate}`} data-testid="vat-return-row">
                  <td>{row.bucket}</td>
                  <td>{(Number(row.tax_rate) * 100).toFixed(2)}%</td>
                  <td style={{ textAlign: 'right' }}>{money(row.net)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.tax)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.gross)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="vat-output">
                <td colSpan={3}>
                  <strong>Output VAT</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.output_vat)}</strong>
                </td>
                <td />
              </tr>
              <tr data-testid="vat-input">
                <td colSpan={3}>
                  <strong>Input VAT</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.input_vat)}</strong>
                </td>
                <td />
              </tr>
              <tr data-testid="vat-net">
                <td colSpan={3}>
                  <strong>Net VAT payable</strong>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{money(state.data.net_vat)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </main>
  );
}
