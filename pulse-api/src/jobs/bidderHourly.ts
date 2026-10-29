/**
 * Bidder Hourly Job
 * 
 * Checks active bidder rules and applies bid changes to WB campaigns.
 * Runs every hour.
 */

import { eq, and, sql, inArray, gte, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bidderRules, bidderActions, bidderSettings, bidderAlerts, marketplaceShops } from '../db/schema.js';
import { getWbApiKey, wbGetJson } from '../integrations/wb/wbClient.js';
import { sendTelegramMessage } from '../integrations/telegram.js';
import { logJobs as logger } from '../lib/logger.js';

interface CampaignInfo {
  advertId: number;
  type: number; // 8=auto, 9=search, 6=catalog
  status: number;
  dailyBudget: number;
  cpm: number;
  name: string;
  position?: number; // Current ad position (if available)
}

interface CampaignStats {
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  spend: number;
  orders: number;
  orderSum: number;
  drr: number;
}

export async function runBidderHourly(): Promise<void> {
  logger.info('Starting hourly check');

  // Get all workspaces with active bidder
  const activeWorkspaces = await db
    .select({ workspaceId: bidderSettings.workspaceId })
    .from(bidderSettings)
    .where(
      and(
        eq(bidderSettings.isEnabled, true),
        eq(bidderSettings.killSwitchEnabled, false)
      )
    );

  if (activeWorkspaces.length === 0) {
    logger.info('No active workspaces');
    return;
  }

  logger.info({ count: activeWorkspaces.length }, 'Found active workspaces');

  for (const { workspaceId } of activeWorkspaces) {
    try {
      await processWorkspace(workspaceId);
    } catch (err) {
      logger.error({ err, workspaceId }, 'Error processing workspace');
    }
  }

  logger.info('Hourly check completed');
}

async function processWorkspace(workspaceId: number): Promise<void> {
  logger.info({ workspaceId }, 'Processing workspace');

  // Acquire advisory lock to prevent race conditions with parallel job runs
  // Lock ID is based on workspaceId to allow different workspaces to run in parallel
  const lockId = 100000 + workspaceId; // Offset to avoid collision with other locks
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${lockId}) as acquired`);
  const acquired = (lockResult.rows[0] as any)?.acquired;
  
  if (!acquired) {
    logger.info({ workspaceId }, 'Workspace already being processed, skipping');
    return;
  }

  try {
    await processWorkspaceInternal(workspaceId);
  } finally {
    // Always release the lock
    await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`);
  }
}

