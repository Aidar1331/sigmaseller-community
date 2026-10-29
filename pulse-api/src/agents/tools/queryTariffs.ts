import { getCommissionTariffs, getTariffsBox } from '../../integrations/wb/tariffs.js';

interface QueryTariffsArgs {
  subjectNames?: string[];
  date?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryTariffs(args: QueryTariffsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const today = args.date ?? new Date().toISOString().slice(0, 10);
    const [commissions, boxTariffs] = await Promise.all([
      getCommissionTariffs('ru'),
      getTariffsBox(today).catch(() => []),
    ]);

    let filteredCommissions = commissions;
    if (args.subjectNames?.length) {
      const lower = args.subjectNames.map(s => s.toLowerCase());
      filteredCommissions = commissions.filter((c: any) =>
        lower.some(l => (c.subjectName || '').toLowerCase().includes(l) || (c.parentName || '').toLowerCase().includes(l))
      );
    }

    return JSON.stringify({
      commissions: filteredCommissions.slice(0, 30).map((c: any) => ({
        subjectName: c.subjectName,
        parentName: c.parentName,
        commission: c.kgvpMarketplace ?? c.commission,
        fbs: c.kgvpSupplier ?? c.fbs,
      })),
      boxTariffs: (Array.isArray(boxTariffs) ? boxTariffs : []).slice(0, 10).map((t: any) => ({
        warehouseName: t.warehouseName,
        boxDeliveryAndStorageExpr: t.boxDeliveryAndStorageExpr,
        boxDeliveryBase: t.boxDeliveryBase,
        boxDeliveryLiter: t.boxDeliveryLiter,
        boxStorageBase: t.boxStorageBase,
        boxStorageLiter: t.boxStorageLiter,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка загрузки тарифов' });
  }
}
