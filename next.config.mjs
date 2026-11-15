/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The Playwright e2e run starts its own dev server (see playwright.config.ts) on a separate dist
  // dir, so it never clashes with a running `npm run dev` and `npm run build` cannot clobber it.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  experimental: {
    serverComponentsExternalPackages: ['pg'],
  },
};

export default nextConfig;
