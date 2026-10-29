import { sellerWbKey } from '../../services/sellerWbCredentials.js';
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { eq, and } from 'drizzle-orm';
import { wbRateLimiter, extractDomain } from './wbRateLimiter.js';
import { acquireEndpoint, WbQuotaExceededError } from './wbEndpointBucket.js';
import { recordWbUsage, countEntities } from './wbUsageMeter.js';
import log from '../../lib/logger.js';
import { env } from '../../env.js';

/**
 * Декодированный payload JWT-токена продавца WB. Не проверяем подпись —
 * этого достаточно для классификации типа на нашей стороне до вызова API.
 * Поля по доке WB: `acc` 1=Базовый, 2=Тестовый, 3=Персональный, 4=Сервисный;
 * `for` либо `self` (Персональный) либо `asid:<ID>` (Сервисный); `t=true`
 * для Тестовых; `sid` — seller id; `exp` — Unix timestamp.
 */
export type WbTokenPayload = {
  acc?: 1 | 2 | 3 | 4;
  for?: string | null;
  t?: boolean | null;
  sid?: string | null;
  exp?: number | null;
  id?: string | null;
  asid?: string | null;
};

export type WbTokenKind = 'basic' | 'test' | 'personal' | 'service' | 'unknown';

export type WbTokenInspection = {
  ok: boolean;
  kind: WbTokenKind;
  payload: WbTokenPayload | null;
  /** Если не ok — короткая причина для отображения юзеру (ru). */
  reason?: string;
  /** Только для acc=4 (Сервисный). */
  forAsid?: string | null;
  expired: boolean;
  expiresAt: Date | null;
};

/**
 * Парсит JWT WB-токена и проверяет: формат, тип (acc), срок (exp), соответствие
 * нашему сервису (asid). Используется при подключении нового магазина чтобы
 * НЕ принимать запрещённые правилами WB Персональные токены и чужие Сервисные.
 *
 * НЕ верифицирует подпись — это полномочие самого WB API на каждом запросе.
 * Наша задача — отсечь очевидные неподходящие токены до того, как они
 * полетят в WB и вернут 403.
 */
export function inspectWbToken(token: string): WbTokenInspection {
  const baseFail = (reason: string): WbTokenInspection => ({
    ok: false, kind: 'unknown', payload: null, reason, expired: false, expiresAt: null,
  });
  if (!token || typeof token !== 'string') return baseFail('Пустой токен');
  const parts = token.split('.');
  if (parts.length !== 3) return baseFail('Неверный формат токена (ожидается JWT с тремя частями через точки)');

  let payload: WbTokenPayload;
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    payload = JSON.parse(raw) as WbTokenPayload;
  } catch {
    return baseFail('Не удалось прочитать тело токена');
  }

  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : null;
  const expired = expiresAt !== null && expiresAt.getTime() < Date.now();
  if (expired) {
    return { ok: false, kind: 'unknown', payload, reason: 'Срок действия токена истёк, создайте новый', expired, expiresAt };
  }

  const acc = payload.acc;
  // Базовый — то что мы хотим
  if (acc === 1) {
    return { ok: true, kind: 'basic', payload, expired, expiresAt };
  }
  // Тестовый — можно принять с пометкой
  if (acc === 2 || payload.t === true) {
    return { ok: true, kind: 'test', payload, expired, expiresAt };
  }
  // Персональный — запрещён правилами WB для SaaS
  if (acc === 3 || payload.for === 'self') {
    return {
      ok: false, kind: 'personal', payload, expired, expiresAt,
      reason: 'Это Персональный токен — он запрещён для использования в SaaS. Создайте Базовый токен для SigmaSeller.',
    };
  }
  // Сервисный — только если для нашего сервиса
  if (acc === 4) {
    const forStr = payload.for ?? '';
    const m = /^asid:(.+)$/.exec(forStr);
    const tokenAsid = m?.[1] ?? null;
    // Наш asid тянем из нашего сервисного секрета (тоже JWT, asid в payload).
    const ourAsid = getOurServiceAsid();
    if (ourAsid && tokenAsid && tokenAsid === ourAsid) {
      return { ok: true, kind: 'service', payload, expired, expiresAt, forAsid: tokenAsid };
    }
    return {
      ok: false, kind: 'service', payload, expired, expiresAt, forAsid: tokenAsid,
      reason: 'Этот Сервисный токен выпущен для другого сервиса, а не для SigmaSeller. Создайте новый токен для SigmaSeller.',
    };
  }
  return baseFail(`Неизвестный тип токена (acc=${String(acc ?? 'нет')})`);
}

/**
 * Извлекает наш asid из сервисного секрета (env.WB_PARTNER_SERVICE_SECRET).
 * Кешируется навсегда после первого вызова — секрет меняется только при
 * рестарте процесса (взятие из env).
 */
let cachedOurAsid: string | null | undefined = undefined;
function getOurServiceAsid(): string | null {
  if (cachedOurAsid !== undefined) return cachedOurAsid;
  const secret = env.WB_PARTNER_SERVICE_SECRET;
  if (!secret) { cachedOurAsid = null; return null; }
  const parts = secret.split('.');
  if (parts.length !== 3) { cachedOurAsid = null; return null; }
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const p = JSON.parse(raw) as { asid?: string };
    cachedOurAsid = p.asid ?? null;
  } catch {
    cachedOurAsid = null;
  }
  return cachedOurAsid;
}

/** Дни до истечения нашего сервисного секрета. NaN если секрет не настроен. */
export function daysUntilServiceSecretExpiry(): number {
  const secret = env.WB_PARTNER_SERVICE_SECRET;
  if (!secret) return Number.NaN;
  const parts = secret.split('.');
  if (parts.length !== 3) return Number.NaN;
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const p = JSON.parse(raw) as { exp?: number };
    if (!p.exp) return Number.NaN;
    return Math.floor((p.exp * 1000 - Date.now()) / 86_400_000);
  } catch {
    return Number.NaN;
  }
}

