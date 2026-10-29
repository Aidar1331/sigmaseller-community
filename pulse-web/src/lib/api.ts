import { useAuthStore } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';

const MAX_RETRIES = 3;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read a cookie value from document.cookie. Used for the double-submit
 * CSRF token — the cookie is NOT httpOnly, so we can echo it as
 * X-CSRF-Token on mutating requests.
 */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const target = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trimStart();
    if (trimmed.startsWith(target)) {
      return decodeURIComponent(trimmed.slice(target.length));
    }
  }
  return null;
}

/**
 * Get the X-CSRF-Token header object for raw `fetch()` calls that bypass
 * apiFetch (e.g. SSE streaming, multipart uploads). Returns `{}` when no
 * csrf cookie is present, so spreading it is always safe.
 *
 * Usage:
 *   await fetch(url, { method: 'POST', headers: { ...csrfHeaders(), ... } });
 */
export function csrfHeaders(): Record<string, string> {
  const csrf = readCookie('csrf');
  return csrf ? { 'X-CSRF-Token': csrf } : {};
}

// Single-flight refresh so a burst of 401s only issues one /auth/refresh call.
let refreshInFlight: Promise<boolean> | null = null;
async function refreshAccessTokenOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch('/api/proxy/auth/refresh', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * Refresh-aware wrapper around raw `fetch()` for callers that intentionally
 * bypass apiFetch (SSE streams, multipart uploads, anywhere we need access
 * to the Response object). Retries once on 401 after a single-flight
 * /auth/refresh, then re-issues the request through the supplied builder.
 *
 * Usage:
 *   const res = await fetchWithRefresh(() => fetch('/api/proxy/...', { ... }));
 *
 * The builder must construct a fresh Request each call because Request bodies
 * (especially streams / FormData / AbortSignals) cannot be reused.
 */
export async function fetchWithRefresh(builder: () => Promise<Response>): Promise<Response> {
  const first = await builder();
  if (first.status !== 401) return first;
  const refreshed = await refreshAccessTokenOnce();
  if (!refreshed) return first;
  return builder();
}

/**
 * Wait for Zustand persist hydration to complete (workspaceId loaded from localStorage).
 * Polls every 50ms for up to 2 seconds. Returns the resolved workspaceId or null.
 */
async function waitForWorkspaceId(): Promise<number | null> {
  for (let i = 0; i < 40; i++) { // 40 × 50ms = 2s max
    const wsId = useWorkspaceStore.getState().workspaceId
      ?? useAuthStore.getState().workspaceId;
    if (wsId) return wsId;
    await sleep(50);
  }
  return null;
}

/**
 * Extra options for apiFetch beyond standard RequestInit.
 * - `skipShopId`: do not auto-inject the active shopId query param. Use for cross-workspace
 *   listing endpoints (e.g. `/shops/:wsId`) where the active shop belongs to a different
 *   workspace and would trigger a 403 from the workspace shopId-validation middleware.
 * - `skipWorkspaceId`: do not auto-inject workspaceId query param.
 */
export interface ApiFetchOptions extends RequestInit {
  skipShopId?: boolean;
  skipWorkspaceId?: boolean;
}

/**
 * Frontend API client.
 *
 * All calls go through the Next.js server-side proxy (/api/proxy/...),
 * which injects the API key on the server. No secrets in the browser.
 *
 * Automatically retries on 429 (Rate Limit) with exponential backoff.
 */
export async function apiFetch<T = any>(path: string, init?: ApiFetchOptions): Promise<T> {
  // Strip our custom options so they don't leak into native fetch
  const { skipShopId, skipWorkspaceId, ...fetchInit } = init ?? {};

  const headers: Record<string, string> = {
    ...(fetchInit.headers as Record<string, string> | undefined),
  };

  // Add JWT token if available
  const token = useAuthStore.getState().token;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Auto-set Content-Type for JSON body if not specified
  if (fetchInit.body && typeof fetchInit.body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  // Double-submit CSRF: echo the `csrf` cookie on mutating requests.
  // Backend plugins/csrf.ts rejects missing/mismatched tokens with 403.
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  if (MUTATING_METHODS.has(method) && !headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
    const csrf = readCookie('csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  // Route through server-side proxy — API key is injected there.
  let proxyPath = `/api/proxy${path}`;

  // If path contains a workspaceId placeholder that resolved to a falsy value
  // (null, undefined, NaN, 0) before Zustand finished hydrating, wait and retry.
  // The placeholder may be followed by '/', '?', or end-of-string (e.g. /knowledge/null,
  // /events/0/counts). Without this, the request hits the backend with workspaceId=0
  // and the route's Zod schema (.positive() / .min(1)) returns 500.
  const badWsRegex = /\/(?:null|undefined|NaN|0)(?=\/|\?|$)/;
  if (badWsRegex.test(proxyPath)) {
    const wsId = await waitForWorkspaceId();
    if (wsId) {
      proxyPath = proxyPath.replace(badWsRegex, `/${wsId}`);
    } else {
      throw new Error('Workspace ещё не загружен. Попробуйте обновить страницу.');
    }
  }

  // Resolve workspaceId from stores (workspace store first, auth store fallback)
  const workspaceId = useWorkspaceStore.getState().workspaceId
    ?? useAuthStore.getState().workspaceId;

  // Auto-inject workspaceId as query param if not already in path/query
  if (!skipWorkspaceId && workspaceId && !proxyPath.includes('workspaceId')) {
    const separator = proxyPath.includes('?') ? '&' : '?';
    proxyPath += `${separator}workspaceId=${workspaceId}`;
  }

  // Auto-inject shopId as query param if available and not already in path/query
  const shopId = useWorkspaceStore.getState().shopId;
  if (!skipShopId && shopId && !proxyPath.includes('shopId')) {
    const separator = proxyPath.includes('?') ? '&' : '?';
    proxyPath += `${separator}shopId=${shopId}`;
  }

  // Retry loop for 429 rate limit errors + one silent 401 refresh retry.
  let refreshed = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Re-read CSRF before each attempt: /auth/refresh rotates it, so a
    // retried mutating request needs the fresh value.
    if (MUTATING_METHODS.has(method)) {
      const freshCsrf = readCookie('csrf');
      if (freshCsrf) headers['X-CSRF-Token'] = freshCsrf;
    }

    let res: Response;
    try {
      res = await fetch(proxyPath, {
        ...fetchInit,
        headers,
        cache: 'no-store',
      });
    } catch (err) {
      // Network error (server down, CORS, no internet, aborted request)
      if (!MUTATING_METHODS.has(method) && attempt < MAX_RETRIES) {
        await sleep((attempt + 1) * 2000);
        continue;
      }
      throw new Error('Нет связи с сервером. Проверьте подключение.');
    }

    if (res.status === 429 && !MUTATING_METHODS.has(method) && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30_000)
        : (attempt + 1) * 2000;
      await sleep(waitMs || 2000);
      continue;
    }

    // On 401, try one silent token refresh before surfacing the error.
    // This hides the short 15-minute access-token TTL from end-users.
    //
    // CRITICAL: skip refresh ONLY on auth endpoints that ARE the auth
    // mechanism itself (login/logout/refresh/register). DO retry refresh
    // on /auth/me — it's just an identity check used by WorkspaceGuard on
    // every page mount. Without refresh on /auth/me, an expired 15-min
    // access token triggers immediate logout — the main "вылетает спустя
    // 15 минут" symptom. See incident 2026-05-23.
    const skipAuthRefresh =
      proxyPath.includes('/auth/login') ||
      proxyPath.includes('/auth/logout') ||
      proxyPath.includes('/auth/refresh') ||
      proxyPath.includes('/auth/register');

    if (res.status === 401 && !refreshed && !skipAuthRefresh) {
      refreshed = true;
      const ok = await refreshAccessTokenOnce();
      if (ok) continue; // retry original request with the new session cookie
    }

    // On 403 CSRF (stale cookies after server restart / csrf cookie expired),
    // silently hit /auth/refresh — it's CSRF-exempt and rotates the csrf cookie.
    // Then retry the original mutating request with the fresh token.
    if (res.status === 403 && !refreshed && !skipAuthRefresh) {
      try {
        const text = await res.clone().text();
        if (/csrf/i.test(text)) {
          refreshed = true;
          const ok = await refreshAccessTokenOnce();
          if (ok) continue;
        }
      } catch {
        // fall through to error surface
      }
    }

    if (!res.ok) {
      const text = await res.text();
      let message: string;
      try {
        const json = JSON.parse(text);
        message = json.message || json.error || `Ошибка сервера (${res.status})`;
      } catch (e) {
        console.error('Error response parse failed:', e);
        message = `Ошибка сервера (${res.status})`;
      }

      if (res.status === 401) {
        const auth = useAuthStore.getState();
        if (auth.isAuthenticated) {
          auth.logout();
          if (typeof window !== 'undefined') {
            window.location.href = '/auth/login';
          }
        }
      }

      throw new Error(message);
    }

    if (res.status === 204) return {} as T;
    return res.json();
  }

  // Shouldn't reach here, but just in case
  throw new Error('429 Too Many Requests: Rate limit exceeded after retries');
}
