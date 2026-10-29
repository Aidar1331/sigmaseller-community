/* ── Shared types for Pulse dashboard ── */

export type SyncStatus = {
  workspaceId: number;
  isSyncing: boolean;
  activeSyncJobs: Array<{ name: string; startedOn: string }>;
  lastSyncByJob: Record<string, string>;
  lastDataByType?: Record<string, { firstDate: string | null; lastDate: string | null; gapDays: number; totalDays: number }>;
  run: null | {
    stage: string;
    status: string;
    error: string | null;
    updatedAt: string;
    createdAt: string;
    finishedAt: string | null;
    runId: string;
    shopId?: number | null;
  };
  cards: { count: number };
  funnelDaily: {
    totalsBySource: Record<string, number>;
    latestBySource: Record<string, { date: string; updatedAt: string } | undefined>;
    productsAvailableDaysFromToday: number;
  };
};

export type Overview = {
  workspaceId: number;
  from: string;
  to: string;
  groupBy: 'day' | 'week';
  availability: {
    funnelProductsDays: number;
  };
  kpis: {
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    advSpendRub: number;
    drrBase: 'sales' | 'payout';
    drrPercent: number;
    drrSalesPercent: number;
    drrPayoutPercent: number;
    marginRub: number;
    netProfitRub: number;
  };
  kpisPrev: {
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    advSpendRub: number;
    payoutRub: number;
    commissionRub: number;
    logisticsRub: number;
    marginRub: number;
    netProfitRub: number;
  };
  compare: {
    prevFrom: string;
    prevTo: string;
    lenDays: number;
    pct: {
      ordersCount: number;
      ordersRub: number;
      salesCount: number;
      salesRub: number;
      advSpendRub: number;
      drrPercent: number;
      marginRub: number;
      netProfitRub: number;
      [key: string]: number;
    };
  };
  series: OverviewSeriesItem[];
  anomalies: {
    enabled: boolean;
    thresholdPct: number;
    window: number;
    byKey: Record<
      string,
      Record<
        string,
        {
          low?: boolean;
          high?: boolean;
          pctDiff?: number;
          baseline?: number;
        }
      >
    >;
  };
};

export type OverviewSeriesItem = {
  key: string;
  ordersCount: number;
  salesCount: number;
  salesRub: number;
  ordersRub: number;
  priceNoSppRub: number;
  priceWithSppRub: number;
  sppPercent: number;
  advSpendRub: number;
  drrPercent: number;

  advManualSpendRub: number;
  advManualDrrPercent: number;
  advUnifiedSpendRub: number;
  advUnifiedDrrPercent: number;

  payoutRub: number;
  additionalPaymentRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  penaltyRub: number;
  acquiringRub: number;
  returnsCount: number;

  marginRub: number;
  marginPercent: number;
  roiPercent: number;
  netProfitRub: number;

  stockQty: number;
  stockInWayTo: number;
  stockInWayFrom: number;
  stockMoneyRub: number;
  turnoverDays: number;

  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  addToWishlistCount: number;
  funnelOrderCount: number;
  buyoutCount: number;
  buyoutSumRub: number;
  cancelCount: number;
  buyoutPercent: number;
  viewToOpenPercent: number;
  openToCartPercent: number;
  cartToOrderPercent: number;
};

export type ProductsMatrix = {
  dateKeys: string[];
  metric: string;
  totalCount?: number;
  page?: { offset: number; limit: number; pageSize: number };
  /** Сводка за весь период независимо от пагинации (2026-06-01) */
  kpiTotal?: {
    ordersCount: number;
    ordersRub: number;
    buyoutsCount: number;
    buyoutsRub: number;
    cancelsCount: number;
    cancelsRub: number;
    viewsCount: number;
    opensCount: number;
    cartsCount: number;
    buyoutPct: number;
    cancelPct: number;
  };
  rows: Array<{
    nmId: number;
    title: string | null;
    vendorCode: string | null;
    brandName: string | null;
    mainPhotoUrl: string | null;
    values: number[];
    anomalies: Array<{
      low?: boolean;
      high?: boolean;
      pctDiff?: number;
      baseline?: number;
    }>;
  }>;
};

export type PlanSummary = {
  start: string;
  end: string;
  ordersQty: number;
  salesQty: number;
  salesRub: number;
};

export type Tag = {
  tagId: number;
  name: string;
  color: string | null;
};

export type EventCountsByDate = Record<
  string,
  { alerts: number; logs: number; tasks: number }
>;

/** Filters passed to overview / matrix endpoints */
export type PulseFilters = {
  workspaceId: number;
  periodDays: number;
  drrBase: 'sales' | 'payout';
  groupBy: 'day' | 'week';
  anomalies: 'on' | 'off';
  anomalyThresholdPct: number;
  tagId: number | null;
  filterVendorCode: string;
  filterBrandName: string;
  filterSubjectName: string;
  filterSubjectId: string;
  filterNmIds: string;
  productsMetric: string;
};
