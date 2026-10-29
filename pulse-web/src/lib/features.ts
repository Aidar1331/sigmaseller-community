/**
 * Client-side feature flags.
 *
 * Centralised kill-switch for UI surfaces that ship partially done. The
 * backend keeps serving the underlying routes (so API-level tests stay
 * green); this module controls whether end-users see them.
 *
 * Values read from NEXT_PUBLIC_* env vars so they're baked into the
 * client bundle at build time. Default is "off" — add a flag entry the
 * moment you start hiding a feature, flip it back on when the feature
 * is production-ready.
 */

type FlagName =
  | 'bidderAutomation'
  | 'seoKeywordMining'
  | 'teamInvites'; // multi-user workspace team features — hidden for now (single-user model)

/**
 * Read a boolean-like env var. NEXT_PUBLIC_ prefix is required or the
 * value won't ship to the browser bundle. Accepts `1`, `true`, `yes`
 * (case-insensitive) as truthy.
 */
function readEnvFlag(name: string): boolean | null {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return null;
}

/**
 * Flag defaults — off for unfinished features. Env vars can flip any
 * flag on without a code change.
 */
const DEFAULTS: Record<FlagName, boolean> = {
  bidderAutomation: false,
  seoKeywordMining: false,
  teamInvites: false,
};

const ENV_MAPPING: Record<FlagName, string> = {
  bidderAutomation: 'NEXT_PUBLIC_ENABLE_BIDDER_AUTOMATION',
  seoKeywordMining: 'NEXT_PUBLIC_ENABLE_SEO_MINING',
  teamInvites: 'NEXT_PUBLIC_ENABLE_TEAM_INVITES',
};

export function isFeatureEnabled(flag: FlagName): boolean {
  const fromEnv = readEnvFlag(ENV_MAPPING[flag]);
  return fromEnv ?? DEFAULTS[flag];
}

/**
 * Convenience React hook-friendly wrapper. Feature flags are read at
 * module load, so this is effectively a constant for the lifetime of
 * the browser tab — no subscription needed.
 */
export const features = {
  get bidderAutomation() {
    return isFeatureEnabled('bidderAutomation');
  },
  get seoKeywordMining() {
    return isFeatureEnabled('seoKeywordMining');
  },
  get teamInvites() {
    return isFeatureEnabled('teamInvites');
  },
};

export type { FlagName };
