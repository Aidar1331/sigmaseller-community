// Default startup runs data synchronization only. Enabling autonomous writes is
// an explicit operator choice after reviewing each workspace's saved rules.
const READ_ONLY_JOBS = new Set([
  'finance-weekly-products-sync', 'finance-daily-sync', 'stocks-daily-snapshot',
  'adv-daily-sync', 'orders-sales-sync', 'spp-weekly-sync', 'funnel-daily-sync',
  'feedback-sync', 'ab-photo-metrics-collect', 'SESSION_CLEANUP', 'supplies-sync',
  'acceptance-coeff-monitor', 'fbs-stocks-sync', 'campaigns-sync',
  'search-queries-sync', 'stocks-history-sync', 'paid-storage-sync', 'reports-daily-sync',
  'backfill-walker', 'agent-events-bridge', 'price-change-detector',
  'rating-drop-detector', 'wb-sync-runs-sweeper', 'wb-card-snapshot-daily',
]);
export function allowScheduledJob(name: string, mode = process.env.COMMUNITY_READ_ONLY_AUTOMATIONS): boolean {
  return mode === '0' || READ_ONLY_JOBS.has(name);
}
