'use client';

import { useEffect, useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { accountingGet, currentMonth, money, useReport } from '@/verticals/accounting/client';

interface JournalRow {
  journal_id: string;
  posting_date: string;
  source_type: string;
  source_id: string | null;
  memo: string | null;
  currency: string;
  reversal_of: string | null;
  line_count: number;
  total_debit: string;
  created_at: string;
}

interface JournalPage {
  period: { from: string; to: string };
  rows: JournalRow[];
  next_cursor: { after_created_at: string; after_id: string } | null;
}

interface JournalLine {
  line_no: number;
  account_code: string;
  account_name: string;
  description: string | null;
  debit: string;
  credit: string;
}

interface JournalDetail {
  journal: { memo: string | null; source_type: string; posting_date: string; total_debit: string };
  lines: JournalLine[];
}

export default function JournalsPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [extra, setExtra] = useState<JournalRow[]>([]);
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const query = `from=${from}&to=${to}`;
  const state = useReport<JournalPage>(`/api/accounting/journals?${query}`);

  useEffect(() => {
    setExtra([]);
    setDetail(null);
  }, [state.data]);

  const rows = [...(state.data?.rows ?? []), ...extra];
  const cursor = state.data?.next_cursor ?? null;

  const loadMore = () => {
    if (!cursor) return;
    const params = new URLSearchParams({
      from,
      to,
      after_created_at: cursor.after_created_at,
      after_id: cursor.after_id,
    });
    accountingGet<JournalPage>(`/api/accounting/journals?${params.toString()}`)
      .then((page) => setExtra((current) => [...current, ...page.rows]))
      .catch((error: Error) => setDetailError(error.message));
  };

  const open = (row: JournalRow) => {
    const params = new URLSearchParams({ created_at: row.created_at });
    accountingGet<JournalDetail>(`/api/accounting/journals/${row.journal_id}?${params.toString()}`)
      .then((payload) => {
        setDetail(payload);
        setDetailError(null);
      })
      .catch((error: Error) => setDetailError(error.message));
  };

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Journals</h1>
      <AccountingNav current="/accounting/journals" />
      <ReportToolbar
        basePath="/api/accounting/journals"
        query={query}
        csvFilename={`journals-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error ?? detailError} />
      {state.data && (
        <table data-testid="journals-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th>Memo</th>
              <th>Lines</th>
              <th style={{ textAlign: 'right' }}>Total debit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.journal_id + row.created_at} data-testid="journal-row">
                <td>{row.posting_date}</td>
                <td>{row.source_type}</td>
                <td>{row.memo ?? ''}</td>
                <td>{row.line_count}</td>
                <td style={{ textAlign: 'right' }}>{money(row.total_debit)}</td>
                <td>
                  <button type="button" onClick={() => open(row)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <button type="button" data-testid="journals-load-more" onClick={loadMore}>
          Load more
        </button>
      )}
      {detail && (
        <section data-testid="journal-detail" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 16 }}>
            {detail.journal.source_type} · {detail.journal.posting_date} ·{' '}
            {money(detail.journal.total_debit)}
          </h2>
          <table data-testid="journal-detail-lines">
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Debit</th>
                <th style={{ textAlign: 'right' }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.line_no} data-testid="journal-detail-line">
                  <td>{line.line_no}</td>
                  <td>
                    {line.account_code} {line.account_name}
                  </td>
                  <td>{line.description ?? ''}</td>
                  <td style={{ textAlign: 'right' }}>{money(line.debit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(line.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
