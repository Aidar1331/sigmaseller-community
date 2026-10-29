import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getWarehouses, getTransitTariffs } from '../../integrations/wb/supplies/client.js';

interface QueryWarehousesArgs {
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryWarehouses(args: QueryWarehousesArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const [warehouses, tariffs] = await Promise.all([
      getWarehouses(apiKey),
      getTransitTariffs(apiKey).catch(() => []),
    ]);

    return JSON.stringify({
      warehouseCount: warehouses.length,
      warehouses: warehouses.map((w: any) => ({
        id: w.ID ?? w.id,
        name: w.name,
        address: w.address,
        acceptsQR: w.acceptsQR,
      })),
      transitTariffs: (tariffs as any[]).slice(0, 20).map((t: any) => ({
        transitWarehouse: t.transitWarehouseName,
        destination: t.destinationWarehouseName,
        boxTariff: t.boxTariff,
        palletTariff: t.palletTariff,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки складов' });
  }
}
