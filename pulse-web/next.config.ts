import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Existing enforced CSP. `'unsafe-inline'` for script-src is the open question;
// removing it would break Next 15's inlined bootstrap until a nonce migration
// is in place. Until then this header stays as-is.
const cspEnforced = (process.env.NODE_ENV === 'production'
  ? [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.wildberries.ru https://advert-api.wb.ru https://*.sentry.io",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ]
  : [
      // Dev: Next.js HMR requires unsafe-eval. Never applied in production.
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data:",
      "connect-src 'self' http://localhost:* https://*.wildberries.ru https://advert-api.wb.ru https://*.sentry.io",
      "frame-ancestors 'none'",
    ]
).join('; ');

// Phase-5 prep: a STRICT policy without `'unsafe-inline'` for script-src,
// sent as Report-Only. Browser logs violations to DevTools console but
// does NOT block — so we can audit what would break before flipping the
// switch. When violations drop to known-acceptable (Sentry init, theme
// script), implement nonce middleware and promote this to enforced.
//
// Enable by setting CSP_STRICT_REPORT=1 (default OFF — keeps response
// headers tight in size). report-uri intentionally omitted: with no
// collection endpoint set up yet, console-only is enough for observability.
const cspStrictReport = [
  "default-src 'self'",
  "script-src 'self'",                                 // ← no unsafe-inline (the audit point)
  "style-src 'self' 'unsafe-inline'",                  // styles can stay until next pass
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.wildberries.ru https://advert-api.wb.ru https://*.sentry.io",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'X-Frame-Options',         value: 'DENY' },
  { key: 'X-Content-Type-Options',  value: 'nosniff' },
  { key: 'X-XSS-Protection',        value: '1; mode=block' },
  { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',      value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: cspEnforced },
  ...(process.env.CSP_STRICT_REPORT === '1'
    ? [{ key: 'Content-Security-Policy-Report-Only', value: cspStrictReport }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),

  // One public start page; keep existing links usable without duplicate landings.
  async redirects() {
    return ['/landing-v2', '/landing-v4'].map(source => ({ source, destination: '/', permanent: false }));
  },
  
  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },

  // /portfolio → public/portfolio/index.html (статический сайт-портфолио).
  // Sub-routes (services/cases/projects/about) — обрабатываются client-side через history.pushState,
  // но прямой заход по URL должен возвращать ту же страницу для индексации Google.
  async rewrites() {
    return [
      { source: '/portfolio', destination: '/portfolio/index.html' },
      { source: '/portfolio/cases', destination: '/portfolio/index.html' },
      { source: '/portfolio/projects', destination: '/portfolio/index.html' },
      { source: '/portfolio/about', destination: '/portfolio/index.html' },
      { source: '/portfolio/service/:slug', destination: '/portfolio/index.html' },
      { source: '/portfolio/lead-magnet', destination: '/portfolio/lead-magnet/index.html' },
    ];
  },
  
  // Skip ESLint during build (React 19 has stricter rules)
  eslint: {
    ignoreDuringBuilds: true,
  },
  
  // TypeScript errors abort production builds. Set NEXT_IGNORE_TS_ERRORS=1
  // locally if you need to build with known-bad types; CI should never set it.
  typescript: {
    ignoreBuildErrors: process.env.NEXT_IGNORE_TS_ERRORS === '1',
  },
  
  // Disable Turbopack (uses too much memory on Windows)
  // Remove this when you have 16+ GB RAM available
  experimental: {
    turbo: undefined,
  },
  
  // Hide dev indicators in production
  devIndicators: false,
};

// Sentry configuration
const sentryConfig = {
  // Suppress logs during build
  silent: true,
  
  // Upload source maps to Sentry (requires SENTRY_AUTH_TOKEN)
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  
  // Disable source map upload if no auth token
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  
  // Hide source maps from production
  hideSourceMaps: true,
  
  // Automatically tree-shake Sentry SDK
  disableLogger: true,
};

export default withSentryConfig(nextConfig, sentryConfig);
