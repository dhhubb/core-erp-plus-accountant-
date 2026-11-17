'use client';

import Link from 'next/link';

/** The accountant console's section links, shared so every page carries the same navigation. */
const LINKS: Array<{ href: string; label: string }> = [
  { href: '/accounting', label: 'Overview' },
  { href: '/accounting/trial-balance', label: 'Trial balance' },
  { href: '/accounting/profit-and-loss', label: 'Profit & loss' },
  { href: '/accounting/balance-sheet', label: 'Balance sheet' },
  { href: '/accounting/changes-in-equity', label: 'Changes in equity' },
  { href: '/accounting/cash-flow', label: 'Cash flow' },
  { href: '/accounting/receivables', label: 'Receivables' },
  { href: '/accounting/payables', label: 'Payables' },
  { href: '/accounting/general-ledger', label: 'General ledger' },
  { href: '/accounting/journals', label: 'Journals' },
  { href: '/accounting/vat-return', label: 'VAT return' },
];

export function AccountingNav({ current }: { current: string }) {
  return (
    <nav style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          style={{ fontWeight: link.href === current ? 700 : 400 }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