/**
 * Build the canonical pair of WB Partner-API headers.
 *
 *   Authorization: Bearer {seller_token}    — выпустил продавец в своём WB-кабинете
 *   X-Client-Secret: {service_secret}       — наш сервисный JWT, идентифицирует SigmaSeller
 *
 * Сервисный секрет тянется из env.WB_PARTNER_SERVICE_SECRET и подмешивается
 * к каждому запросу. Если он не настроен (локальная разработка, тесты) —
 * заголовок не добавляется и WB понижает лимиты до базовых.
 *
 * `withJson=true` дополнительно ставит `Content-Type: application/json`.
 *
 * Используется в обёртках wbGetJson/wbPostJson/... ниже. Все ОСТАЛЬНЫЕ
 * WB-fetch'и (из feedbacks.ts, advert.ts, content.ts и т.д.) ловятся
 * глобальным interceptor'ом — см. installWbPartnerSecretInterceptor().
 */
export function buildWbHeaders(apiKey: string, withJson = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: apiKey };
  if (shouldInjectSecretForToken(apiKey)) {
    h['X-Client-Secret'] = env.WB_PARTNER_SERVICE_SECRET!;
  }
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Per-request gating: разрешить ли подмешать X-Client-Secret для конкретного
 * токена продавца. Fail-safe: если acc неизвестен или это Personal — НЕТ.
 *
 *   acc=1 (Basic)   → ✅ да, подмешать (расширенные лимиты)
 *   acc=2 (Test)    → ✅ да
 *   acc=4 (Service) → ✅ да, только если asid совпадает с нашим
 *   acc=3 (Personal) → ❌ нет, WB вернёт 403 "X-Client-Secret is not allowed with private token"
 *   acc missing      → ❌ нет (старые токены без acc — трактуем как Personal)
 *   not JWT          → ❌ нет (env-fallback ключи)
 *
 * Эта функция гейтит и buildWbHeaders, и globalThis.fetch interceptor.
 * Гейт включается env-флагом `WB_PARTNER_SECRET_INJECT=1`, иначе всегда false
 * (для отката без перевыпуска секрета).
 */
function shouldInjectSecretForToken(token: string): boolean {
  if ((process.env.WB_PARTNER_SECRET_INJECT ?? '0') !== '1') return false;
  if (!env.WB_PARTNER_SERVICE_SECRET) return false;
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const payload = JSON.parse(raw) as { acc?: number; for?: string };
    if (payload.acc === 1 || payload.acc === 2) return true;
    if (payload.acc === 4) {
      const ourAsid = getOurServiceAsid();
      const m = /^asid:(.+)$/.exec(payload.for ?? '');
      return Boolean(ourAsid && m && m[1] === ourAsid);
    }
    return false; // acc=3 или отсутствует — Personal / unknown
  } catch {
    return false;
  }
}

/**
 * Глобальный fetch-interceptor: ко всем запросам на *.wildberries.ru, в
 * которых уже есть Authorization, дополнительно подмешивается
 * X-Client-Secret из env (если задан). Это страховка от десятков прямых
 * fetch-вызовов из integrations/wb/* мимо wbClient — добавили один раз
 * на старте сервера и все WB-вызовы автоматически идентифицированы.
 *
 * Не-WB fetch'и (Anthropic, Runway, OpenAI и т.д.) не трогаются: фильтр
 * по hostname '.wildberries.ru'. Идемпотентно — если X-Client-Secret уже
 * есть в headers (или secret в env пустой) — interceptor проходит мимо.
 */
let interceptorInstalled = false;
export function installWbPartnerSecretInterceptor(): void {
  if (interceptorInstalled) return;
  const secret = env.WB_PARTNER_SERVICE_SECRET;
  if (!secret) {
    log.warn('WB_PARTNER_SERVICE_SECRET not set — partner API requests will use base limits');
    return;
  }
  // 2026-05-26: ранний rollout сломал sync существующих шопов с Personal-токенами
  // (acc=3). WB отказывает 403 на любой запрос с X-Client-Secret + private token.
  // Декодирование acc на child-процессах работает ненадёжно (spawn+tsx может не
  // подхватить override globalThis.fetch для уже импортированных модулей).
  // Поэтому injection теперь **opt-in** через env: `WB_PARTNER_SECRET_INJECT=1`.
  // При выключенном флаге (default) interceptor ставится в no-op — это
  // совместимо со старыми Personal-токенами. Когда юзеры пересоздадут токены
  // как Базовые — включаем флаг.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    try {
      const url = typeof input === 'string'
        ? input
        : (input as Request).url ?? String(input);
      // Ловим только wildberries.ru-домены. Любая поддоменность (statistics-api,
      // content-api, advert-api, marketplace-api и т.д.) накрывается endsWith.
      const host = new URL(url).hostname;
      if (!host.endsWith('.wildberries.ru') && host !== 'wildberries.ru') {
        return origFetch(input, init);
      }
      // Собираем итоговые headers с учётом исходных. Headers может прийти как
      // Headers instance, plain object или массив пар — нормализуем.
      const merged = new Headers(init?.headers as any);

      // Per-request gating через shouldInjectSecretForToken: декодируем JWT
      // Authorization, разрешаем секрет ТОЛЬКО для acc=1/2 (Basic/Test) и
      // acc=4 с нашим asid. Personal (acc=3), отсутствующий acc, не-JWT —
      // FAIL-SAFE без секрета (иначе WB вернёт 403 "X-Client-Secret is not
      // allowed with private token").
      // Если не сработал env-флаг WB_PARTNER_SECRET_INJECT — функция тоже
      // возвращает false, тогда interceptor проходит без вмешательства.
      const authHeader = merged.get('Authorization') || merged.get('authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token && shouldInjectSecretForToken(token) && !merged.has('X-Client-Secret')) {
        merged.set('X-Client-Secret', secret);
      }

      return origFetch(input, { ...init, headers: merged });
    } catch (err) {
      // Фейл-сейф: если что-то пошло не так с URL-парсингом — фоллбэк к
      // исходному fetch, без сломанного interceptor'а.
      return origFetch(input, init);
    }
  }) as typeof fetch;
  interceptorInstalled = true;
  const injectEnabled = (process.env.WB_PARTNER_SECRET_INJECT ?? '0') === '1';
  log.info({ injectEnabled }, 'WB Partner API: interceptor installed (per-token acc-gated)');
}

