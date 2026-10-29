/**
 * Tool `query_passes` — список пропусков на склад WB.
 * Возвращает активные пропуска из WB API + историю из локальной БД за 30 дней.
 * Используй перед action_create_pass, чтобы проверить нет ли уже активного.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { supplyPasses } from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getPasses, getPassTimeRemaining } from '../../integrations/wb/passes.js';

export interface QueryPassesInput {
  _workspaceId?: number;
  _shopId?: number | null;
}

export async function queryPasses(input: QueryPassesInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', error: 'workspace_id missing' });

  try {
    const apiKey = await getWbApiKey(wsId, input._shopId ?? undefined);
    if (!apiKey) return JSON.stringify({ status: 'error', error: 'WB API ключ не настроен' });

    // 1. Активные пропуска из WB API
    const wbPasses = await getPasses(apiKey);
    const activePasses = wbPasses.map((p) => {
      const tr = getPassTimeRemaining(p);
      return {
        wbPassId: p.id,
        warehouseName: p.officeName,
        warehouseAddress: p.officeAddress,
        driver: `${p.firstName} ${p.lastName}`,
        car: `${p.carModel} ${p.carNumber}`,
        validUntil: p.dateEnd,
        timeRemaining: tr.expired ? 'Истёк' : `${tr.hours}ч ${tr.minutes}м`,
        expired: tr.expired,
      };
    });

    // 2. История из локальной БД за последние 30 дней
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const history = await db
      .select()
      .from(supplyPasses)
      .where(and(eq(supplyPasses.workspaceId, wsId), gte(supplyPasses.createdAt, since)))
      .orderBy(desc(supplyPasses.createdAt))
      .limit(20);

    const activeCount = activePasses.filter((p) => !p.expired).length;

    return JSON.stringify({
      status: 'ok',
      activeCount,
      active: activePasses.filter((p) => !p.expired),
      expired: activePasses.filter((p) => p.expired),
      history: history.map((h) => ({
        passId: Number(h.passId),
        wbPassId: h.wbPassId,
        warehouseId: h.warehouseId,
        driver: `${h.driverFirstName} ${h.driverLastName}`,
        car: `${h.carModel} ${h.carNumber}`,
        validUntil: h.validUntil,
        createdAt: h.createdAt,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ status: 'error', error: msg });
  }
}
