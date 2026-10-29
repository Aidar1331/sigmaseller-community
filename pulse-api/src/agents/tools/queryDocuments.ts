import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getDocumentsList, getDocumentCategories } from '../../integrations/wb/documents.js';

interface QueryDocumentsArgs {
  from: string;
  to: string;
  category?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryDocuments(args: QueryDocumentsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const [docsResult, categoriesResult] = await Promise.all([
      getDocumentsList(apiKey, { beginTime: args.from, endTime: args.to, category: args.category, limit: 50 }),
      getDocumentCategories(apiKey),
    ]);

    const docs = docsResult?.data?.documents ?? [];
    const categories = categoriesResult?.data?.categories ?? [];

    return JSON.stringify({
      totalDocuments: docs.length,
      categories: categories.map((c: any) => ({ id: c.id, name: c.name })),
      documents: docs.map((d: any) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        date: d.date,
        extension: d.extension,
        serviceName: d.serviceName,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки документов' });
  }
}
