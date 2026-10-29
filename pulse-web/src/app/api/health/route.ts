/**
 * GET /api/health
 *
 * F-004: public, auth-free liveness probe for load balancers / uptime monitors.
 * Proxies `/health` on the pulse-api backend so a single TCP-reachable URL
 * confirms both the Next.js frontend AND the upstream API are alive. Does
 * NOT forward cookies — same-origin /api/proxy/* still requires the session
 * pair, this endpoint is intentionally open.
 *
 * Response shape mirrors pulse-api: `{ ok, timestamp, uptime, version }`.
 * Returns 503 if the backend doesn't respond (so monitors page on it).
 */

import { NextResponse } from 'next/server';

const BACKEND_BASE = process.env.PULSE_API_BASE || 'http://127.0.0.1:3000';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await fetch(`${BACKEND_BASE}/health`, {
      // Don't cache — health responses change every second.
      cache: 'no-store',
      // Short timeout: a slow backend should surface as unhealthy, not stall the LB.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `backend ${res.status}` },
        { status: 503 },
      );
    }
    const body = await res.json();
    return NextResponse.json(body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
