import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getNewOrders, getOrders } from '../../integrations/wb/marketplace/client.js';

interface QueryFbsOrdersArgs {
  newOnly?: boolean;
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryFbsOrders(args: QueryFbsOrdersArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  // Без shopId — не ходим в WB: иначе getWbApiKey(ws) возьмёт ЛЮБОЙ
  // токен workspace'а, и WB вернёт orders другого магазина → shop-leak.
  if (!shopId) return JSON.stringify({ error: 'shopId is required. Ask the user to select a shop.' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен для магазина' });

    let orders: any[];
    if (args.newOnly !== false) {
      const result = await getNewOrders(apiKey);
      orders = result?.orders ?? [];
    } else {
      const result = await getOrders(apiKey, args.limit ?? 100);
      orders = result?.orders ?? [];
    }

    // Sort by deadline (earliest first)
    orders.sort((a: any, b: any) => {
      const da = new Date(a.deliveryDate || a.createdAt).getTime();
      const db2 = new Date(b.deliveryDate || b.createdAt).getTime();
      return da - db2;
    });

    const now = Date.now();
    return JSON.stringify({
      totalOrders: orders.length,
      orders: orders.slice(0, 50).map((o: any) => {
        const deadline = new Date(o.deliveryDate || o.createdAt);
        const hoursLeft = Math.round((deadline.getTime() - now) / (1000 * 60 * 60));
        return {
          orderId: o.id,
          nmId: o.nmId,
          article: o.article,
          price: o.convertedPrice ?? o.price,
          status: o.status,
          createdAt: o.createdAt,
          deliveryDate: o.deliveryDate,
          hoursLeft,
          urgency: hoursLeft < 24 ? 'КРИТИЧНО' : hoursLeft < 48 ? 'ВАЖНО' : 'норма',
          warehouseName: o.warehouseName,
        };
      }),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки FBS заказов' });
  }
}