// Auto-install при импорте этого модуля. Любой entry-point, который дёргает
// WB API (включая child-процессы wb-adv-to-db, wb-funnel-products-to-db,
// wb-orders-sales-to-db и т.д.), импортирует wbClient — значит interceptor
// поднимется автоматически. Idempotent через interceptorInstalled flag.
try {
  installWbPartnerSecretInterceptor();
} catch (err) {
  log.warn({ err }, 'WB Partner API interceptor auto-install failed (not critical)');
}

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when WB API returns 402 (requires Jam subscription)
 *
 * IMPORTANT: 402 — это ограничение КОНКРЕТНОГО endpoint'а, не всего WB API.
 * Сообщение включает url, чтобы LLM/UI не обобщали «нужна Джем для всего».
 * Например, feedbacks-api/questions/count-unanswered требует Джем; а
 * discounts-prices/api/v2/upload/task — нет. Не путать.
 */
export class WbJamRequiredError extends Error {
  readonly statusCode = 402;
  readonly code = 'WB_JAM_REQUIRED';
  readonly jamUrl = 'https://seller.wildberries.ru/monetization/jam';
  readonly endpoint: string | null;

  constructor(endpoint?: string | null) {
    const ep = endpoint ?? null;
    const where = ep ? ` (endpoint: ${ep})` : '';
    super(
      `WB вернул 402 на конкретном endpoint'е${where} — для ЭТОЙ функции требуется подписка «Джем». ` +
      `Это НЕ значит что весь WB API закрыт: другие endpoint'ы (цены, остатки, заказы) работают без Джема.`,
    );
    this.name = 'WbJamRequiredError';
    this.endpoint = ep;
  }
}

/**
 * Check if error is WbJamRequiredError
 */
export function isJamRequiredError(err: unknown): err is WbJamRequiredError {
  return err instanceof WbJamRequiredError;
}

/**
 * Thrown when WB API returns 401 with a body that signals the seller
 * token is expired / revoked (as opposed to merely malformed). We
 * distinguish this from a generic 401 so the refresh runner can mark
 * the sync run `status='token_expired'` and notify the user to rotate
 * the key once per day — see DECISIONS #51 for the original incident.
 *
 * Matchers are intentionally narrow: WB has historically phrased
 * token-expiry 401s with messages like "access token expired",
 * "Unauthorized", or "token has expired". We match on the substring in
 * the response body, not headers, because WB returns HTTP 401 for
 * several distinct reasons (missing scope, malformed token, etc) and
 * we only want to auto-notify the user about the rotation case.
 */
export class WbTokenExpiredError extends Error {
  readonly statusCode = 401;
  readonly code = 'WB_TOKEN_EXPIRED';

  constructor(
    message = 'WB API access token expired — rotate the key in seller.wildberries.ru',
    readonly originBody?: string,
    readonly endpoint?: string,
    readonly shopId?: number,
  ) {
    super(message);
    this.name = 'WbTokenExpiredError';
  }
}

export function isTokenExpiredError(err: unknown): err is WbTokenExpiredError {
  return err instanceof WbTokenExpiredError;
}

/**
 * Thrown when WB API returns 401/403 because the seller token is valid
 * but lacks the SCOPE required by the endpoint (e.g. token has Финансы
 * scope but caller hits /api/v1/documents/list which needs Документы).
 *
 * Distinct from WbTokenExpiredError because the user remediation is
 * different: don't tell them to rotate the key — they need to regenerate
 * the token with extra scopes selected, OR the operation is simply not
 * authorised for this shop and we should disable the corresponding tool.
 */
export class WbScopeMissingError extends Error {
  readonly statusCode: number;
  readonly code = 'WB_SCOPE_MISSING';

  constructor(
    message: string,
    readonly originBody?: string,
    readonly endpoint?: string,
    readonly shopId?: number,
    statusCode = 401,
  ) {
    super(message);
    this.name = 'WbScopeMissingError';
    this.statusCode = statusCode;
  }
}

export function isScopeMissingError(err: unknown): err is WbScopeMissingError {
  return err instanceof WbScopeMissingError;
}

/**
 * Classify a 401/403 WB response into one of three categories so the
 * refresh runner / agent / UI can react differently:
 *   - 'expired'        — seller key is gone (revoked, rotated by user, lifetime ended).
 *                        Remediation: regenerate the key in seller.wildberries.ru.
 *   - 'scope_missing'  — key valid but no permission for THIS endpoint.
 *                        Remediation: regenerate with extra scope, or stop calling.
 *   - 'invalid'        — malformed header / wrong format. Remediation: backend bug.
 *
 * The detection is heuristic: WB does not return a structured "reason"
 * field. Order of checks matters — `expired` patterns are most specific,
 * `scope_missing` is checked before fallback `invalid`.
 */
