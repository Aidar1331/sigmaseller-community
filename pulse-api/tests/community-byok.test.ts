import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

const state = vi.hoisted(() => ({ rows: new Map<string, any>(), role: 'owner', member: true, execute: vi.fn(), select: vi.fn() }));
vi.mock('../src/db/client.js', () => ({ db: { execute: state.execute, select: state.select } }));
vi.mock('../src/env.js', () => ({ env: { API_KEY_ENCRYPTION_SECRET: 'test-only-secret-at-least-thirty-two-characters', API_KEY: 'test-internal-only' } }));
vi.mock('../src/lib/logger.js', () => ({ default: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } }));
vi.mock('../src/lib/security.js', () => ({ isValidApiKey: () => false, isAdminUserAsync: async () => false }));

import { runWithAiWorkspace, currentAiWorkspace } from '../src/lib/sellerAiContext.js';
import { requireSellerAiKey, optionalSellerAiKey, saveSellerAiCredential, deleteSellerAiCredential, listSellerAiCredentials, assertNoPlatformAiKeys } from '../src/services/sellerAiCredentials.js';
import sellerAiContext from '../src/plugins/sellerAiContext.js';
import { sellerAiRoutes } from '../src/routes/sellerAi.js';
import { yandexDirectRoutes } from '../src/routes/yandexDirect.js';

