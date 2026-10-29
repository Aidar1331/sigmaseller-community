/**
 * Startup DB-schema sanity check.
 *
 * DECISIONS #89 documented a class of bugs where the auto-migrator
 * marked a migration applied even though one of its DDL statements
 * failed (`agent_messages.attachments` was the original case, three
 * separate elements were missing). Unit tests ran green; only a live
 * /ai/chat E2E surfaced the broken column.
 *
 * Instead of a full drizzle↔information_schema diff (expensive and
 * brittle against idempotent columns like indexes), we explicitly assert
 * the recently-added elements from the paid-launch plan. Every
 * subsequent migration adds one more row here.
 *
 * Behaviour:
 *   - Dev/test: log warnings so iteration stays fast.
 *   - Production: throw so the pod fails readiness and the ops team
 *     sees a crash loop instead of silently-broken features.
 */

import type { Pool } from 'pg';
import log from './logger.js';

const logger = log.child({ module: 'verifyDbSchema' });

type ExpectedColumn = { table: string; column: string; migration: string };
type ExpectedTable = { table: string; migration: string };
type ExpectedView = { view: string; migration: string };

const EXPECTED_COLUMNS: ExpectedColumn[] = [
  // 0108 — auth hardening
  { table: 'users', column: 'email_verified',         migration: '0108' },
  { table: 'users', column: 'email_verify_token',     migration: '0108' },
  { table: 'users', column: 'email_verify_expires_at', migration: '0108' },
  { table: 'users', column: 'failed_login_attempts',  migration: '0108' },
  { table: 'users', column: 'locked_until',           migration: '0108' },
  // 0113 — per-workspace audit_version override
  { table: 'workspaces', column: 'audit_version',     migration: '0113' },
];

const EXPECTED_TABLES: ExpectedTable[] = [
  { table: 'workspace_ai_credentials', migration: '0149' },
  { table: 'account_recovery_codes', migration: '0150' },
  // 0108
  { table: 'user_refresh_tokens',         migration: '0108' },
  // 0109 — Telegram link flow
  { table: 'user_telegram_links',         migration: '0109' },
  { table: 'user_telegram_link_codes',    migration: '0109' },
  // 0112 — per-shop notification dedup (WB token expiry alerts etc.)
  { table: 'notification_dedup',          migration: '0112' },
];

const EXPECTED_VIEWS: ExpectedView[] = [
  // 0111 — sync freshness VIEW powering GET /wb/:ws/shops/:shop/sync-status
  { view: 'marketplace_shops_sync_status', migration: '0111' },
];

export interface SchemaDrift {
  missingColumns: ExpectedColumn[];
  missingTables: ExpectedTable[];
  missingViews: ExpectedView[];
}

/**
 * Compare the running DB against EXPECTED_* lists. Returns what's
 * missing; callers decide whether to warn or throw.
 */
export async function diffSchemaAgainstExpected(pool: Pool): Promise<SchemaDrift> {
  const missingColumns: ExpectedColumn[] = [];
  const missingTables: ExpectedTable[] = [];
  const missingViews: ExpectedView[] = [];

  // Tables
  const tableNames = EXPECTED_TABLES.map((t) => t.table);
  if (tableNames.length) {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [tableNames],
    );
    const present = new Set(res.rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) {
      if (!present.has(t.table)) missingTables.push(t);
    }
  }

  // Views — information_schema.views, same shape.
  const viewNames = EXPECTED_VIEWS.map((v) => v.view);
  if (viewNames.length) {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [viewNames],
    );
    const present = new Set(res.rows.map((r) => r.table_name));
    for (const v of EXPECTED_VIEWS) {
      if (!present.has(v.view)) missingViews.push(v);
    }
  }

  // Columns — one query per table to keep the SQL readable.
  const byTable = new Map<string, ExpectedColumn[]>();
  for (const c of EXPECTED_COLUMNS) {
    const arr = byTable.get(c.table) ?? [];
    arr.push(c);
    byTable.set(c.table, arr);
  }
  for (const [table, cols] of byTable) {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2::text[])`,
      [table, cols.map((c) => c.column)],
    );
    const present = new Set(res.rows.map((r) => r.column_name));
    for (const c of cols) {
      if (!present.has(c.column)) missingColumns.push(c);
    }
  }

  return { missingColumns, missingTables, missingViews };
}

/**
 * Run the diff at startup. Throws in production if anything is missing
 * so the process never serves traffic against a broken schema.
 */
export async function verifyDbSchemaOrWarn(pool: Pool): Promise<void> {
  let drift: SchemaDrift;
  try {
    drift = await diffSchemaAgainstExpected(pool);
  } catch (err) {
    logger.error({ err }, 'verifyDbSchema failed to introspect — skipping check');
    return;
  }

  const total =
    drift.missingColumns.length + drift.missingTables.length + drift.missingViews.length;
  if (total === 0) {
    logger.info('DB schema matches expected migrations');
    return;
  }

  const payload = {
    missingColumns: drift.missingColumns.map((c) => `${c.table}.${c.column} (${c.migration})`),
    missingTables: drift.missingTables.map((t) => `${t.table} (${t.migration})`),
    missingViews: drift.missingViews.map((v) => `${v.view} (${v.migration})`),
  };

  if (process.env.NODE_ENV === 'production') {
    logger.error(payload, 'DB schema drift detected — refusing to start in production');
    throw new Error(
      `DB schema drift: ${payload.missingColumns.length} missing column(s), ${payload.missingTables.length} missing table(s), ${payload.missingViews.length} missing view(s). ` +
        `See verifyDbSchema.ts EXPECTED_* lists and re-run migrations.`,
    );
  }

  logger.warn(payload, 'DB schema drift detected (non-production, continuing)');
}
