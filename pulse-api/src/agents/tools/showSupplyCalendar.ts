import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getWarehouses, getSupplyDates } from '../../integrations/wb/supplies/client.js';

interface ShowSupplyCalendarArgs {
  warehouseIds?: number[];
  deliveryType?: 'box' | 'mono_pallet' | 'super_safe';
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function showSupplyCalendar(args: ShowSupplyCalendarArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    // Use shop-scoped API key so warehouses / slots are fetched with the
    // right shop's credentials (multi-shop workspaces would otherwise always
    // see the first shop's slots).
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    let warehouseIds = args.warehouseIds;
    if (!warehouseIds?.length) {
      const allWarehouses = await getWarehouses(apiKey);
      warehouseIds = allWarehouses.slice(0, 5).map((w: any) => w.ID ?? w.id);
    }

    const calendars = await Promise.all(
      warehouseIds.map(async (whId) => {
        try {
          const dates = await getSupplyDates(apiKey, whId, args.deliveryType ?? 'box');
          return { warehouseId: whId, dates };
        } catch {
          return { warehouseId: whId, dates: [], error: 'Не удалось загрузить' };
        }
      })
    );

    return JSON.stringify({
      __widget: 'supply_calendar',
      props: {
        deliveryType: args.deliveryType ?? 'box',
        warehouses: calendars.map(c => ({
          warehouseId: c.warehouseId,
          dates: (c.dates as any[]).slice(0, 14).map((d: any) => ({
            date: d.date,
            coefficient: d.coefficient,
            slotsAvailable: d.slotsAvailable,
          })),
        })),
      },
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки календаря' });
  }
}
