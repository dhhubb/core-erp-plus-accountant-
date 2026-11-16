'use client';

import Link from 'next/link';

/** The pricing console's section links. Shared so every page carries the same navigation. */
const LINKS: Array<{ href: string; label: string }> = [
  { href: '/admin/price-lists', label: 'Price lists' },
  { href: '/admin/customer-groups', label: 'Customer groups' },
  { href: '/admin/promotions', label: 'Promotions' },
  { href: '/admin/pricing-preview', label: 'Live preview' },
];

export function PricingNav({ current }: { current: string }) {
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
