'use client';

import { AgingReport } from '@/verticals/accounting/AgingReport';

export default function ReceivablesPage() {
  return (
    <AgingReport
      title="Accounts receivable"
      current="/accounting/receivables"
      endpoint="/api/accounting/ar-aging"
      csvPrefix="ar-aging"
      controlLabel="AR"
    />
  );
}
