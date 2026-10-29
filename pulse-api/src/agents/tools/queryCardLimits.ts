import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getCardLimits } from '../../integrations/wb/content.js';

interface QueryCardLimitsArgs {
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryCardLimits(args: QueryCardLimitsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const limits = await getCardLimits(apiKey);

    return JSON.stringify({
      freeLimits: limits.freeLimits ?? 0,
      paidLimits: limits.paidLimits ?? 0,
      totalAvailable: (limits.freeLimits ?? 0) + (limits.paidLimits ?? 0),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка получения лимитов' });
  }
}
