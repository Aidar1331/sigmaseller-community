import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getPromotions, getPromotionProducts } from '../../integrations/wb/promotions.js';

interface QueryPromotionsArgs {
  status?: 'active' | 'upcoming' | 'all';
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryPromotions(args: QueryPromotionsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const result = await getPromotions(apiKey, { allPromo: args.status === 'all' || !args.status });
    const promos = result?.data?.promotions ?? [];
    const now = new Date();

    const filtered = promos.filter((p: any) => {
      if (args.status === 'active') return new Date(p.startDateTime) <= now && new Date(p.endDateTime) >= now;
      if (args.status === 'upcoming') return new Date(p.startDateTime) > now;
      return true;
    });

    return JSON.stringify({
      totalPromotions: filtered.length,
      promotions: filtered.slice(0, 20).map((p: any) => ({
        id: p.id,
        name: p.name,
        startDate: p.startDateTime,
        endDate: p.endDateTime,
        type: p.type,
        participateCount: p.participateCount,
        status: new Date(p.startDateTime) > now ? 'upcoming' : new Date(p.endDateTime) < now ? 'ended' : 'active',
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки акций' });
  }
}
