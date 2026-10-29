import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy to pulse-api.
 *
 * All frontend API calls go through /api/proxy/... so that the API_KEY
 * never leaves the server. The key is injected here from a server-only
 * env variable (PULSE_API_KEY, without NEXT_PUBLIC_ prefix).
 *
 * Also forwards the session cookie for user authentication.
 */

const BACKEND_BASE = process.env.PULSE_API_BASE || 'http://127.0.0.1:3002';
const API_KEY = process.env.PULSE_API_KEY || '';

// Whitelist of HTTP methods the proxy will forward. Anything else (TRACE,
// CONNECT, OPTIONS with credentials, etc.) is rejected at the edge.
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!ALLOWED_METHODS.has(req.method)) {
    return NextResponse.json(
      { error: 'Method Not Allowed', method: req.method },
      { status: 405, headers: { Allow: Array.from(ALLOWED_METHODS).join(', ') } },
    );
  }

  const { path } = await params;
  // Reject path traversal attempts even though Next.js catch-all routing
  // already normalises "/..", be defensive: '..' / '.' / empty segments.
  if (path.some((seg) => seg === '' || seg === '..' || seg === '.' || seg.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  const backendPath = '/' + path.join('/');
  const url = new URL(backendPath, BACKEND_BASE);

  // Forward query string
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  // Forward body for non-GET methods
  const incomingCt = req.headers.get('content-type') || '';
  const isMultipart = incomingCt.includes('multipart/form-data');

  let body: string | ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      if (isMultipart) {
        body = await req.arrayBuffer();
      } else {
        body = await req.text();
      }
    } catch (e) {
      console.error('Failed to read request body:', e);
    }
  }

  const headers: Record<string, string> = {};

  if (isMultipart) {
    // Forward multipart Content-Type with boundary intact
    headers['Content-Type'] = incomingCt;
  } else if (typeof body === 'string' && body.length > 0) {
    // Force application/json for JSON-like body (fixes text/plain from browser)
    const looksLikeJson = body.trim().startsWith('{') || body.trim().startsWith('[');
    if (looksLikeJson && (!incomingCt || incomingCt.includes('text/plain'))) {
      headers['Content-Type'] = 'application/json';
    } else {
      headers['Content-Type'] = incomingCt || 'application/json';
    }
  } else if (incomingCt && !incomingCt.includes('application/json')) {
    headers['Content-Type'] = incomingCt;
  }
  // If no body and JSON content-type, don't set it — avoids Fastify empty JSON error
  
  // Forward session + refresh + csrf cookies. Session + csrf let the backend
  // authenticate and validate the double-submit CSRF pair; refresh is needed
  // by POST /auth/refresh only but harmless to forward elsewhere.
  const cookieParts: string[] = [];
  const sessionCookie = req.cookies.get('session');
  if (sessionCookie?.value) cookieParts.push(`session=${sessionCookie.value}`);
  const refreshCookie = req.cookies.get('refresh');
  if (refreshCookie?.value) cookieParts.push(`refresh=${refreshCookie.value}`);
  const csrfCookie = req.cookies.get('csrf');
  if (csrfCookie?.value) cookieParts.push(`csrf=${csrfCookie.value}`);
  if (cookieParts.length) headers['Cookie'] = cookieParts.join('; ');

  // Forward CSRF header for double-submit verification (see plugins/csrf.ts).
  const csrfHeader = req.headers.get('x-csrf-token');
  if (csrfHeader) headers['X-CSRF-Token'] = csrfHeader;

  // Forward Authorization header if present
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  // SECURITY: Only inject API key for whitelisted public endpoints (e.g. auth/login).
  // Never inject API key for unauthenticated data requests — this previously
  // allowed full unauthenticated access to all business data.
  const publicPaths = [
    '/auth/login',
    '/auth/register',
    '/auth/refresh',
    '/auth/verify-email',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/reset-with-code',
    '/auth/me',
  ];
  const isPublicPath = publicPaths.includes(backendPath);

  if (!sessionCookie?.value && !authHeader) {
    if (isPublicPath && API_KEY) {
      headers['X-API-Key'] = API_KEY;
    } else if (!isPublicPath) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 },
      );
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900_000); // 15 min for AI audit v3 (3 streaming stages)

    const backendRes = await fetch(url.toString(), {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    // 204 No Content — return empty response (NextResponse doesn't allow body with 204)
    if (backendRes.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const backendCt = backendRes.headers.get('content-type') || 'application/json';

    // SSE / streaming responses: pass the body through as a stream instead of
    // buffering via .text(). Buffering broke AI chat (clients saw a 504 from
    // nginx when the first token took >60s, and even successful streams arrived
    // all at once at the end instead of incrementally).
    if (backendCt.includes('text/event-stream') || backendCt.includes('application/x-ndjson')) {
      const response = new NextResponse(backendRes.body, {
        status: backendRes.status,
        statusText: backendRes.statusText,
        headers: {
          'Content-Type': backendCt,
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
      const setCookies = backendRes.headers.getSetCookie?.() ?? [];
      for (const cookie of setCookies) response.headers.append('Set-Cookie', cookie);
      return response;
    }

    const data = await backendRes.text();

    // Create response with proper headers
    const response = new NextResponse(data, {
      status: backendRes.status,
      statusText: backendRes.statusText,
      headers: {
        'Content-Type': backendCt,
        'Cache-Control': 'no-store',
      },
    });

    // Forward Set-Cookie headers from backend (for login/logout)
    // Use getSetCookie() to handle multiple Set-Cookie headers correctly
    const setCookies = backendRes.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      response.headers.append('Set-Cookie', cookie);
    }
    // Fallback for environments without getSetCookie
    if (setCookies.length === 0) {
      const sc = backendRes.headers.get('set-cookie');
      if (sc) response.headers.set('Set-Cookie', sc);
    }

    return response;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? 'Backend request timed out (180s)'
      : err instanceof Error
        ? err.message
        : 'Backend unavailable';
    return NextResponse.json(
      { error: 'Proxy error', message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