/**
 * Расширенные типы partner-specific ошибок (см. доку WB «Работа с токенами»):
 *   secret_expired   — наш сервисный секрет истёк → нужно срочно обновить
 *   secret_withdrawn — наш сервисный секрет отозван WB → срочно перевыпустить
 *   secret_missing   — мы не передали X-Client-Secret в запрос (баг в interceptor)
 *   wrong_service    — токен продавца выпущен для другого сервиса → попросить переподключить
 * Все четыре требуют разной реакции (см. wb-обработчики ниже).
 */
export type AuthErrorKind =
  | 'expired' | 'scope_missing' | 'invalid'
  | 'secret_expired' | 'secret_withdrawn' | 'secret_missing' | 'wrong_service';

export function classifyAuthError(status: number, body: string): AuthErrorKind {
  const lower = (body ?? '').toLowerCase();

  // Partner-specific ошибки (наш секрет / привязка токена к сервису) — самый
  // высокий приоритет, ловим до общих expired/scope паттернов.
  if (lower.includes('secret token expired')) return 'secret_expired';
  if (lower.includes('secret token withdrawn')) return 'secret_withdrawn';
  if (lower.includes('x-client-secret is missing')) return 'secret_missing';
  if (lower.includes('access token and x-client-secret are for different authorized services')
      || lower.includes('different authorized services')) return 'wrong_service';

  // Most specific first — explicit expiry phrasing.
  if (
    lower.includes('access token expired') ||
    lower.includes('token has expired') ||
    lower.includes('token is expired') ||
    lower.includes('token expired')
  ) {
    return 'expired';
  }
  // Scope/permission patterns. WB phrases vary by endpoint — observed:
  //   "no access to this resource", "permission denied", "forbidden",
  //   "not enough rights", "scope" (when token issued without scope).
  if (status === 403 ||
      lower.includes('not enough rights') ||
      lower.includes('no access to this resource') ||
      lower.includes('permission denied') ||
      lower.includes('forbidden') ||
      lower.includes('scope')) {
    return 'scope_missing';
  }
  // Bare "Unauthorized" body on 401 with short payload — historically
  // WB used this for expired tokens (keep prior heuristic), so map to
  // expired rather than invalid to avoid false-negative rotation prompts.
  if (status === 401 && lower.includes('unauthorized') && (body?.length ?? 0) < 200) {
    return 'expired';
  }
  return 'invalid';
}

/**
 * Heuristic: does the 401 body look like a WB-token expiry?
 * Restored after refactor — used by wbPutJson / wbPatchJson / wbDeleteJson on 401.
 * Without this, those callers would crash with ReferenceError on any 401.
 */
function looksLikeExpiredToken(body: string): boolean {
  return classifyAuthError(401, body) === 'expired';
}

/** Strip query string and trailing slashes for a stable, log-friendly endpoint label. */
function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * Decode a WB API key (JWT) and return its `sid` claim — the unique WB
 * seller-account identifier. This is what WB rate-limits against, so it
 * becomes the per-endpoint bucket key (see wbEndpointBucket.ts).
 *
 * Two tokens issued for the same WB seller have IDENTICAL `sid` even if
 * they were generated separately with different scope / lifetime. So this
 * correctly collapses a workspace's multiple shop_ids back to one bucket
 * when they belong to one WB seller, and keeps them separate when they
 * are distinct sellers — matching WB's actual server-side quota model.
 *
 * Returns undefined when the key is not a parseable JWT (malformed, empty,
 * or a non-JWT token format). Callers should fall back to a workspace-only
 * bucket key in that case so we don't unintentionally widen the budget.
 */
const sellerIdCache = new Map<string, string | undefined>();
export function getWbSellerId(apiKey: string | undefined | null): string | undefined {
  if (!apiKey) return undefined;
  const cached = sellerIdCache.get(apiKey);
  if (cached !== undefined || sellerIdCache.has(apiKey)) return cached;
  let sid: string | undefined;
  try {
    const payloadB64 = apiKey.split('.')[1];
    if (payloadB64) {
      const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
        + '='.repeat((4 - (payloadB64.length % 4)) % 4);
      const json = Buffer.from(padded, 'base64').toString('utf8');
      const claims = JSON.parse(json) as { sid?: unknown };
      if (typeof claims.sid === 'string' && claims.sid.length > 0) sid = claims.sid;
    }
  } catch {
    sid = undefined;
  }
  sellerIdCache.set(apiKey, sid);
  return sid;
}

/**
 * Translate a 401/403 from WB into the right typed error. Used by both
 * GET and POST helpers so they stay in sync.
 */
function buildAuthError(status: number, body: string, url: string): Error {
  const kind = classifyAuthError(status, body);
  const ep = endpointLabel(url);
  const bodySnippet = body.slice(0, 300);

  // Partner-specific — алёртим админа (наш сервис сломан), но возвращаем
  // обычную ошибку чтобы не каскадить специальные обработчики наверх.
  if (kind === 'secret_expired' || kind === 'secret_withdrawn' || kind === 'secret_missing') {
    notifyAdminsAboutPartnerSecretIssue(kind, ep, bodySnippet);
    return new Error(`WB partner secret problem (${kind}) on ${ep}: ${bodySnippet}`);
  }
  if (kind === 'wrong_service') {
    return new Error(`WB token was issued for another service, not SigmaSeller (endpoint: ${ep})`);
  }

  if (kind === 'expired') {
    return new WbTokenExpiredError(
      `WB token expired — rotate key (endpoint: ${ep})`,
      bodySnippet,
      ep,
    );
  }
  if (kind === 'scope_missing') {
    return new WbScopeMissingError(
      `WB token has no scope for ${ep} (HTTP ${status})`,
      bodySnippet,
      ep,
      undefined,
      status,
    );
  }
  // 'invalid' — keep generic Error so callers don't auto-notify users.
  return new Error(`WB ${url} returned ${status}: ${bodySnippet}`);
}

