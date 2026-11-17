'use client';

import Link from 'next/link';
import { AccountingNav } from '@/verticals/accounting/AccountingNav';

/**
 * /accounting — the accountant console's landing page. Each section is one of the financial
 * statements, and every statement reads the same ledger (ADR-0065).
 */

const SECTIONS: Array<{ href: string; title: string; blurb: string }> = [
  {
    href: '/accounting/trial-balance',
    title: 'Trial balance',
    blurb: 'Opening, period debits and credits, and closing for every account.',
  },
  {
    href: '/accounting/profit-and-loss',
    title: 'Profit & loss',
    blurb: 'Revenue, cost of sales, gross profit and net profit for a period.',
  },
  {
    href: '/accounting/balance-sheet',
    title: 'Statement of financial position',
    blurb: 'Assets, liabilities and equity as of a date; assets equal liabilities plus equity.',
  },
  {
    href: '/accounting/changes-in-equity',
    title: 'Statement of changes in equity',
    blurb: 'Opening, movement and closing for each equity account, including the period profit.',
  },
  {
    href: '/accounting/cash-flow',
    title: 'Statement of cash flows',
    blurb: 'Operating, investing and financing cash movements by the indirect method.',
  },
  {
    href: '/accounting/receivables',
    title: 'Accounts receivable',
    blurb: 'Open customer invoices aged into buckets, reconciled with the AR control account.',
  },
  {
    href: '/accounting/payables',
    title: 'Accounts payable',
    blurb: 'Open supplier bills aged into buckets, reconciled with the AP control account.',
  },
  {
    href: '/accounting/general-ledger',
    title: 'General ledger',
    blurb: 'Every posting for one account, with a running balance.',
  },
  {
    href: '/accounting/journals',
    title: 'Journals',
    blurb: 'The immutable journals behind every figure, with their lines.',
  },
  {
    href: '/accounting/vat-return',
    title: 'VAT return',
    blurb: 'Output VAT less input VAT for a period, by rate.',
  },
];

export default function AccountingHomePage() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>The accountant</h1>
      <p style={{ color: '#555', maxWidth: 640 }}>
        Financial and accounting reports, read from the immutable ledger. Every report can be
        exported as CSV.
      </p>
      <AccountingNav current="/accounting" />
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12, maxWidth: 720 }}>
        {SECTIONS.map((section) => (
          <li key={section.href} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <Link href={section.href} style={{ fontWeight: 600 }}>
              {section.title}
            </Link>
            <p style={{ margin: '4px 0 0', color: '#555' }}>{section.blurb}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