beforeEach(() => {
  state.rows.clear(); state.role = 'owner'; state.member = true;
  state.execute.mockReset().mockImplementation(async (query: any) => {
    const { sql, params } = new PgDialect().sqlToQuery(query);
    if (/INSERT INTO/.test(sql)) { state.rows.set(`${params[0]}:${params[1]}`, { provider: params[1], encrypted_key: params[2], key_suffix: params[3] }); return []; }
    if (/DELETE FROM/.test(sql)) { state.rows.delete(`${params[0]}:${params[1]}`); return []; }
    if (/SELECT encrypted_key/.test(sql)) { const row = state.rows.get(`${params[0]}:${params[1]}`); return row ? [row] : []; }
    if (/SELECT provider/.test(sql)) return [...state.rows].filter(([k]) => k.startsWith(`${params[0]}:`)).map(([,v]) => v);
    throw Error('Unexpected query');
  });
  state.select.mockImplementation(() => { const chain: any = { from: () => chain, where: () => chain, limit: async () => state.member ? [{ workspaceId: 1, userId: 7, role: state.role }] : [] }; return chain; });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No external requests allowed during tests'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('seller credentials', () => {
  it('isolates concurrent asynchronous operations and clears scope afterward', async () => {
    await saveSellerAiCredential(1, 'anthropic', 'seller-one-key-1111');
    await saveSellerAiCredential(2, 'anthropic', 'seller-two-key-2222');
    const results = await Promise.all([1, 2, 1, 2].map(id => runWithAiWorkspace(id, async () => {
      await new Promise(resolve => setTimeout(resolve, id === 1 ? 15 : 1));
      return requireSellerAiKey('anthropic');
    })));
    expect(results).toEqual(['seller-one-key-1111', 'seller-two-key-2222', 'seller-one-key-1111', 'seller-two-key-2222']);
    expect(currentAiWorkspace()).toBeNull();
  });
  it('never falls back to an owner environment key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'owner-key-must-never-be-used');
    await expect(runWithAiWorkspace(1, () => requireSellerAiKey('anthropic'))).rejects.toThrow('Подключите свой ключ');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a workspace and rejects context changes or mismatched explicit IDs', async () => {
    await expect(requireSellerAiKey('openai')).rejects.toThrow('workspace is required');
    await expect(runWithAiWorkspace(1, () => requireSellerAiKey('openai', 2))).rejects.toThrow('does not match');
    expect(() => runWithAiWorkspace(1, () => runWithAiWorkspace(2, () => {}))).toThrow('Cannot change');
    await expect(runWithAiWorkspace(1, () => saveSellerAiCredential(2, 'openai', 'cross-tenant-key'))).rejects.toThrow('does not match');
  });
  it('encrypts keys, rejects copied ciphertext, and masks all list responses', async () => {
    const key = 'private-api-key-abcd';
    await saveSellerAiCredential(1, 'openai', key);
    const row = state.rows.get('1:openai');
    expect(row.encrypted_key).not.toContain(key);
    expect(JSON.stringify(await listSellerAiCredentials(1))).not.toContain(key);
    expect((await listSellerAiCredentials(1)).find(p => p.provider === 'openai')?.maskedKey).toBe('••••abcd');
    state.rows.set('2:openai', row);
    await expect(requireSellerAiKey('openai', 2)).rejects.toThrow('binding');
    state.rows.set('1:anthropic', row);
    await expect(requireSellerAiKey('anthropic', 1)).rejects.toThrow('binding');
  });
  it('applies rotation and deletion to the next call without cached keys', async () => {
    await saveSellerAiCredential(1, 'google', 'first-private-key');
    expect(await requireSellerAiKey('google', 1)).toBe('first-private-key');
    await saveSellerAiCredential(1, 'google', 'second-private-key');
    expect(await requireSellerAiKey('google', 1)).toBe('second-private-key');
    await deleteSellerAiCredential(1, 'google');
    expect(await optionalSellerAiKey('google', 1)).toBeUndefined();
  });
  it('fails startup if platform AI credentials remain, without leaking values', () => {
    expect(() => assertNoPlatformAiKeys({ ANTHROPIC_API_KEY: 'hidden-value' })).toThrow('ANTHROPIC_API_KEY');
    try { assertNoPlatformAiKeys({ OPENAI_API_KEY: 'hidden-value' }); } catch (e) { expect(String(e)).not.toContain('hidden-value'); }
    expect(() => assertNoPlatformAiKeys({ GOOGLE_APPLICATION_CREDENTIALS: '/private/file' })).toThrow();
    expect(() => assertNoPlatformAiKeys({ WB_PARTNER_SERVICE_SECRET: 'not-a-real-secret' })).toThrow('WB partner API can bill');
    expect(() => assertNoPlatformAiKeys({ WB_PARTNER_SECRET_INJECT: '1' })).toThrow('WB partner API can bill');
    expect(() => assertNoPlatformAiKeys({ WB_PARTNER_SERVICE_SECRET: 'not-a-real-secret', WB_PARTNER_BILLING_VERIFIED_FREE: '1' })).not.toThrow();
    expect(() => assertNoPlatformAiKeys({})).not.toThrow();
  });
  it('allows operator-paid WB without allowing shared AI or mail credentials', () => {
    const environment = { WB_PARTNER_SERVICE_SECRET: 'not-a-real-secret', WB_PARTNER_SECRET_INJECT: '1', WB_PARTNER_BILLING_ACCEPTED: '1' };
    expect(() => assertNoPlatformAiKeys(environment)).not.toThrow();
    for (const value of ['', '0', 'true']) {
      expect(() => assertNoPlatformAiKeys({ ...environment, WB_PARTNER_BILLING_ACCEPTED: value })).toThrow('WB partner API can bill');
    }
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY']) {
      expect(() => assertNoPlatformAiKeys({ ...environment, [name]: 'owner-key-must-not-be-used' })).toThrow(name);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function makeApp() {
  const app = Fastify();
  await app.register(fp(async instance => { instance.addHook('onRequest', async req => { (req as any).user = { userId: 7 }; }); }, { name: 'auth-plugin' }));
  await app.register(fp(async () => {}, { name: 'workspace-plugin' }));
  await app.register(sellerAiContext);
  await app.register(sellerAiRoutes);
  await app.register(yandexDirectRoutes);
  app.post('/probe', async () => { await new Promise(r => setTimeout(r, 2)); return { workspaceId: currentAiWorkspace() }; });
  return app;
}

describe('credential API and HTTP context', () => {
  it('never exposes the shared Yandex account to an ordinary shop owner', async () => {
    const app = await makeApp();
    try {
      expect((await app.inject('/integrations/yandex-direct/1/status')).statusCode).toBe(403);
      expect((await app.inject('/integrations/yandex-direct/1/campaigns')).statusCode).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('saves without a provider call and returns only masked owner-visible settings', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: 'PUT', url: '/ai/1/providers/anthropic', payload: { apiKey: 'seller-private-key-1234', acceptProviderCharges: true } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('seller-private-key');
      expect((await app.inject('/ai/1/providers')).json().canManage).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('denies viewer writes/deletes and nonmember reads', async () => {
    const app = await makeApp();
    try {
      state.role = 'viewer';
      expect((await app.inject('/ai/1/providers')).json().canManage).toBe(false);
      expect((await app.inject({ method: 'PUT', url: '/ai/1/providers/openai', payload: { apiKey: 'viewer-private-key', acceptProviderCharges: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: '/ai/1/providers/openai' })).statusCode).toBe(403);
      state.member = false;
      expect((await app.inject('/ai/1/providers')).statusCode).toBe(403);
      expect(state.rows.size).toBe(0);
    } finally { await app.close(); }
  });
  it('requires explicit acceptance of provider charges', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: 'PUT', url: '/ai/1/providers/openai', payload: { apiKey: 'seller-private-key', acceptProviderCharges: false } });
      expect(response.statusCode).not.toBe(200);
      expect(state.rows.size).toBe(0);
    } finally { await app.close(); }
  });
  it('keeps body-only workspace context across await and rejects conflicting IDs', async () => {
    const app = await makeApp();
    try {
      expect((await app.inject({ method: 'POST', url: '/probe', payload: { workspaceId: 1 } })).json()).toEqual({ workspaceId: 1 });
      expect((await app.inject({ method: 'POST', url: '/probe?workspaceId=2', payload: { workspaceId: 1 } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/probe', payload: {} })).json()).toEqual({ workspaceId: null });
    } finally { await app.close(); }
  });
});
