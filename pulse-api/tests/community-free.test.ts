import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../src/db/client.js', () => ({ db: state }));
vi.mock('../src/lib/logger.js', () => ({ default: { child: () => ({ info() {}, warn() {}, error() {} }) } }));
vi.mock('../src/env.js', () => ({ env: {} }));
import { checkBalance, chargeWorkspaceKopecks, deductUsage, refundWorkspaceKopecks, topUp } from '../src/services/aiTokens.js';
import { runSubscriptionRenewal } from '../src/jobs/subscriptionRenewal.js';
import { sendEmail } from '../src/lib/email.js';
import { allowScheduledJob } from '../src/jobs/communityPolicy.js';

describe('free service does not charge or send paid emails', () => {
  it('runs synchronization and keeps autonomous changes disabled by default', () => {
    expect(allowScheduledJob('orders-sales-sync')).toBe(true);
    for (const name of ['bidder-hourly', 'feedback-auto-reply', 'ab-photo-auto-rotate', 'price-ab-auto-rotate', 'supply-booking-queue-processor', 'unknown-new-task']) expect(allowScheduledJob(name)).toBe(false);
    expect(allowScheduledJob('bidder-hourly', '0')).toBe(true);
  });
  it('allows usage without internal credits and makes no ledger changes', async () => {
    expect((await checkBalance(1)).allowed).toBe(true);
    expect((await chargeWorkspaceKopecks({ workspaceId: 1, userId: 1, costKopecks: 500, type: 'test' })).costKopecks).toBe(0);
    expect((await deductUsage({ workspaceId: 1, userId: 1, inputTokens: 100, outputTokens: 100, model: 'test' })).costKopecks).toBe(0);
    await refundWorkspaceKopecks({ workspaceId: 1, userId: 1, costKopecks: 500, type: 'test' });
    await expect(topUp({ workspaceId: 1, userId: 1, amountKopecks: 100 })).rejects.toThrow('бесплатен');
    expect(state.insert).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });
  it('does not renew subscriptions or invoke an email provider', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'));
    try {
      expect((await runSubscriptionRenewal()).charged).toBe(0);
      expect((await sendEmail({ to: 'test@example.test', subject: 'test', html: 'test' })).ok).toBe(false);
      expect(network).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
