/**
 * Route configuration for centralized registration.
 * 
 * Each entry specifies:
 * - path: relative path to the route module (without extension)
 * - exportName: the named export to use from the module
 * - prefix: optional URL prefix for the route
 * 
 * This replaces 35+ copy-paste route registrations in server.ts
 */

export interface RouteConfig {
  path: string;
  exportName: string;
  prefix?: string;
}

export const ROUTE_CONFIGS: RouteConfig[] = [
  // Auth (special handling for dev/prod)
  { path: './routes/accountRecovery', exportName: 'accountRecoveryRoutes' },
  { path: './routes/auth', exportName: 'authRoutes' },
  
  { path: './routes/sellerAi', exportName: 'sellerAiRoutes' },
  { path: './routes/sellerMcp', exportName: 'sellerMcpRoutes' },
  { path: './routes/yandexDirect', exportName: 'yandexDirectRoutes' },
  // Core API routes
  { path: './routes/presets', exportName: 'presetsRoutes' },
  { path: './routes/wb', exportName: 'wbRoutes' },
  { path: './routes/pulse', exportName: 'pulseRoutes' },
  { path: './routes/metrics', exportName: 'metricsRoutes' },
  { path: './routes/unitEconomics', exportName: 'unitEconomicsRoutes' },
  { path: './routes/finance', exportName: 'financeRoutes' },
  { path: './routes/selfPurchases', exportName: 'selfPurchasesRoutes' },
  { path: './routes/dynamics', exportName: 'dynamicsRoutes' },
  { path: './routes/stocks', exportName: 'stocksRoutes' },
  { path: './routes/fbs', exportName: 'fbsRoutes' },
  { path: './routes/cards', exportName: 'cardsRoutes' },
  { path: './routes/cogs', exportName: 'cogsRoutes' },
  { path: './routes/tags', exportName: 'tagsRoutes' },
  { path: './routes/events', exportName: 'eventsRoutes' },
  { path: './routes/alerts', exportName: 'alertsRoutes' },
  { path: './routes/reports', exportName: 'reportsRoutes' },
  { path: './routes/plans', exportName: 'plansRoutes' },
  { path: './routes/calc', exportName: 'calcRoutes' },
  { path: './routes/subscriptions', exportName: 'subscriptionsRoutes' },
  { path: './routes/payments', exportName: 'paymentsRoutes' },
  { path: './routes/telegramBot', exportName: 'telegramBotRoutes' },
  { path: './routes/admin', exportName: 'adminRoutes' },
  { path: './routes/onboarding', exportName: 'onboardingRoutes' },
  { path: './routes/feedback', exportName: 'feedbackRoutes' },
  { path: './routes/creativeAudit', exportName: 'creativeAuditRoutes' },
  { path: './routes/abPhoto', exportName: 'abPhotoRoutes' },
  { path: './routes/priceAb', exportName: 'priceAbRoutes' },
  { path: './routes/insightSettings', exportName: 'insightSettingsRoutes' },
  { path: './routes/insights', exportName: 'insightsRoutes' },
  { path: './routes/lab', exportName: 'labRoutes' },
  { path: './routes/analytics', exportName: 'analyticsRoutes' },
  { path: './routes/alertSettings', exportName: 'alertSettingsRoutes' },
  { path: './routes/alertControls', exportName: 'alertControlsRoutes' },
  { path: './routes/agentSettings', exportName: 'agentSettingsRoutes' },

  { path: './routes/supplies', exportName: 'suppliesRoutes' },
  { path: './routes/seo', exportName: 'seoRoutes', prefix: '/seo' },
  { path: './routes/team', exportName: 'teamRoutes' },
  { path: './routes/audit', exportName: 'auditRoutes' },
  { path: './routes/bidder', exportName: 'bidderRoutes' },
  { path: './routes/cashflow', exportName: 'cashflowRoutes' },
  { path: './routes/shops', exportName: 'shopsRoutes' },
  { path: './routes/fbsOps', exportName: 'fbsOpsRoutes' },
  { path: './routes/fbsOrders', exportName: 'fbsOrdersRoutes' },
  { path: './routes/returns', exportName: 'returnsRoutes' },
  { path: './routes/chat', exportName: 'chatRoutes' },
  { path: './routes/regionSales', exportName: 'regionSalesRoutes' },
  { path: './routes/content', exportName: 'contentRoutes' },
  { path: './routes/aiChat', exportName: 'aiChatRoutes' },
  { path: './routes/aiBalance', exportName: 'aiBalanceRoutes' },
  { path: './routes/aiEvents', exportName: 'aiEventsRoutes' },
  { path: './routes/agentRules', exportName: 'agentRulesRoutes' },
  { path: './routes/agentMetrics', exportName: 'agentMetricsRoutes' },
  { path: './routes/agents', exportName: 'agentsRoutes' },
  { path: './routes/agentActions', exportName: 'agentActionsRoutes' },
  { path: './routes/kanbanAssistant', exportName: 'kanbanAssistantRoutes' },
  { path: './routes/pricing', exportName: 'pricingEngineRoutes' },
  { path: './routes/prices', exportName: 'pricesRoutes' },
  { path: './routes/knowledgeBase', exportName: 'knowledgeBaseRoutes' },
  { path: './routes/seoGenerator', exportName: 'seoGeneratorRoutes' },
  { path: './routes/taskMonitor', exportName: 'taskMonitorRoutes' },
  { path: './routes/documentHub', exportName: 'documentHubRoutes' },
  { path: './routes/reportGenerator', exportName: 'reportGeneratorRoutes' },
  // { path: './routes/creative', exportName: 'creativeRoutes' }, // TODO: add schema tables
  
  // Visual Studio
  { path: './routes/studio', exportName: 'studioRoutes' },
];

import { importModule } from './lib/importModule.js';

/**
 * Import a route module with fallback for tsx dev runtime.
 * Uses importModule helper with proper error logging.
 */
export async function importRoute(config: RouteConfig): Promise<{ routeFn: any; config: RouteConfig }> {
  const { module: mod } = await importModule(`${config.path}.js`, import.meta.url);
  
  const routeFn = mod[config.exportName];
  if (!routeFn) {
    throw new Error(`Route export '${config.exportName}' not found in ${config.path}`);
  }
  
  return { routeFn, config };
}

/**
 * Register all routes from ROUTE_CONFIGS on a Fastify instance.
 */
export async function registerAllRoutes(app: any): Promise<void> {
  for (const config of ROUTE_CONFIGS) {
    const { routeFn } = await importRoute(config);
    
    if (config.prefix) {
      await app.register(routeFn, { prefix: config.prefix });
    } else {
      await app.register(routeFn);
    }
  }
}
