'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The accountant console's shared browser client. It calls the route handlers, never the database.
 * Every figure is a fixed-scale money string, so the page never re-formats money with a float.
 */

export function authHeaders(): HeadersInit {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('pos_access_token') : null;
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export class AccountingApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AccountingApiError';
  }
}

export async function accountingGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders() });
  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new AccountingApiError(response.status, message);
  }
  return payload as T;
}

/** Download a report as a CSV file through the same route (format=csv). */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}format=csv`, { headers: authHeaders() });
  if (!response.ok) {
    throw new AccountingApiError(response.status, `export failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** The current calendar month, as ISO dates, in UTC. */
export function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function money(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = '00'] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export interface ReportState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Load a report path once and whenever it changes. */
export function useReport<T>(path: string): ReportState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    accountingGet<T>(path)
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return useMemo(() => ({ data, error, loading, reload }), [data, error, loading, reload]);
}
