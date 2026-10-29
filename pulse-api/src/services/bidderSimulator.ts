/**
 * Bidder Rule Simulator (Промпт #4, 2026-05-31)
 *
 * Возвращает прогноз эффекта правила биддера ДО применения.
 * Опирается на wb_adv_daily_products за последние 7 дней + количество
 * активных кампаний в wb_campaigns.
 *
 * Важно: это симуляция, не точный прогноз. В UI помечено как
 * «приблизительный». Если данных нет — отдаём пустой прогноз с warning.
 */

import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbAdvDailyProducts, wbCampaigns } from '../db/schema.js';
import { log as rootLog } from '../lib/logger.js';

const log = rootLog.child({ module: 'bidder-simulator' });

export interface RuleConfig {
  ruleType: 'drr_target' | 'position_target' | 'budget_limit' | 'time_schedule' | 'cpm_range';
  conditions?: {
    targetDrr?: number;
    targetPosition?: number;
    maxBudget?: number;
    minCpm?: number;
    maxCpm?: number;
  };
  actionType: 'set' | 'increase' | 'decrease' | 'increase_percent' | 'decrease_percent';
  actionValue: number;
  activeHours?: number[];
  activeDays?: number[];
  targetType?: 'all' | 'search' | 'catalog' | 'auto';
}

export interface SimulationResult {
  /** Текущий средний расход за 7 дней (₽/день) */
  currentDailySpend: number;
  /** Прогноз расхода после применения правила (₽/день) */
  estimatedDailySpend: number;
  /** Прогноз экономии в процентах (положит. = экономия, отриц. = рост) */
  estimatedSavingsPct: number;
  /** Warning'и для пользователя */
  warnings: string[];
  /** Короткая метка методологии — для отладки */
  basis: string;
}

export async function simulateBidderRule(
  workspaceId: number,
  rule: RuleConfig,
): Promise<SimulationResult> {
  // 1) Базовый расход за 7 дней (из wb_adv_daily_products, агрегат по дате)
  const rows = await db.execute(sql`
    SELECT
      date,
      SUM(spend_kopecks)::bigint    AS spend_kop,
      SUM(sum_price_kopecks)::bigint AS rev_kop,
      SUM(orders_count)::bigint     AS orders
    FROM wb_adv_daily_products
    WHERE workspace_id = ${workspaceId}
      AND date::date >= CURRENT_DATE - 7
    GROUP BY date
  `);

  const dataRows = (rows as any).rows ?? [];

  if (dataRows.length === 0) {
    return {
      currentDailySpend: 0,
      estimatedDailySpend: 0,
      estimatedSavingsPct: 0,
      warnings: ['Нет данных за 7 дней — прогноз невозможен. Биддер начнёт работать после первого часа.'],
      basis: 'no-data',
    };
  }

  const totalSpendRub = dataRows.reduce((s: number, r: any) => s + Number(r.spend_kop ?? 0) / 100, 0);
  const totalRevRub = dataRows.reduce((s: number, r: any) => s + Number(r.rev_kop ?? 0) / 100, 0);
  const avgDailySpend = totalSpendRub / 7;
  const currentDrr = totalRevRub > 0 ? (totalSpendRub / totalRevRub) * 100 : 0;

  // 2) Активные кампании (для budget_limit)
  const campaignsRow = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(wbCampaigns)
    .where(and(
      eq(wbCampaigns.workspaceId, workspaceId),
      sql`${wbCampaigns.status} IN (9, 11)`, // 9=ready, 11=active
    ));
  const campaignCount = Number(campaignsRow[0]?.cnt ?? 1) || 1;

  let estimated = avgDailySpend;
  const warnings: string[] = [];
  let basis = '';

  switch (rule.ruleType) {
    case 'drr_target': {
      const targetDrr = rule.conditions?.targetDrr ?? 20;
      if (currentDrr === 0) {
        warnings.push('Нет выручки с рекламы за 7 дней — биддер первое время не сможет посчитать ДРР.');
        estimated = avgDailySpend * 0.95;
        basis = 'drr-no-revenue';
      } else if (currentDrr > targetDrr) {
        const overshoot = Math.min(1, currentDrr / targetDrr - 1);
        const effectiveDailyCut = Math.min(0.4, (rule.actionValue / 100) * (0.3 + overshoot * 0.7));
        estimated = avgDailySpend * (1 - effectiveDailyCut);
        basis = `drr-cut (current ${currentDrr.toFixed(1)}% > target ${targetDrr}%)`;
        if (currentDrr > targetDrr * 2) {
          warnings.push(`Твой ДРР (${currentDrr.toFixed(0)}%) сильно выше цели (${targetDrr}%). Биддер начнёт активно резать ставки первые 2–3 дня.`);
        }
      } else {
        warnings.push(`Твой ДРР (${currentDrr.toFixed(1)}%) уже ≤ цели (${targetDrr}%). Биддер будет аккуратно поднимать ставки.`);
        estimated = avgDailySpend * 1.05;
        basis = 'drr-already-good';
      }
      break;
    }

    case 'position_target': {
      if (rule.actionType.startsWith('increase')) {
        const growth = (rule.actionValue / 100) * 0.5;
        estimated = avgDailySpend * (1 + growth);
        warnings.push('Этот шаблон поднимает ставки. Готовься к временно высокому ДРР первые 3–7 дней.');
        basis = `position-growth (+${(growth * 100).toFixed(0)}%)`;
      } else {
        estimated = avgDailySpend * (1 - (rule.actionValue / 100) * 0.3);
        basis = 'position-reduce';
      }
      break;
    }

    case 'budget_limit': {
      const maxBudgetPerCampaign = rule.conditions?.maxBudget ?? 2000;
      const theoreticalCap = maxBudgetPerCampaign * campaignCount;
      if (avgDailySpend > theoreticalCap) {
        estimated = theoreticalCap;
        warnings.push(`Будет ограничено: ${maxBudgetPerCampaign}₽ × ${campaignCount} кампаний = ${theoreticalCap.toFixed(0)}₽/день.`);
      } else {
        estimated = avgDailySpend * 0.95;
        warnings.push('Твой текущий расход уже в пределах лимита — биддер просто подстрахует.');
      }
      basis = `budget-cap (${campaignCount} campaigns × ${maxBudgetPerCampaign}₽)`;
      break;
    }

    case 'time_schedule': {
      const hoursActive = rule.activeHours?.length ?? 24;
      const coverage = hoursActive / 24;
      const trim = (rule.actionValue / 100) * 0.3;
      estimated = avgDailySpend * (coverage * (1 - trim) + (1 - coverage));
      basis = `schedule (${hoursActive}/24 hours)`;
      break;
    }

    case 'cpm_range': {
      estimated = avgDailySpend * 0.97;
      warnings.push('Точный прогноз для CPM-диапазона зависит от текущих ставок каждой кампании.');
      basis = 'cpm-range-approx';
      break;
    }

    default:
      estimated = avgDailySpend;
      basis = 'unknown';
  }

  const savings = avgDailySpend > 0 ? ((avgDailySpend - estimated) / avgDailySpend) * 100 : 0;

  if (Math.abs(savings) > 60) {
    warnings.push('Прогноз показывает большое отклонение — это редкий случай, реальный результат может отличаться.');
  }

  log.info({ workspaceId, ruleType: rule.ruleType, avgDailySpend, estimated, savings, basis }, 'Simulated bidder rule');

  return {
    currentDailySpend: Math.round(avgDailySpend),
    estimatedDailySpend: Math.round(estimated),
    estimatedSavingsPct: Math.round(savings * 10) / 10,
    warnings,
    basis,
  };
}