/**
 * Алёрт всем is_admin=true в Telegram, когда WB вернула ошибку про наш
 * сервисный секрет (истёк / отозван / не передан). Throttle 1 раз в час —
 * чтобы не спамить при каждом из тысяч ежедневных запросов.
 */
const ADMIN_NOTIFY_THROTTLE: Map<string, number> = new Map();
function notifyAdminsAboutPartnerSecretIssue(
  kind: 'secret_expired' | 'secret_withdrawn' | 'secret_missing',
  endpoint: string,
  bodySnippet: string,
): void {
  const last = ADMIN_NOTIFY_THROTTLE.get(kind) ?? 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  ADMIN_NOTIFY_THROTTLE.set(kind, Date.now());
  setImmediate(async () => {
    try {
      const [{ db }, { users }, { sendTelegramPerUser }] = await Promise.all([
        import('../../db/client.js'),
        import('../../db/schema.js'),
        import('../telegram.js'),
      ]);
      const { eq } = await import('drizzle-orm');
      const admins = await db
        .select({ userId: users.userId })
        .from(users)
        .where(eq(users.isAdmin, true));
      const headline =
        kind === 'secret_expired' ? '🚨 <b>WB сервисный секрет ИСТЁК</b>' :
        kind === 'secret_withdrawn' ? '🚨 <b>WB сервисный секрет ОТОЗВАН</b>' :
        '🚨 <b>WB запрос без X-Client-Secret</b>';
      const action =
        kind === 'secret_missing' ? 'Проверьте, что WB_PARTNER_SERVICE_SECRET в env установлен и interceptor запущен.' :
        'Срочно выпустите новый секрет в Профиле компании на dev.wildberries.ru и обновите env.';
      const text = [
        headline,
        '',
        `Endpoint: <code>${endpoint}</code>`,
        `Деталь: <code>${bodySnippet.slice(0, 200)}</code>`,
        '',
        action,
      ].join('\n');
      await Promise.allSettled(admins.map((a) => sendTelegramPerUser(a.userId, text)));
    } catch (err) {
      log.error({ err, kind }, 'Failed to notify admins about partner secret issue');
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------



/**
 * Get WB API key. Priority:
 * 1. If shopId provided → load from marketplace_shops by shopId
 * 2. If workspaceId provided → load from marketplace_shops (platform=wb, first active shop)
 * No fallback to operator credentials.
 */
export async function getWbApiKey(workspaceId?: number, shopId?: number): Promise<string> { return sellerWbKey(workspaceId, shopId); }

/**
 * Get WB API key by shopId (shorthand)
 */
export async function getWbApiKeyByShop(shopId: number): Promise<string> {
  return getWbApiKey(undefined, shopId);
}

// ---------------------------------------------------------------------------
// Retry / backoff configuration
// ---------------------------------------------------------------------------

export interface WbRequestOptions {
  /** Request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Maximum 429 retry attempts (default 10). */
  maxRetries?: number;
  /** Maximum backoff delay in ms (default 90_000). */
  maxBackoffMs?: number;
  /** Maximum retries for invalid JSON responses (default 5). */
  maxJsonRetries?: number;
  /** Workspace owning the WB token (groups buckets per tenant). */
  workspaceId?: number;
  /** Shop owning the WB token. WB rate-limits per-token, so each shop in a
   * workspace has its own independent budget. Include shopId in bucket keys
   * so two shops in one workspace don't share quota. */
  shopId?: number;
}

const DEFAULT_OPTS: Required<Omit<WbRequestOptions, 'workspaceId' | 'shopId'>> & { workspaceId?: number; shopId?: number } = {
  timeoutMs: 30_000,
  maxRetries: 10,
  maxBackoffMs: 90_000,
  maxJsonRetries: 5,
  workspaceId: undefined,
  shopId: undefined,
};

function backoffMs(attempt: number, maxMs: number): number {
  // Exponential base: 1s, 2s, 4s, 8s, ... capped at maxMs.
  const base = Math.min(maxMs, 1000 * 2 ** (attempt - 1));
  // Half-jitter (50%-100% of base) — prevents thundering-herd when multiple
  // pods / processes are throttled in the same tick and would otherwise
  // retry at the exact same wall-clock moment, multiplying WB load.
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

/**
 * Max attempts for 5xx / network / timeout retries. WB's own 429
 * backoff uses a separate (longer) budget from DEFAULT_OPTS.maxRetries;
 * 5xx should be capped shorter so a prolonged outage surfaces as an
 * error in the sync-runs log within a minute or two, rather than
 * looping for 10+ minutes.
 */
const TRANSIENT_MAX_ATTEMPTS = 3;

/** Short backoff schedule for transient (5xx/timeout) retries: 1s, 5s, 15s. */
function transientBackoffMs(attempt: number): number {
  const schedule = [1_000, 5_000, 15_000];
  return schedule[Math.min(attempt - 1, schedule.length - 1)];
}

/**
 * Когда WB просит ждать БОЛЬШЕ этого значения — это soft-ban / global cooldown
 * на токен или endpoint, а не обычный rate-limit. Продолжать ретраить = усугублять
 * ban. Падаем сразу, sync-run отметится failed, cron попробует через час
 * (за это время WB отпустит блокировку).
 *
 * Пороги per-domain потому что WB ведёт rate-limit окна по-разному:
 *  - statistics-api / analytics-api / seller-analytics-api: окна укладываются
 *    в 60s, X-Ratelimit-Retry > 300s = реальный soft-ban. 5 мин.
 *  - supplies-api: WB штатно отдаёт Retry-After=1800s на ровном месте
 *    (наблюдалось 12.05.2026 — supplies-sync). 5-мин cutoff здесь убивал
 *    нормальный лимит. 30 мин.
 *  - documents-api: 6 rpm, длинные окна на пиках. 30 мин.
 *  - остальные: дефолт 5 мин.
 */
const WB_429_GIVEUP_MS_DEFAULT = 5 * 60_000;
const WB_429_GIVEUP_MS_BY_DOMAIN: Record<string, number> = {
  'supplies-api.wildberries.ru': 30 * 60_000,
  'documents-api.wildberries.ru': 30 * 60_000,
};

function giveUpThresholdMs(domain: string): number {
  return WB_429_GIVEUP_MS_BY_DOMAIN[domain] ?? WB_429_GIVEUP_MS_DEFAULT;
}

/**
 * Решение, как реагировать на 429:
 *   1. Уведомить локальный rate-limiter (notifyThrottled с retry-after) —
 *      следующий acquire() в этом процессе подождёт правильно.
 *   2. Если WB прислал retry-after и он > WB_429_GIVEUP_MS — бросаем ошибку
 *      сразу, чтобы не усугублять soft-ban повторными запросами.
 *   3. Иначе спим МАКС из (WB retry-after, экспоненциальный backoff). Раньше
 *      использовался только exponential — игнорировали 1800s от WB и долбили
 *      каждые 90s, что и привело к текущему soft-ban'у токена shop=1.
 *
 * @returns null если можно ретраить (после sleep), Error если надо бросить.
 */
async function handle429(
  res: Response,
  domain: string,
  attempt: number,
  maxBackoffMs: number,
  url: string,
): Promise<Error | null> {
  const retryAfterMs = parseRetryAfterMs(res);
  if (domain) wbRateLimiter.notifyThrottled(domain, retryAfterMs);

  const giveUpMs = giveUpThresholdMs(domain);
  if (retryAfterMs && retryAfterMs > giveUpMs) {
    return new Error(
      `WB ${url} rate-limited too long (retryAfter=${Math.round(retryAfterMs / 1000)}s, threshold=${Math.round(giveUpMs / 1000)}s) — giving up to avoid escalating soft-ban`,
    );
  }

  const exp = backoffMs(attempt, maxBackoffMs);
  const wait = retryAfterMs ? Math.max(retryAfterMs, exp) : exp;
  await sleep(wait);
  return null;
}

/**
 * Parse Retry-After header. WB rarely sends it but honour the value when
 * present — both delta-seconds (RFC 7231) and HTTP-date forms are valid.
 * WB также шлёт собственные `X-Ratelimit-Retry` (секунды) на 429-ответах —
 * читаем как fallback, см. https://dev.wildberries.ru/docs/openapi/api-information#section/Лимиты-запросов
 * Returns ms, or undefined if absent/unparseable.
 */
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      const diff = date - Date.now();
      if (diff > 0) return diff;
    }
  }
  const wbRetry = res.headers.get('x-ratelimit-retry');
  if (wbRetry) {
    const sec = Number(wbRetry);
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  }
  return undefined;
}

/**
 * Read WB-specific rate-limit headers and log them. Helps diagnose 429 storms:
 * показывает реальную quota от WB вместо нашего захардкоженного rpm.
 * Headers documented at:
 *   https://dev.wildberries.ru/docs/openapi/api-information#section/Лимиты-запросов
 *
 * On any 429 — log at WARN with full snapshot.
 * On 200/2xx with X-Ratelimit-Remaining ≤ 2 — log at WARN (близко к лимиту).
 * Otherwise silent.
 */
function logRatelimitHeaders(res: Response, domain: string | undefined, url: string, status: number): void {
  const remainingStr = res.headers.get('x-ratelimit-remaining');
  const retryStr = res.headers.get('x-ratelimit-retry');
  const resetStr = res.headers.get('x-ratelimit-reset');
  const limitStr = res.headers.get('x-ratelimit-limit');
  const remaining = remainingStr !== null ? Number(remainingStr) : null;
  if (status === 429 || (remaining !== null && Number.isFinite(remaining) && remaining <= 2)) {
    log.warn({
      module: 'wbClient',
      domain,
      url,
      status,
      remaining,
      retrySec: retryStr !== null ? Number(retryStr) : null,
      resetSec: resetStr !== null ? Number(resetStr) : null,
      limit: limitStr !== null ? Number(limitStr) : null,
    }, status === 429 ? 'WB 429 — actual rate-limit headers' : 'WB rate-limit budget low');
  }
}

/**
 * Did this fetch fail transiently (network drop, timeout)? We retry the
 * short backoff schedule for these; auth / body-parse / 4xx errors
 * are NOT considered transient and surface immediately.
 */
function isTransientFetchError(err: unknown): boolean {
  if (err instanceof Error) {
    // Node's AbortController timeout manifests as AbortError.
    if (err.name === 'AbortError') return true;
    const code = (err as any).code as string | undefined;
    if (code && [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_RESPONSE_STATUS_CODE',
    ].includes(code)) return true;
    // node fetch wraps connection errors in a TypeError with "fetch failed".
    if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified GET
// ---------------------------------------------------------------------------

/**
 * Generic WB GET request with typed response
 * Use wbGetJson<YourType>(url, apiKey) for type safety
 * 
 * Features:
 * - Rate limiting per domain
 * - 429 retry with exponential backoff
 * - 402 (Jam subscription) error handling
 */
export async function wbGetJson<T = unknown>(
  url: string,
  apiKey: string,
  attempt = 1,
  opts?: WbRequestOptions,
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Rate limiting: wait if domain is rate limited
  const domain = extractDomain(url);
  if (domain) {
    await wbRateLimiter.acquire(domain);
    // Per-endpoint WB quota (Redis-backed, cross-process safe). Falls back
    // to no-op when no entry in wbEndpointLimits — domain bucket above is
    // then the only enforcement.
    await acquireEndpoint(url, o.workspaceId, getWbSellerId(apiKey), 'GET');
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: buildWbHeaders(apiKey, false),
      signal: ac.signal,
    });
  } catch (err) {
    // Network drop / timeout. Retry with the short transient schedule,
    // separate from the 429 budget so a dead shard doesn't chew through
    // the full 10-retry 429 allowance.
    if (isTransientFetchError(err) && attempt <= TRANSIENT_MAX_ATTEMPTS) {
      await sleep(transientBackoffMs(attempt));
      return wbGetJson(url, apiKey, attempt + 1, opts);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();

  logRatelimitHeaders(res, domain, url, res.status);

  // WB hard rate limits; honour Retry-After, give up on long soft-bans
  if (res.status === 429 && attempt <= o.maxRetries) {
    const giveUp = await handle429(res, domain, attempt, o.maxBackoffMs, url);
    if (giveUp) throw giveUp;
    return wbGetJson(url, apiKey, attempt + 1, opts);
  }

  // Transient server-side errors. Retry the short schedule only — if
  // WB is genuinely down, we want the sync-run to mark 'failed' quickly
  // rather than hang for 20 minutes.
  if (res.status >= 500 && res.status < 600 && attempt <= TRANSIENT_MAX_ATTEMPTS) {
    await sleep(transientBackoffMs(attempt));
    return wbGetJson(url, apiKey, attempt + 1, opts);
  }

  // Jam subscription required
  if (res.status === 402) {
    throw new WbJamRequiredError(url);
  }

  // 401/403 — classify into expired / scope_missing / invalid so the
  // refresh runner and AI agent can react with the right remediation.
  if (res.status === 401 || res.status === 403) {
    throw buildAuthError(res.status, text, url);
  }

  if (!res.ok) {
    throw new Error(`WB GET ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  if (!text) {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return [] as T;
  }

  try {
    const parsed = JSON.parse(text) as T;
    void recordWbUsage(url, getWbSellerId(apiKey), countEntities(parsed));
    return parsed;
  } catch {
    if (attempt <= o.maxJsonRetries) {
      await sleep(1000 * attempt);
      return wbGetJson(url, apiKey, attempt + 1, opts);
    }
    throw new Error(`Invalid JSON from WB (len=${text.length})`);
  }
}

// ---------------------------------------------------------------------------
// Unified POST
// ---------------------------------------------------------------------------

/**
 * Generic WB POST request with typed response
 * Use wbPostJson<YourType>(url, apiKey, body) for type safety
 * 
 * Features:
 * - Rate limiting per domain
 * - 429 retry with exponential backoff
 * - 402 (Jam subscription) error handling
 */
export async function wbPostJson<T = unknown>(
  url: string,
  apiKey: string,
  body: unknown,
  attempt = 1,
  opts?: WbRequestOptions,
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Rate limiting: wait if domain is rate limited
  const domain = extractDomain(url);
  if (domain) {
    await wbRateLimiter.acquire(domain);
    // Per-endpoint WB quota (Redis-backed, cross-process safe). Falls back
    // to no-op when no entry in wbEndpointLimits — domain bucket above is
    // then the only enforcement.
    await acquireEndpoint(url, o.workspaceId, getWbSellerId(apiKey), 'POST');
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildWbHeaders(apiKey, true),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (isTransientFetchError(err) && attempt <= TRANSIENT_MAX_ATTEMPTS) {
      await sleep(transientBackoffMs(attempt));
      return wbPostJson(url, apiKey, body, attempt + 1, opts);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();

  logRatelimitHeaders(res, domain, url, res.status);

  if (res.status === 429 && attempt <= o.maxRetries) {
    const giveUp = await handle429(res, domain, attempt, o.maxBackoffMs, url);
    if (giveUp) throw giveUp;
    return wbPostJson(url, apiKey, body, attempt + 1, opts);
  }

  if (res.status >= 500 && res.status < 600 && attempt <= TRANSIENT_MAX_ATTEMPTS) {
    await sleep(transientBackoffMs(attempt));
    return wbPostJson(url, apiKey, body, attempt + 1, opts);
  }

  // Jam subscription required
  if (res.status === 402) {
    throw new WbJamRequiredError(url);
  }

  // See wbGetJson for rationale.
  if (res.status === 401 || res.status === 403) {
    throw buildAuthError(res.status, text, url);
  }

  if (!res.ok) {
    throw new Error(`WB POST ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  if (!text) {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }

  try {
    const parsed = JSON.parse(text) as T;
    void recordWbUsage(url, getWbSellerId(apiKey), countEntities(parsed));
    return parsed;
  } catch {
    if (attempt <= (o.maxJsonRetries ?? 3)) {
      await sleep(1000 * attempt);
      return wbPostJson(url, apiKey, body, attempt + 1, opts);
    }
    throw new Error(`Invalid JSON from WB (len=${text.length})`);
  }
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function kopecks(v: any): number {
  return Math.round(num(v) * 100);
}

// ---------------------------------------------------------------------------
// Unified PUT / PATCH
// ---------------------------------------------------------------------------

/**
 * Generic WB PUT request with typed response
 */
export async function wbPutJson<T = unknown>(
  url: string,
  apiKey: string,
  body: unknown,
  attempt = 1,
  opts?: WbRequestOptions,
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Rate limiting
  const domain = extractDomain(url);
  if (domain) {
    await wbRateLimiter.acquire(domain);
    // Per-endpoint WB quota (Redis-backed, cross-process safe). Falls back
    // to no-op when no entry in wbEndpointLimits — domain bucket above is
    // then the only enforcement.
    await acquireEndpoint(url, o.workspaceId, getWbSellerId(apiKey), 'PUT');
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: buildWbHeaders(apiKey, true),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (isTransientFetchError(err) && attempt <= TRANSIENT_MAX_ATTEMPTS) {
      await sleep(transientBackoffMs(attempt));
      return wbPutJson(url, apiKey, body, attempt + 1, opts);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();

  if (res.status === 429 && attempt <= o.maxRetries) {
    const giveUp = await handle429(res, domain, attempt, o.maxBackoffMs, url);
    if (giveUp) throw giveUp;
    return wbPutJson(url, apiKey, body, attempt + 1, opts);
  }

  if (res.status >= 500 && res.status < 600 && attempt <= TRANSIENT_MAX_ATTEMPTS) {
    await sleep(transientBackoffMs(attempt));
    return wbPutJson(url, apiKey, body, attempt + 1, opts);
  }

  if (res.status === 402) {
    throw new WbJamRequiredError(url);
  }

  if (res.status === 401 && looksLikeExpiredToken(text)) {
    throw new WbTokenExpiredError(undefined, text.slice(0, 300));
  }

  if (!res.ok) {
    throw new Error(`WB PUT ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  if (!text) {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }

  try {
    const parsed = JSON.parse(text) as T;
    void recordWbUsage(url, getWbSellerId(apiKey), countEntities(parsed));
    return parsed;
  } catch {
    // Some PUT endpoints return empty success
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }
}

/**
 * Generic WB PATCH request with typed response
 */
export async function wbPatchJson<T = unknown>(
  url: string,
  apiKey: string,
  body: unknown,
  attempt = 1,
  opts?: WbRequestOptions,
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Rate limiting
  const domain = extractDomain(url);
  if (domain) {
    await wbRateLimiter.acquire(domain);
    // Per-endpoint WB quota (Redis-backed, cross-process safe). Falls back
    // to no-op when no entry in wbEndpointLimits — domain bucket above is
    // then the only enforcement.
    await acquireEndpoint(url, o.workspaceId, getWbSellerId(apiKey), 'PATCH');
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: buildWbHeaders(apiKey, true),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (isTransientFetchError(err) && attempt <= TRANSIENT_MAX_ATTEMPTS) {
      await sleep(transientBackoffMs(attempt));
      return wbPatchJson(url, apiKey, body, attempt + 1, opts);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();

  if (res.status === 429 && attempt <= o.maxRetries) {
    const giveUp = await handle429(res, domain, attempt, o.maxBackoffMs, url);
    if (giveUp) throw giveUp;
    return wbPatchJson(url, apiKey, body, attempt + 1, opts);
  }

  if (res.status >= 500 && res.status < 600 && attempt <= TRANSIENT_MAX_ATTEMPTS) {
    await sleep(transientBackoffMs(attempt));
    return wbPatchJson(url, apiKey, body, attempt + 1, opts);
  }

  if (res.status === 402) {
    throw new WbJamRequiredError(url);
  }

  if (res.status === 401 && looksLikeExpiredToken(text)) {
    throw new WbTokenExpiredError(undefined, text.slice(0, 300));
  }

  if (!res.ok) {
    throw new Error(`WB PATCH ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  if (!text) {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }

  try {
    const parsed = JSON.parse(text) as T;
    void recordWbUsage(url, getWbSellerId(apiKey), countEntities(parsed));
    return parsed;
  } catch {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }
}

// ---------------------------------------------------------------------------
// Unified DELETE
// ---------------------------------------------------------------------------

/**
 * Generic WB DELETE request
 */
export async function wbDeleteJson<T = unknown>(
  url: string,
  apiKey: string,
  attempt = 1,
  opts?: WbRequestOptions,
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Rate limiting
  const domain = extractDomain(url);
  if (domain) {
    await wbRateLimiter.acquire(domain);
    // Per-endpoint WB quota (Redis-backed, cross-process safe). Falls back
    // to no-op when no entry in wbEndpointLimits — domain bucket above is
    // then the only enforcement.
    await acquireEndpoint(url, o.workspaceId, getWbSellerId(apiKey), 'DELETE');
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'DELETE',
      headers: buildWbHeaders(apiKey, false),
      signal: ac.signal,
    });
  } catch (err) {
    if (isTransientFetchError(err) && attempt <= TRANSIENT_MAX_ATTEMPTS) {
      await sleep(transientBackoffMs(attempt));
      return wbDeleteJson(url, apiKey, attempt + 1, opts);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();

  if (res.status >= 500 && res.status < 600 && attempt <= TRANSIENT_MAX_ATTEMPTS) {
    await sleep(transientBackoffMs(attempt));
    return wbDeleteJson(url, apiKey, attempt + 1, opts);
  }

  if (res.status === 429 && attempt <= o.maxRetries) {
    const giveUp = await handle429(res, domain, attempt, o.maxBackoffMs, url);
    if (giveUp) throw giveUp;
    return wbDeleteJson(url, apiKey, attempt + 1, opts);
  }

  if (res.status === 402) {
    throw new WbJamRequiredError(url);
  }

  if (res.status === 401 && looksLikeExpiredToken(text)) {
    throw new WbTokenExpiredError(undefined, text.slice(0, 300));
  }

  if (!res.ok) {
    throw new Error(`WB DELETE ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  if (!text) {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }

  try {
    const parsed = JSON.parse(text) as T;
    void recordWbUsage(url, getWbSellerId(apiKey), countEntities(parsed));
    return parsed;
  } catch {
    void recordWbUsage(url, getWbSellerId(apiKey), 0);
    return {} as T;
  }
}
