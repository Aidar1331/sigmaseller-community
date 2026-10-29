import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getSupplyDates } from '../../integrations/wb/supplies/client.js';

interface QueryAcceptanceCoefficientsArgs {
  warehouseId: number;
  deliveryType?: 'box' | 'mono_pallet' | 'super_safe';
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryAcceptanceCoefficients(args: QueryAcceptanceCoefficientsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const dates = await getSupplyDates(apiKey, args.warehouseId, args.deliveryType ?? 'box');

    return JSON.stringify({
      warehouseId: args.warehouseId,
      deliveryType: args.deliveryType ?? 'box',
      availableDates: dates.map((d: any) => ({
        date: d.date,
        coefficient: d.coefficient,
        slotsAvailable: d.slotsAvailable,
        recommendation: d.coefficient <= 1 ? 'ОТЛИЧНО' : d.coefficient <= 3 ? 'НОРМАЛЬНО' : d.coefficient <= 5 ? 'ДОРОГО' : 'ОЧЕНЬ ДОРОГО — подождать',
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки коэффициентов' });
  }
}
