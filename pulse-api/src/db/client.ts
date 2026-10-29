import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';

// Postgres max_connections defaults to 100. Pulse runs at least three
// long-lived processes (pulse-api, pulse-workers, and N concurrent spawned
// sync-script children), so if every process kept a max=40 pool open we
// could oversubscribe by 2-3x and exhaust the server's slot pool —
// observed 2026-05-16 02:30 as cascading pg-pool "timeout exceeded when
// trying to connect" errors after a child held connections for 45 minutes
// before being SIGTERM'd. Two protections:
//   1. Lower the pool max to 12 for short-lived child scripts (process
//      tagged via WB_SYNC_CHILD env). 12 is comfortably above the burst
//      of a single sync (typically ≤5 concurrent INSERTs).
//   2. Long-lived servers still get 25, which combined with workers and
//      a few children stays well under the 100-conn server cap.
const isSyncChild = process.env.WB_SYNC_CHILD === '1';
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: isSyncChild ? 12 : 25,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool);
