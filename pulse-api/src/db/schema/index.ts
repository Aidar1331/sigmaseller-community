/**
 * Schema index - re-exports all tables
 * 
 * TODO: Gradually move tables to domain-specific files:
 * - auth.ts: users, userSessions, workspaces, workspaceMembers, workspaceInvites
 * - billing.ts: workspaceSubscriptions, workspacePayments
 * - ai.ts: aiProviderSettings, aiUsageEvents
 * - wb.ts: marketplaceShops, wbCards, wbFunnel*, wbOrders*, wbAdv*, etc.
 * - pulse.ts: pulsePresets, pulseMetricGroups, pulsePlans, etc.
 * - creative.ts: creativeAuditRuns, abPhotoTests, abPhotoPhases
 * - insights.ts: insights, insightSettings
 * - feedback.ts: marketplaceFeedback*, marketplaceReply*, knowledgeEntries
 * - fbs.ts: fbsSchedules, fbsRuns, fbsDocuments
 * - cashflow.ts: cashflowSettings, cashflowPlannedItems, etc.
 * - bidder.ts: bidderRules, bidderActions, bidderSettings
 * - seo.ts: seoKeywords, seoKeywordProducts, seoPositionSnapshots, seoAlerts
 * - audit.ts: auditLog
 */

// For now, re-export everything from the monolith
// As we split, we'll import from individual files and re-export here
export * from '../schema.js';
