import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'ERP Core',
  description: 'Multi-tenant ERP core. The branch till is installable and works on the shop LAN.',
  manifest: '/manifest.webmanifest',
  applicationName: 'ERP Core',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'ERP Till' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0b5cff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
