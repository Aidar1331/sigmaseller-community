export type AuthEntryMode = 'register' | 'login';

/** Only the existing MCP consent flow can request a post-auth redirect. */
export function getAuthReturnTo(value: unknown): string | null {
  return typeof value === 'string' && (value === '/connections/authorize' || value.startsWith('/connections/authorize?'))
    ? value : null;
}

export function authEntryHref(mode: AuthEntryMode, returnTo?: unknown): string {
  const query = new URLSearchParams({ mode });
  const safeReturnTo = getAuthReturnTo(returnTo);
  if (safeReturnTo) query.set('returnTo', safeReturnTo);
  return `/?${query}#account`;
}
