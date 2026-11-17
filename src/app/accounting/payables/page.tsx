'use client';

import { AgingReport } from '@/verticals/accounting/AgingReport';

export default function PayablesPage() {
  return (
    <AgingReport
      title="Accounts payable"
      current="/accounting/payables"
      endpoint="/api/accounting/ap-aging"
      csvPrefix="ap-aging"
      controlLabel="AP"
    />
  );
}
