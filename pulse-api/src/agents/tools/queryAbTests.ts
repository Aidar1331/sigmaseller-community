import { db } from '../../db/client.js';
import { sql } from 'drizzle-orm';

interface QueryAbTestsArgs {
  nmIds: number[];
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

interface AbTestRow {
  test_id: number;
  nm_id: number;
  status: string;
  goal: string;
  started_at: string;
  completed_at: string | null;
  current_variant: string | null;
  winner_variant: string | null;
  variants: unknown;
  metrics_summary: unknown;
}

/**
 * Surface A/B-photo test state for a list of nmIds. Used by the
 * "manager-plan" prompt so the agent knows which products already have an
 * ongoing/finished experiment before recommending new actions.
 *
 * Returns one row per (nm_id, test) — most products have at most one
 * active test, but completed history shows up too. metrics_summary comes
 * from ab_photo_phases aggregated into a per-test rollup.
 */
export async function queryAbTests(args: QueryAbTestsArgs): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  const ids = Array.isArray(args.nmIds) ? args.nmIds.filter((n) => Number.isFinite(n) && n > 0) : [];
  if (ids.length === 0) return JSON.stringify({ tests: [], note: 'no nmIds supplied' });

  const rows = await db.execute(sql`
    SELECT t.test_id, t.nm_id, t.status, t.goal,
           t.started_at::text AS started_at,
           t.completed_at::text AS completed_at,
           t.current_variant, t.winner_variant,
           t.variants,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'variant', p.variant,
               'startedAt', p.started_at::text,
               'endedAt', p.ended_at::text,
               'metrics', p.metrics_summary
             ) ORDER BY p.started_at)
             FROM ab_photo_phases p
             WHERE p.test_id = t.test_id
           ), '[]'::jsonb) AS metrics_summary
      FROM ab_photo_tests t
     WHERE t.workspace_id = ${wsId}
       AND t.nm_id IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)})
     ORDER BY t.started_at DESC
     LIMIT 50;
  `);

  const tests = (rows.rows as unknown as AbTestRow[]).map((r) => ({
    testId: Number(r.test_id),
    nmId: Number(r.nm_id),
    status: r.status,
    goal: r.goal,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    currentVariant: r.current_variant,
    winnerVariant: r.winner_variant,
    variants: r.variants,
    phases: r.metrics_summary,
  }));

  const byNm = new Map<number, typeof tests>();
  for (const t of tests) {
    if (!byNm.has(t.nmId)) byNm.set(t.nmId, []);
    byNm.get(t.nmId)!.push(t);
  }
  const missing = ids.filter((n) => !byNm.has(n));

  return JSON.stringify({
    tests,
    nmIdsWithoutTests: missing,
    totals: { tests: tests.length, productsWithTests: byNm.size, productsWithoutTests: missing.length },
  });
}
