'use client';

import { useEffect, useMemo, useState } from 'react';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';
import { ReportToolbar, ReportError } from '@/verticals/accounting/ReportToolbar';
import { accountingGet, currentMonth, money, useReport } from '@/verticals/accounting/client';

interface Account {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
}

interface LedgerRow {
  line_id: string;
  posting_date: string;
  created_at: string;
  journal_id: string;
  journal_created_at: string;
  source_type: string;
  journal_memo: string | null;
  description: string | null;
  debit: string;
  credit: string;
  running_balance: string;
}

interface Response {
  account_id: string;
  period: { from: string; to: string };
  opening_balance: string;
  closing_balance: string;
  rows: LedgerRow[];
  next_cursor: { after_date: string; after_created_at: string; after_id: string } | null;
}

export default function GeneralLedgerPage() {
  const defaults = useMemo(currentMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [cursor, setCursor] = useState<Response['next_cursor']>(null);
  const [extra, setExtra] = useState<LedgerRow[]>([]);
  const [cursorError, setCursorError] = useState<string | null>(null);

  useEffect(() => {
    accountingGet<{ accounts: Account[] }>('/api/accounting/accounts')
      .then((payload) => {
        setAccounts(payload.accounts);
        if (!accountId && payload.accounts.length > 0) setAccountId(payload.accounts[0]!.account_id);
      })
      .catch((error: Error) => setCursorError(error.message));
    // Load the account list once; the first account becomes the default selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = `from=${from}&to=${to}&account_id=${accountId}`;
  const state = useReport<Response>(accountId ? `/api/accounting/general-ledger?${query}` : '');

  useEffect(() => {
    setExtra([]);
    setCursor(state.data?.next_cursor ?? null);
  }, [state.data]);

  const loadMore = () => {
    if (!cursor) return;
    const params = new URLSearchParams({
      from,
      to,
      account_id: accountId,
      after_date: cursor.after_date,
      after_created_at: cursor.after_created_at,
      after_id: cursor.after_id,
    });
    accountingGet<Response>(`/api/accounting/general-ledger?${params.toString()}`)
      .then((page) => {
        setExtra((current) => [...current, ...page.rows]);
        setCursor(page.next_cursor);
      })
      .catch((error: Error) => setCursorError(error.message));
  };

  const rows = [...(state.data?.rows ?? []), ...extra];

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>General ledger</h1>
      <AccountingNav current="/accounting/general-ledger" />
      <label style={{ display: 'block', marginBottom: 12 }}>
        Account{' '}
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.account_id} value={account.account_id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
      </label>
      <ReportToolbar
        basePath="/api/accounting/general-ledger"
        query={query}
        csvFilename={`general-ledger-${from}-to-${to}.csv`}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
      />
      <ReportError message={state.error ?? cursorError} />
      {state.data && (
        <>
          <p data-testid="gl-balances">
            Opening {money(state.data.opening_balance)} · Closing {money(state.data.closing_balance)}
          </p>
          <table data-testid="gl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Debit</th>
                <th style={{ textAlign: 'right' }}>Credit</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.line_id} data-testid="gl-row">
                  <td>{row.posting_date}</td>
                  <td>{row.source_type}</td>
                  <td>{row.description ?? row.journal_memo ?? ''}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.debit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.credit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(row.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <button type="button" data-testid="gl-load-more" onClick={loadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </main>
  );
}
