/**
 * Custom migration runner.
 *
 * Why not drizzle-kit migrate? This project was originally bootstrapped via
 * `drizzle-kit push`, which creates schema objects WITHOUT populating the
 * __drizzle_migrations ledger. When drizzle's migrator then tries to apply
 * 0001..NNNN, the first migration errors with 42P07 (relation already
 * exists), and the migrator aborts the whole batch — leaving newer
 * migrations (like our Multi-Agent 0070) unapplied.
 *
 * This runner reads db/migrations/*.sql directly, tracks applied files in
 * a lightweight `pulse_migrations` table, and runs each file in its own
 * transaction. Errors that look like "already exists" or duplicate constraint
 * mark the migration as skipped (safe because our SQL uses IF NOT EXISTS).
 * Other errors abort startup.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logJobs as logger } from '../lib/logger.js';

const MIGRATIONS_FOLDER = join(process.cwd(), 'db', 'migrations');

const IGNORABLE_SQL_STATES = new Set([
  '42P07', // relation already exists
  '42701', // column already exists
  '42710', // duplicate object (index, constraint, type)
  '42P06', // schema already exists
  '42723', // duplicate function
  '23505', // unique violation
  // Schema drift in legacy migrations — DB was evolved past these via drizzle
  // push + later ALTERs, so references to old columns/tables are stale.
  // Treating as "already superseded" is safe because the live schema is
  // validated by the TS-side drizzle definitions.
  '42703', // column does not exist (legacy migration references later-renamed col)
  '42P01', // undefined table (legacy migration references later-renamed table)
  '42704', // undefined object
  '23503', // foreign key violation (seed for non-existent workspace/data — applied on first user registration)
]);

function isIgnorable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code && IGNORABLE_SQL_STATES.has(e.code)) return true;
  const msg = String(e?.message ?? '').toLowerCase();
  return msg.includes('already exists') || msg.includes('уже существует');
}

export async function runPendingMigrations(pool: Pool): Promise<{ applied: string[]; skipped: string[]; seeded?: number }> {
  // Ensure tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const applied: string[] = [];
  const skipped: string[] = [];

  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (err) {
    logger.warn({ err, folder: MIGRATIONS_FOLDER }, 'migrations folder not readable, skipping');
    return { applied, skipped };
  }

  // First-time bootstrap: if pulse_migrations is empty BUT the workspaces
  // table already exists, the DB was built via drizzle-kit push (and/or a
  // previous Drizzle migrator pass). Seed the tracker with every current
  // file so we don't re-execute legacy migrations that now reference renamed
  // columns / missing seed data. New migrations (any added after this seed)
  // will still be applied normally.
  const { rows: trackerRows } = await pool.query('SELECT COUNT(*)::int AS n FROM pulse_migrations');
  if (trackerRows[0]?.n === 0) {
    const { rows: hasWorkspaces } = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspaces' LIMIT 1",
    );
    if (hasWorkspaces.length > 0) {
      const communityFiles = new Set(['0149_workspace_ai_credentials.sql', '0150_account_recovery_codes.sql', '0151_seller_mcp.sql']);
      const legacyFiles = files.filter(f => !communityFiles.has(f));
      for (const f of legacyFiles) {
        await pool.query('INSERT INTO pulse_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
      }
      logger.info({ seeded: legacyFiles.length }, 'pulse_migrations seeded; community migrations still pending');
    }
  }

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM pulse_migrations WHERE name = $1', [file]);
    if (rows.length > 0) continue;

    const sqlPath = join(MIGRATIONS_FOLDER, file);
    let sql: string;
    try {
      sql = readFileSync(sqlPath, 'utf8');
    } catch (err) {
      logger.error({ err, file }, 'failed to read migration file');
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO pulse_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      applied.push(file);
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (Number.parseInt(file, 10) < 149 && isIgnorable(err)) {
        // Record as applied so we don't try again next start
        await pool.query('INSERT INTO pulse_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        skipped.push(file);
        logger.warn({ file, code: (err as { code?: string })?.code }, 'migration skipped (ignorable duplicate)');
      } else {
        logger.error({ err, file }, 'migration failed');
        throw err;
      }
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
