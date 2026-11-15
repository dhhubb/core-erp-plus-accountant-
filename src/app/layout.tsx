export const metadata = {
  title: 'ERP Core',
  description: 'Multi-tenant ERP core (Phase 1, backend)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
