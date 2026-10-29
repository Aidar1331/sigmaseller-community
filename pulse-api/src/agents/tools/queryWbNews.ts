import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { wbGetJson } from '../../integrations/wb/wbClient.js';

interface QueryWbNewsArgs {
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryWbNews(args: QueryWbNewsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const result = await wbGetJson<any>(`https://common-api.wildberries.ru/api/communications/v2/news?limit=${args.limit ?? 20}`, apiKey);

    const news = result?.data ?? result?.news ?? [];

    return JSON.stringify({
      totalNews: Array.isArray(news) ? news.length : 0,
      news: (Array.isArray(news) ? news : []).slice(0, 20).map((n: any) => ({
        id: n.id,
        header: n.header,
        date: n.date,
        type: n.types?.join(', ') ?? n.type,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки новостей WB' });
  }
}
