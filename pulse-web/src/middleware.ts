import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authEntryHref } from './lib/authEntry';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/verify-email', // Reachable via email link without session
  '/join', // Team invite links
  '/source',
  '/downloads/',
  '/legal', // Public oferta + privacy policy
  '/landing-v2', // Preview редизайн Sigma в стиле jeen-yuhs — открыт всем (2026-05-31)
  '/landing-v4', // Paper/editorial вариант Sigma — открыт всем (2026-06-01)
  '/portfolio', // Личное портфолио оператора (static HTML в public/portfolio/) — открыт всем
  '/robots.txt', // SEO: должен быть доступен ботам
  '/sitemap.xml', // SEO: должен быть доступен ботам
  '/icon', // Favicon / OG-icon — публичные
  '/favicon', // То же
  '/api',
];

// Превью-роуты редизайна: видны только владельцу аккаунта (user_id=1).
// /landing-v3 — необязательная демонстрационная страница, остаётся приватным.
// /bidder — рекламный биддер, пока в закрытой канареечной обкатке (2026-05-31).
const OWNER_PREVIEW_ROUTES = ['/bidder'];
const OWNER_USER_ID = Number(process.env.OWNER_PREVIEW_USER_ID || '0');

function getUserIdFromSession(session: string | undefined): number | null {
  if (!session) return null;
  const parts = session.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    const sub = Number(payload.sub);
    return Number.isFinite(sub) ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Build a redirect URL using the public host from proxy headers.
 *
 * Why not `new URL(path, request.url)`: when Next.js runs in standalone mode
 * behind nginx, `request.url` is built from the internal listen address
 * (e.g. `http://localhost:3001`). Using it as the base of a redirect produces
 * `Location: https://localhost:3001/auth/login` which the browser cannot
 * resolve, causing a redirect loop on the public domain.
 *
 * We prefer (in order):
 *   1. `x-forwarded-host` — set by nginx if configured.
 *   2. `host` — set by nginx via `proxy_set_header Host $host`.
 *   3. `request.nextUrl.host` — fallback to internal value.
 *
 * Protocol comes from `x-forwarded-proto` (set explicitly by nginx) and
 * defaults to `https` because we only ever serve HTTPS in production.
 */
function buildRedirect(request: NextRequest, path: string): URL {
  const fwdHost = request.headers.get('x-forwarded-host');
  const host = fwdHost ?? request.headers.get('host') ?? request.nextUrl.host;
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return new URL(path, `${proto}://${host}`);
}

/**
 * Middleware for route protection
 *
 * Checks for session cookie presence. Full JWT validation happens server-side
 * when API calls are made. This provides UX-level protection (redirect to login).
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const loginPath = authEntryHref('login', pathname === '/connections/authorize' ? pathname + request.nextUrl.search : null);

  // The root contains the instruction and auth form. Existing sessions go to the cabinet.
  if (pathname === '/' || ['/mcp','/oauth/register','/oauth/token','/oauth/revoke','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(pathname)) {
    return NextResponse.next();
  }

  // Превью редизайна — только для владельца. Чужой увидит 404, как будто
  // страницы не существует (а не «нет прав»).
  if (OWNER_PREVIEW_ROUTES.some((route) => pathname.startsWith(route))) {
    const uid = getUserIdFromSession(request.cookies.get('session')?.value);
    if (uid !== OWNER_USER_ID) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  // Skip public routes
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Check for session cookie and basic JWT format validation
  const session = request.cookies.get('session')?.value;
  if (!session) {
    return NextResponse.redirect(buildRedirect(request, loginPath));
  }

  // Basic JWT format check (three base64 parts separated by dots)
  // Full validation happens server-side
  const parts = session.split('.');
  if (parts.length !== 3) {
    // Invalid JWT format - clear cookie and redirect to login
    const response = NextResponse.redirect(buildRedirect(request, loginPath));
    response.cookies.delete('session');
    return response;
  }

  // Check if token looks expired (decode payload and check exp)
  try {
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      // Token expired - clear and redirect
      const response = NextResponse.redirect(buildRedirect(request, loginPath));
      response.cookies.delete('session');
      return response;
    }
  } catch (e) {
    // Invalid payload - clear and redirect
    console.error('JWT payload parse error:', e);
    const response = NextResponse.redirect(buildRedirect(request, loginPath));
    response.cookies.delete('session');
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
