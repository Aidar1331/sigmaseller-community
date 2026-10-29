import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  const result = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  if (result.rows.length) throw new Error('Refusing to initialize a nonempty database');
  await client.query('BEGIN');
  await client.query(fs.readFileSync('db/bootstrap.sql', 'utf8'));
  await client.query('SET search_path TO public');
  for (const file of ['0149_workspace_ai_credentials.sql', '0150_account_recovery_codes.sql', '0151_seller_mcp.sql']) await client.query(fs.readFileSync('db/migrations/' + file, 'utf8'));
  for (const file of fs.readdirSync('db/migrations').filter(f => f.endsWith('.sql'))) await client.query('INSERT INTO pulse_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
  await client.query('COMMIT');
  console.log('Empty community database initialized');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await pool.end(); }
