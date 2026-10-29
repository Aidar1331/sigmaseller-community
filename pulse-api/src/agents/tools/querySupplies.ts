import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getSupplies, getActiveSupplies } from '../../integrations/wb/supplies/client.js';

interface QuerySuppliesArgs {
  activeOnly?: boolean;
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function querySupplies(args: QuerySuppliesArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const supplies = args.activeOnly
      ? await getActiveSupplies(apiKey)
      : await getSupplies(apiKey, {}, args.limit ?? 50);

    return JSON.stringify({
      totalSupplies: supplies.length,
      supplies: supplies.map((s: any) => ({
        id: s.ID ?? s.id,
        name: s.name,
        status: s.status,
        createdAt: s.createdAt,
        closedAt: s.closedAt,
        warehouseName: s.warehouseName,
        goodsCount: s.goodsCount ?? s.totalGoods,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки поставок' });
  }
}
