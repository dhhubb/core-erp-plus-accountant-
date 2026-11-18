'use client';

import { useState } from 'react';
import { downloadCsv } from '@/verticals/accounting/client';

/**
 * The accountant pages' shared chrome: a period (or as-at) picker, an export button and an error
 * line. Each page keeps its own report body, so a page stays a small, readable component.
 */

export interface Period {
  from: string;
  to: string;
}

export function ReportToolbar({
  basePath,
  query,
  csvFilename,
  from,
  to,
  onFrom,
  onTo,
}: {
  basePath: string;
  query: string;
  csvFilename: string;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label>
          From <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="export-csv"
          onClick={() => {
            downloadCsv(`${basePath}?${query}`, csvFilename).catch((err: Error) =>
              setError(err.message),
            );
          }}
        >
          Export CSV
        </button>
      </div>
      {error && (
        <p data-testid="export-error" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}
    </div>
  );
}

export function AsAtToolbar({
  basePath,
  query,
  csvFilename,
  asOf,
  onAsOf,
}: {
  basePath: string;
  query: string;
  csvFilename: string;
  asOf: string;
  onAsOf: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label>
          As at <input type="date" value={asOf} onChange={(e) => onAsOf(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="export-csv"
          onClick={() => {
            downloadCsv(`${basePath}?${query}`, csvFilename).catch((err: Error) =>
              setError(err.message),
            );
          }}
        >
          Export CSV
        </button>
      </div>
      {error && (
        <p data-testid="export-error" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}
    </div>
  );
}

export function ReportError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p data-testid="report-error" style={{ color: '#b00020' }}>
      {message}
    </p>
  );
}
