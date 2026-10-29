import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('../src/db/client.js', () => ({ db: new Proxy({}, { get(_target, key) { const v = state.client[key]; return typeof v === 'function' ? v.bind(state.client) : v; } }) }));
import { issueRecoveryCode, recoveryCodeHash, resetWithRecoveryCode } from '../src/services/recoveryCodes.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { accountRecoveryRoutes } from '../src/routes/accountRecovery.js';
vi.mock('../src/lib/crypto.js', () => ({ safeDecrypt: (value: string) => value }));
import { sellerWbKey } from '../src/services/sellerWbCredentials.js';
import { runWithAiWorkspace } from '../src/lib/sellerAiContext.js';
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite(); state.client = drizzle(pg);
  await pg.exec(`CREATE TABLE users (user_id bigint PRIMARY KEY, email text UNIQUE, password_hash text, reset_token text, reset_expires_at timestamptz, failed_login_attempts integer DEFAULT 0, locked_until timestamptz);
    CREATE TABLE marketplace_shops (shop_id bigint PRIMARY KEY, workspace_id bigint, api_key text, platform text DEFAULT 'wb', is_active boolean DEFAULT true);
    CREATE TABLE seller_oauth_grants (user_id bigint REFERENCES users(user_id) ON DELETE CASCADE, revoked_at timestamptz);
    CREATE TABLE user_sessions (session_id text PRIMARY KEY, user_id bigint REFERENCES users(user_id));
    CREATE TABLE user_refresh_tokens (token_hash text PRIMARY KEY, session_id text REFERENCES user_sessions(session_id) ON DELETE CASCADE);`);
  await pg.exec(readFileSync(new URL('../db/migrations/0150_account_recovery_codes.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await pg.exec('TRUNCATE users, user_sessions, user_refresh_tokens, account_recovery_codes, marketplace_shops CASCADE');
  await pg.query('INSERT INTO users (user_id,email,password_hash) VALUES (1,$1,$2),(2,$3,$2)', ['one@example.test', await hashPassword('old-password'), 'two@example.test']);
  await pg.exec("INSERT INTO user_sessions VALUES ('session-one',1),('session-two',2); INSERT INTO user_refresh_tokens VALUES ('refresh-one','session-one')");
});
afterAll(async () => { await pg.close(); });

describe('recovery with real PostgreSQL transactions', () => {
  it('uses only the selected WB shop and never falls back after a mismatch', async () => {
    await pg.exec("INSERT INTO marketplace_shops (shop_id,workspace_id,api_key) VALUES (10,1,'shop-one'),(20,2,'shop-two')");
    expect(await sellerWbKey(1,10)).toBe('shop-one');
    expect(await sellerWbKey(undefined,20)).toBe('shop-two');
    await expect(sellerWbKey(1,20)).rejects.toThrow('Подключите');
    await expect(sellerWbKey(1,999)).rejects.toThrow('Подключите');
    await expect(runWithAiWorkspace(1,()=>sellerWbKey(undefined,20))).rejects.toThrow('Подключите');
    await expect(sellerWbKey()).rejects.toThrow('Укажите');
  });
  it('stores only a hash and replaces old codes', async () => {
    const oldCode = await issueRecoveryCode(1); const code = await issueRecoveryCode(1);
    expect(code.replaceAll('-', '')).toMatch(/^[a-f0-9]{64}$/);
    const rows = (await pg.query<any>('SELECT * FROM account_recovery_codes')).rows;
    expect(rows).toHaveLength(1); expect(rows[0].code_hash).toBe(recoveryCodeHash(code));
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(await resetWithRecoveryCode('one@example.test', oldCode, 'new-password')).toBeNull();
  });
  it('rejects a code for another account without changing passwords or sessions', async () => {
    const code = await issueRecoveryCode(1);
    expect(await resetWithRecoveryCode('two@example.test', code, 'new-password')).toBeNull();
    expect((await pg.query('SELECT * FROM user_sessions')).rows).toHaveLength(2);
    expect((await pg.query('SELECT * FROM account_recovery_codes')).rows).toHaveLength(1);
  });
  it('consumes once, revokes sessions/refresh tokens, and issues a replacement', async () => {
    const code = await issueRecoveryCode(1);
    const replacement = await resetWithRecoveryCode('one@example.test', code.toUpperCase(), 'new-password');
    expect(replacement).toBeTruthy(); expect(replacement).not.toBe(code);
    const user = (await pg.query<any>('SELECT * FROM users WHERE user_id=1')).rows[0];
    expect(await verifyPassword('new-password', user.password_hash)).toBe(true);
    expect(await verifyPassword('old-password', user.password_hash)).toBe(false);
    expect((await pg.query('SELECT * FROM user_sessions')).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM user_refresh_tokens')).rows).toHaveLength(0);
    expect(await resetWithRecoveryCode('one@example.test', code, 'another-password')).toBeNull();
  });
  it('rolls back code consumption when updating a password fails', async () => {
    const code = await issueRecoveryCode(1);
    await pg.exec("CREATE FUNCTION reject_test_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test update failure'; END $$; CREATE TRIGGER reject_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION reject_test_update()");
    try { await expect(resetWithRecoveryCode('one@example.test', code, 'new-password')).rejects.toThrow(); }
    finally { await pg.exec('DROP TRIGGER reject_update ON users; DROP FUNCTION reject_test_update()'); }
    expect((await pg.query<any>('SELECT code_hash FROM account_recovery_codes WHERE user_id=1')).rows[0].code_hash).toBe(recoveryCodeHash(code));
    expect((await pg.query('SELECT * FROM user_sessions')).rows).toHaveLength(2);
  });
  it('requires authentication and the current password to replace a code', async () => {
    const app = Fastify();
    app.addHook('onRequest', async req => { if (req.headers['x-test-user'] === 'yes') req.user = { userId: 1, email: 'one@example.test', sessionId: 'test' }; });
    await app.register(accountRecoveryRoutes);
    try {
      expect((await app.inject({ method: 'POST', url: '/auth/recovery-code', payload: { password: 'old-password' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/auth/recovery-code', headers: { 'x-test-user': 'yes' }, payload: { password: 'wrong' } })).statusCode).toBe(401);
      const response = await app.inject({ method: 'POST', url: '/auth/recovery-code', headers: { 'x-test-user': 'yes' }, payload: { password: 'old-password' } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().recoveryCode).toBeTruthy();
    } finally { await app.close(); }
  });
});