async function processWorkspaceInternal(workspaceId: number): Promise<void> {
  // Get settings
  const [settings] = await db
    .select()
    .from(bidderSettings)
    .where(eq(bidderSettings.workspaceId, workspaceId))
    .limit(1);

  if (!settings || settings.killSwitchEnabled) {
    return;
  }

  // Get active rules
  const rules = await db
    .select()
    .from(bidderRules)
    .where(
      and(
        eq(bidderRules.workspaceId, workspaceId),
        eq(bidderRules.isActive, true)
      )
    )
    .orderBy(sql`priority DESC`);

  if (rules.length === 0) {
    logger.info({ workspaceId }, 'No active rules for workspace');
    return;
  }

  // Check if current time is within active hours/days
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay() || 7; // Convert Sunday from 0 to 7

  // Multi-shop: bidder правила в текущем MVP хранятся per-workspace. WB advert
  // API возвращает кампании того shop'а, чей токен передан. Минимальный fix —
  // итерируем по всем активным WB-shop'ам и обрабатываем кампании каждого.
  // Полноценный per-shop refactor (rules/settings per shop) — отдельный план.
  const { marketplaceShops } = await import('../db/schema.js');
  const shops = await db
    .select({ shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(and(
      eq(marketplaceShops.workspaceId, workspaceId),
      eq(marketplaceShops.platform, 'wb'),
      eq(marketplaceShops.isActive, true),
    ));
  if (shops.length === 0) {
    logger.info({ workspaceId }, 'No active shops for workspace');
    return;
  }
  for (const { shopId } of shops) {
    try {
      await processShopCampaigns(workspaceId, shopId, settings, rules, now, currentHour, currentDay);
    } catch (err) {
      logger.error({ err, workspaceId, shopId }, 'Error processing shop');
    }
  }

  // Update last run time (once per workspace)
  await db
    .update(bidderSettings)
    .set({ lastRunAt: now, updatedAt: now })
    .where(eq(bidderSettings.workspaceId, workspaceId));
  return;
}

async function processShopCampaigns(
  workspaceId: number,
  shopId: number,
  settings: any,
  rules: any,
  now: Date,
  currentHour: number,
  currentDay: number,
): Promise<void> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) {
    logger.info({ workspaceId, shopId }, 'No API key for shop');
    return;
  }

  // Get campaigns
  const campaigns = await fetchCampaigns(apiKey);
  if (campaigns.length === 0) {
    logger.info({ workspaceId }, 'No campaigns for workspace');
    return;
  }

  // Get campaign stats
  const campaignIds = campaigns.map(c => c.advertId);
  const stats = await fetchCampaignStats(apiKey, campaignIds);

  // Check budget alerts
  await checkBudgetAlerts(workspaceId, campaigns, stats, settings);

  // Process each rule
  for (const rule of rules) {
    // Check time restrictions
    if (rule.activeHours && !(rule.activeHours as number[]).includes(currentHour)) {
      continue;
    }
    if (rule.activeDays && !(rule.activeDays as number[]).includes(currentDay)) {
      continue;
    }

    // Filter campaigns for this rule
    const targetCampaigns = campaigns.filter(c => {
      // Campaign ID filter
      if (rule.campaignIds && !(rule.campaignIds as number[]).includes(c.advertId)) {
        return false;
      }
      // Type filter
      if (rule.targetType !== 'all') {
        const typeMap: Record<string, number[]> = {
          search: [9],
          catalog: [6],
          auto: [8],
        };
        if (!typeMap[rule.targetType]?.includes(c.type)) {
          return false;
        }
      }
      return true;
    });

    // Evaluate and apply rule for each campaign
    for (const campaign of targetCampaigns) {
      try {
        // Idempotency check: skip if already bid this hour
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentActions = await db
          .select({ actionId: bidderActions.actionId })
          .from(bidderActions)
          .where(
            and(
              eq(bidderActions.campaignId, campaign.advertId),
              eq(bidderActions.ruleId, rule.ruleId),
              eq(bidderActions.status, 'applied'),
              sql`${bidderActions.appliedAt} > ${hourAgo}`
            )
          )
          .limit(1);

        if (recentActions.length > 0) {
          continue; // Skip - already applied this hour
        }

        const campaignStats = stats.get(campaign.advertId);
        const action = evaluateRule(rule, campaign, campaignStats, settings);

        if (action) {
          await executeBidChange(workspaceId, rule, campaign, action, apiKey, settings);
        }
      } catch (err) {
        logger.error({ err, ruleId: rule.ruleId, campaignId: campaign.advertId }, 'Error applying rule to campaign');
        
        // Log failed action
        await db.insert(bidderActions).values({
          workspaceId,
          ruleId: rule.ruleId,
          campaignId: campaign.advertId,
          actionType: 'bid_change',
          status: 'failed',
          errorText: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

}

function evaluateRule(
  rule: typeof bidderRules.$inferSelect,
  campaign: CampaignInfo,
  stats: CampaignStats | undefined,
  settings: typeof bidderSettings.$inferSelect
): { newBid: number; reason: string } | null {
  const conditions = rule.conditions as any;
  const currentBid = campaign.cpm;

  // Calculate new bid based on rule type
  let newBid = currentBid;
  let reason = '';

  switch (rule.ruleType) {
    case 'drr_target':
      if (!stats || stats.orderSum === 0) return null;
      const currentDrr = (stats.spend / stats.orderSum) * 100;
      const targetDrr = conditions.targetDrr || 20;

      if (currentDrr > targetDrr * 1.1) {
        // DRR too high, decrease bid
        newBid = applyAction(currentBid, 'decrease_percent', 10, rule.minBid, rule.maxBid);
        reason = `DRR ${currentDrr.toFixed(1)}% > target ${targetDrr}%`;
      } else if (currentDrr < targetDrr * 0.9) {
        // DRR low, can increase bid
        newBid = applyAction(currentBid, 'increase_percent', 5, rule.minBid, rule.maxBid);
        reason = `DRR ${currentDrr.toFixed(1)}% < target ${targetDrr}%`;
      }
      break;

    case 'cpm_range':
      const minCpm = conditions.minCpm || rule.minBid;
      const maxCpm = conditions.maxCpm || rule.maxBid;

      if (currentBid < minCpm) {
        newBid = minCpm;
        reason = `CPM ${currentBid} below min ${minCpm}`;
      } else if (currentBid > maxCpm) {
        newBid = maxCpm;
        reason = `CPM ${currentBid} above max ${maxCpm}`;
      }
      break;

    case 'budget_limit':
      if (!stats) return null;
      const maxBudget = conditions.maxBudget;
      if (maxBudget && stats.spend >= maxBudget * 0.9) {
        // Approaching budget limit, pause or reduce
        newBid = rule.minBid;
        reason = `Spend ${stats.spend} approaching budget ${maxBudget}`;
      }
      break;

    case 'position_target':
      // Position-based bidding - requires competitor analysis
      // This is handled separately via autoBidder service in full hourly run
      // Here we just apply simple logic based on current position
      const targetPosition = conditions.targetPosition || 5;
      const currentPosition = campaign.position || 999;
      
      if (currentPosition > targetPosition) {
        // Need to bid higher to improve position
        const increase = Math.min(20, (currentPosition - targetPosition) * 2);
        newBid = applyAction(currentBid, 'increase_percent', increase, rule.minBid, rule.maxBid);
        reason = `Position ${currentPosition} > target ${targetPosition}, increasing bid`;
      } else if (currentPosition < targetPosition && currentPosition > 0) {
        // Position is better than needed, can reduce bid
        newBid = applyAction(currentBid, 'decrease_percent', 5, rule.minBid, rule.maxBid);
        reason = `Position ${currentPosition} < target ${targetPosition}, can reduce bid`;
      }
      break;

    case 'time_schedule':
      // Time-based bidding - adjust bid based on time of day
      const now = new Date();
      const hour = now.getHours();
      const schedule = conditions.schedule || {};
      
      // Default: normal bid
      let multiplier = 1.0;
      
      // Check if current hour has a multiplier
      if (schedule[hour] !== undefined) {
        multiplier = schedule[hour];
      } else if (schedule.peak && hour >= 18 && hour <= 23) {
        // Peak hours (6pm-11pm) - higher bid
        multiplier = schedule.peak || 1.2;
      } else if (schedule.offPeak && (hour >= 0 && hour <= 6)) {
        // Off-peak hours (midnight-6am) - lower bid
        multiplier = schedule.offPeak || 0.7;
      }
      
      if (multiplier !== 1.0) {
        newBid = Math.round(currentBid * multiplier);
        reason = `Time schedule: hour ${hour}, multiplier ${multiplier}`;
      }
      break;

    default:
      // Apply direct action
      newBid = applyAction(currentBid, rule.actionType, rule.actionValue, rule.minBid, rule.maxBid);
      reason = `Rule action: ${rule.actionType} ${rule.actionValue}`;
  }

  // Check if change is significant
  // Use percentage threshold (5% of current bid) for small bids
  // but minimum 10 kopecks for larger bids
  const minChange = Math.max(10, Math.round(currentBid * 0.05));
  if (Math.abs(newBid - currentBid) < minChange) {
    return null;
  }

  // Apply global limits
  newBid = Math.max(settings.globalMinBid, Math.min(settings.globalMaxBid, newBid));

  return { newBid, reason };
}

function applyAction(
  currentBid: number,
  actionType: string,
  actionValue: number,
  minBid: number,
  maxBid: number
): number {
  let newBid = currentBid;

  switch (actionType) {
    case 'set':
      newBid = actionValue;
      break;
    case 'increase':
      newBid = currentBid + actionValue;
      break;
    case 'decrease':
      newBid = currentBid - actionValue;
      break;
    case 'increase_percent':
      newBid = Math.round(currentBid * (1 + actionValue / 100));
      break;
    case 'decrease_percent':
      newBid = Math.round(currentBid * (1 - actionValue / 100));
      break;
  }

  return Math.max(minBid, Math.min(maxBid, newBid));
}

async function executeBidChange(
  workspaceId: number,
  rule: typeof bidderRules.$inferSelect,
  campaign: CampaignInfo,
  action: { newBid: number; reason: string },
  apiKey: string,
  settings: any
): Promise<void> {
  // Log action
  const [actionRecord] = await db.insert(bidderActions).values({
    workspaceId,
    ruleId: rule.ruleId,
    campaignId: campaign.advertId,
    actionType: 'bid_change',
    previousValue: campaign.cpm,
    newValue: action.newBid,
    reason: action.reason,
    context: {
      campaignName: campaign.name,
      campaignType: campaign.type,
    },
    status: 'pending',
  }).returning();

  try {
    // Apply bid change via WB API using wbPatchJson (handles rate limiting and retries)
    const { wbPatchJson } = await import('../integrations/wb/wbClient.js');
    await wbPatchJson(
      'https://advert-api.wildberries.ru/adv/v0/bids',
      apiKey,
      [{
        advertId: campaign.advertId,
        type: campaign.type,
        cpm: action.newBid,
      }]
    );

    // Mark as applied
    await db
      .update(bidderActions)
      .set({ status: 'applied', appliedAt: new Date() })
      .where(eq(bidderActions.actionId, actionRecord.actionId));

    logger.info({ campaignId: campaign.advertId, oldBid: campaign.cpm, newBid: action.newBid, reason: action.reason }, 'Applied bid change');

    // Send notification if enabled
    if (settings.notifyTelegram && settings.notifyOnChange && settings.telegramChatId) {
      try {
        const direction = action.newBid > campaign.cpm ? '📈' : '📉';
        const change = action.newBid - campaign.cpm;
        const changePercent = ((change / campaign.cpm) * 100).toFixed(1);
        
        const text = `${direction} <b>Ставка изменена</b>\n\n` +
          `Кампания: ${campaign.name}\n` +
          `Было: ${campaign.cpm} → Стало: ${action.newBid}\n` +
          `Изменение: ${change > 0 ? '+' : ''}${change} (${change > 0 ? '+' : ''}${changePercent}%)\n\n` +
          `Причина: ${action.reason}`;

        await sendTelegramMessage(settings.telegramChatId, text);
      } catch (err) {
        logger.error({ err }, 'Failed to send bid change notification');
      }
    }
  } catch (err) {
    // Mark as failed
    await db
      .update(bidderActions)
      .set({
        status: 'failed',
        errorText: err instanceof Error ? err.message : String(err),
      })
      .where(eq(bidderActions.actionId, actionRecord.actionId));
    throw err;
  }
}

async function fetchCampaigns(apiKey: string): Promise<CampaignInfo[]> {
  try {
    // Use wbGetJson for consistent rate limiting and retry logic
    const data = await wbGetJson<{ adverts?: Array<{ type: number; status: number; count: number; advertList?: Array<{ advertId: number; changeTime: string }> }> }>(
      'https://advert-api.wildberries.ru/adv/v1/promotion/count',
      apiKey
    );
    
    const campaignIds: number[] = [];
    for (const group of data.adverts || []) {
      for (const adv of group.advertList || []) {
        campaignIds.push(adv.advertId);
      }
    }

    if (campaignIds.length === 0) return [];

    // Get detailed info using wbPostJson
    const { wbPostJson } = await import('../integrations/wb/wbClient.js');
    const campaigns = await wbPostJson<CampaignInfo[]>(
      'https://advert-api.wildberries.ru/adv/v1/promotion/adverts',
      apiKey,
      campaignIds.slice(0, 50)
    );
    
    return campaigns || [];
  } catch (err) {
    logger.error({ err }, 'Failed to fetch campaigns');
    return [];
  }
}

async function fetchCampaignStats(apiKey: string, campaignIds: number[]): Promise<Map<number, CampaignStats>> {
  const stats = new Map<number, CampaignStats>();
  const { wbPostJson } = await import('../integrations/wb/wbClient.js');
  
  try {
    // Get stats for last 7 days to avoid issues with early morning runs
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    
    for (let i = 0; i < campaignIds.length; i += 10) {
      const batch = campaignIds.slice(i, i + 10);
      
      // Use wbPostJson for consistent rate limiting
      type StatsResponse = Array<{
        advertId: number;
        days?: Array<{
          views: number;
          clicks: number;
          ctr: number;
          cpc: number;
          sum: number;
          orders: number;
          shks: number;
          sum_price?: number;
          atbs?: number;
        }>;
      }>;
      
      let data: StatsResponse;
      try {
        const ids = batch.join(',');
        const beginDate = dates[0];
        const endDate = dates[dates.length - 1];
        data = await wbGetJson<StatsResponse>(
          `https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${ids}&beginDate=${beginDate}&endDate=${endDate}`,
          apiKey
        );
      } catch (err) {
        logger.warn({ err }, 'Failed to fetch stats for batch');
        continue;
      }

      for (const item of data) {
        // Aggregate stats across all days
        const allDays = item.days || [];
        if (allDays.length === 0) continue;

        // Sum up metrics across days
        let totalViews = 0;
        let totalClicks = 0;
        let totalSpend = 0;
        let totalOrders = 0;
        let totalOrderSum = 0;

        for (const day of allDays) {
          totalViews += day.views || 0;
          totalClicks += day.clicks || 0;
          totalSpend += day.sum || 0;
          totalOrders += day.orders || 0;
          totalOrderSum += day.sum_price || 0;
        }

        // Calculate averages for rates
        const avgCtr = totalViews > 0 ? (totalClicks / totalViews) * 100 : 0;
        const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

        stats.set(item.advertId, {
          views: totalViews,
          clicks: totalClicks,
          ctr: avgCtr,
          cpc: avgCpc,
          spend: totalSpend,
          orders: totalOrders,
          orderSum: totalOrderSum,
          drr: totalOrderSum > 0 ? (totalSpend / totalOrderSum) * 100 : 0,
        });
      }

      // Rate limiting
      if (i + 10 < campaignIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch stats');
  }

  return stats;
}

/**
 * Check budget alerts for campaigns and send notifications
 */
async function checkBudgetAlerts(
  workspaceId: number,
  campaigns: CampaignInfo[],
  stats: Map<number, CampaignStats>,
  settings: any
): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const campaign of campaigns) {
    const campaignStats = stats.get(campaign.advertId);
    if (!campaignStats || !campaign.dailyBudget) continue;

    const spentPercent = (campaignStats.spend / campaign.dailyBudget) * 100;
    const budgetRemaining = campaign.dailyBudget - campaignStats.spend;

    // Determine alert level
    let alertType: string | null = null;
    let severity: 'info' | 'warning' | 'critical' = 'info';
    let title = '';
    let message = '';

    if (spentPercent >= 100) {
      alertType = 'daily_limit';
      severity = 'critical';
      title = `🛑 Бюджет исчерпан: ${campaign.name}`;
      message = `Кампания "${campaign.name}" израсходовала дневной бюджет.\nПотрачено: ${formatMoney(campaignStats.spend)} из ${formatMoney(campaign.dailyBudget)}`;
    } else if (spentPercent >= 90) {
      alertType = 'budget_critical';
      severity = 'warning';
      title = `⚠️ Бюджет почти исчерпан: ${campaign.name}`;
      message = `Кампания "${campaign.name}" израсходовала ${Math.round(spentPercent)}% бюджета.\nОсталось: ${formatMoney(budgetRemaining)} из ${formatMoney(campaign.dailyBudget)}`;
    } else if (spentPercent >= 80) {
      alertType = 'budget_low';
      severity = 'info';
      title = `📊 Бюджет расходуется: ${campaign.name}`;
      message = `Кампания "${campaign.name}" израсходовала ${Math.round(spentPercent)}% бюджета.\nОсталось: ${formatMoney(budgetRemaining)}`;
    }

    if (!alertType) continue;

    // Check if we already sent this alert today (deduplication)
    const existingAlert = await db
      .select({ alertId: bidderAlerts.alertId })
      .from(bidderAlerts)
      .where(
        and(
          eq(bidderAlerts.workspaceId, workspaceId),
          eq(bidderAlerts.campaignId, campaign.advertId),
          eq(bidderAlerts.alertType, alertType),
          gte(bidderAlerts.createdAt, new Date(today))
        )
      )
      .limit(1);

    if (existingAlert.length > 0) continue; // Already alerted today

    // Create alert
    const context = {
      dailyBudget: campaign.dailyBudget,
      spent: campaignStats.spend,
      spentPercent: Math.round(spentPercent),
      remaining: budgetRemaining,
      drr: campaignStats.drr,
      orders: campaignStats.orders,
    };

    await db.insert(bidderAlerts).values({
      workspaceId,
      campaignId: campaign.advertId,
      alertType,
      severity,
      title,
      message,
      context,
      notifiedAt: settings.notifyTelegram && settings.telegramChatId ? now : null,
    });

    logger.info({ alertType, campaignId: campaign.advertId }, 'Created budget alert');

    // Send Telegram notification
    if (settings.notifyTelegram && settings.telegramChatId) {
      try {
        const telegramText = `${title}\n\n${message}\n\n` +
          `📈 Заказов: ${campaignStats.orders}\n` +
          `💰 DRR: ${campaignStats.drr.toFixed(1)}%`;

        await sendTelegramMessage(settings.telegramChatId, telegramText);
        logger.info({ telegramChatId: settings.telegramChatId }, 'Sent Telegram alert');
      } catch (err) {
        logger.error({ err }, 'Failed to send Telegram alert');
      }
    }
  }
}

/**
 * Format money in rubles
 */
function formatMoney(kopecks: number): string {
  const rubles = kopecks / 100;
  return new Intl.NumberFormat('ru-RU', { 
    style: 'currency', 
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(rubles);
}
