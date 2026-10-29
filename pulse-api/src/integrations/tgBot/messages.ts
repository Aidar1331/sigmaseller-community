/**
 * HTML message builders. Kept separate from `data.ts` (pure SQL) and
 * `menus.ts` (pure keyboards) so unit-testing the formatting later is
 * trivial — feed in a fixture, compare strings.
 */

import { TRIGGER_LABEL_RU } from './menus.js';
import {
  shopRangeAggregate, shopDailySnapshot, shopTopProducts, shopLowStockProducts,
  type ShopDaySummary, type TopProductRow, type LowStockRow,
} from './data.js';

const ruMoneyFmt = new Intl.NumberFormat('ru-RU');
function fmtRub(rub: number): string {
  const abs = Math.abs(rub);
  if (abs >= 1_000_000) return `${(rub / 1_000_000).toFixed(2).replace(/\.?0+$/, '')} млн ₽`;
  if (abs >= 100_000) return `${Math.round(rub / 1000)}k ₽`;
  return `${ruMoneyFmt.format(Math.round(rub))} ₽`;
}

/**
 * Format an nm_id as a clickable WB link (rev 27k.2). Tapping opens the
 * product page in the WB website / app. Used wherever we surface `nm <id>`
 * in HTML cards so the user can verify what we're talking about.
 */
export function nmLink(nmId: number | null | undefined): string {
  if (!nmId) return '';
  return `<a href="https://www.wildberries.ru/catalog/${nmId}/detail.aspx">артикул ${nmId}</a>`;
}

function ruRelDate(date: string): string {
  // Crude — uses date-string lexicographic comparison. Good enough for
  // today/yesterday labels.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (date === today) return 'Сегодня';
  if (date === yesterday) return 'Вчера';
  return date;
}

const PERIOD_RU: Record<string, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  '7d': 'Последние 7 дней',
  '30d': 'Последние 30 дней',
};

export function periodToDates(period: string): { dateFrom: string; dateTo: string; isRange: boolean } {
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  const isoYesterday = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (period === 'today') return { dateFrom: isoToday, dateTo: isoToday, isRange: false };
  if (period === 'yesterday') return { dateFrom: isoYesterday, dateTo: isoYesterday, isRange: false };
  if (period === '7d') {
    const from = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    return { dateFrom: from, dateTo: isoYesterday, isRange: true };
  }
  if (period === '30d') {
    const from = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    return { dateFrom: from, dateTo: isoYesterday, isRange: true };
  }
  return { dateFrom: isoToday, dateTo: isoToday, isRange: false };
}

export async function buildShopDashboard(
  workspaceId: number,
  shopId: number,
  shopName: string,
  period: string,
): Promise<string> {
  const { dateFrom, dateTo, isRange } = periodToDates(period);

  let summary: ShopDaySummary | null;
  if (isRange) {
    summary = await shopRangeAggregate(workspaceId, shopId, dateFrom, dateTo);
  } else {
    summary = await shopDailySnapshot(workspaceId, shopId, dateFrom);
  }

  const lines: string[] = [];
  lines.push(`🏪 <b>${shopName}</b> · ${PERIOD_RU[period] ?? period}`);

  if (!summary) {
    lines.push('');
    lines.push('<i>За этот период данных пока нет.</i>');
    lines.push('<i>Данные на сайте обновляются по утрам и в течение дня.</i>');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`📦 Заказов: <b>${summary.ordersCount}</b> на <b>${fmtRub(summary.ordersRub)}</b>`);
  lines.push(`💰 Выкуплено: <b>${summary.salesCount}</b> на <b>${fmtRub(summary.salesRub)}</b>`);
  if (summary.buyoutPct !== null && summary.ordersCount > 0) {
    lines.push(`🎯 Процент выкупа: <b>${summary.buyoutPct.toFixed(0)}%</b>`);
  }

  // For single-day views we also fetch top products + low stock.
  if (!isRange) {
    const top = await shopTopProducts(workspaceId, shopId, dateFrom, 3);
    if (top.length > 0) {
      lines.push('');
      lines.push('🔥 <b>Топ-3 по выручке</b>');
      top.forEach((p: TopProductRow, i: number) => {
        const title = p.title.length > 40 ? p.title.slice(0, 40) + '…' : p.title;
        lines.push(`${i + 1}. ${title}`);
        lines.push(`   ${p.salesCount} шт / ${fmtRub(p.salesRub)}`);
      });
    }

    const lowStock = await shopLowStockProducts(workspaceId, shopId, 5, 5);
    if (lowStock.length > 0) {
      lines.push('');
      lines.push('⚠️ <b>Скоро закончится</b>');
      lowStock.forEach((p: LowStockRow) => {
        const title = p.title.length > 35 ? p.title.slice(0, 35) + '…' : p.title;
        lines.push(`• ${title}`);
        lines.push(`   остаток ${p.quantity} шт, темп ${p.avgDaily.toFixed(1)}/день → <b>${p.daysLeft.toFixed(1)} дн.</b>`);
      });
    }
  }

  return lines.join('\n');
}

export function buildAlertsOverview(totalPending: number, groupCount: number): string {
  if (totalPending === 0) {
    return '✅ <b>Всё чисто!</b>\n\nНет активных алёртов мониторинга.';
  }
  return [
    `🔔 <b>Алёрты мониторинга</b>`,
    '',
    `Всего активных: <b>${totalPending}</b> в ${groupCount} ${groupCount === 1 ? 'группе' : 'группах'}.`,
    '',
    '<i>Тапни группу ниже, чтобы развернуть.</i>',
    '<i>Группы с критичной важностью — наверху.</i>',
  ].join('\n');
}

import type { AlertItemRow, AlertItemDetail } from './data.js';

const SEV_DOT: Record<string, string> = {
  critical: '🔴',
  high: '🟡',
  medium: '🟠',
  info: '🔵',
};

/**
 * Header for the alert-group drill-down — short, scannable.
 *
 * The screen real estate above the buttons should communicate:
 *   1. Which trigger this is (label + severity dot)
 *   2. How many items
 *   3. Total expected-loss roll-up (when computable) — gives motivation
 *   4. One-liner explaining what the tapping below does
 *
 * NO per-item bullets here. Items are clickable buttons (one per row)
 * via alertGroupDetailMenu — keeps the message compact, makes each item
 * a first-class touch target.
 */
export function buildAlertGroupHeader(
  trigger: string,
  items: AlertItemRow[],
  severityHint?: string,
): string {
  const label = TRIGGER_LABEL_RU[trigger] ?? trigger;
  const dot = SEV_DOT[severityHint ?? items[0]?.severity ?? 'info'] ?? '⚪';
  const totalLoss = items.reduce((s, it) => s + (it.potentialLossRub ?? 0), 0);
  const lines: string[] = [];
  lines.push(`${dot} <b>${label}</b>`);
  lines.push(`${items.length} ${items.length === 1 ? 'товар' : items.length < 5 ? 'товара' : 'товаров'}`);
  if (totalLoss > 0) {
    lines.push(`💸 Потенциальные потери: <b>~${fmtRub(totalLoss)}/мес</b>`);
  }
  lines.push('');
  lines.push('<i>Тапни товар — карточка с действиями.</i>');
  return lines.join('\n');
}

/**
 * Per-trigger "what it means" + "what to do" lookups (rev 26f).
 * Helps the user understand the alert at a glance instead of staring at raw
 * metrics. Kept compact: each entry ≤ 100 chars so the card stays one-screen.
 */
const TRIGGER_MEANS: Record<string, string> = {
  stock_zero: 'товар закончился, продажи остановились.',
  stock_critical: 'остатков хватит на ≤3 дня по текущей скорости продаж.',
  stock_low: 'остатки приближаются к критическому уровню (5-10 дней).',
  stock_excess: 'товар лежит дольше нормы — замораживает оборотный капитал.',
  stock_forecast_oos: 'по прогнозу товар закончится в ближайшую неделю.',
  buyout_drop: 'покупатели чаще отказываются от заказа на пункте выдачи.',
  sales_drop_daily: 'дневные заказы упали относительно недельного среднего.',
  sales_drop_weekly: 'неделя к неделе заказы значимо снизились.',
  sales_spike: 'резкий рост заказов — возможен дефицит товара.',
  returns_spike: 'процент возвратов вырос — повод проверить качество и описание.',
  adv_drr_high: 'ДРР выше нормы — реклама съедает маржу.',
  adv_zero_orders: 'кампания крутится, но не приносит заказов.',
  adv_budget_exhausted: 'бюджет рекламной кампании исчерпан.',
  adv_ctr_drop: 'CTR упал — креатив или таргетинг устарели.',
  adv_cpc_spike: 'CPC вырос — выросла конкуренция в ставках.',
  price_competitor_lower: 'конкурент демпингует — твоя цена менее привлекательна.',
  price_margin_negative: 'после комиссий и логистики продажа уходит в минус.',
  price_spp_change: 'WB поменял свою скидку — твоя витринная цена меняется без твоего участия.',
  price_commission_change: 'WB поменял комиссию — пересчитай юнит-экономику.',
  content_negative_review: 'появился новый негативный отзыв.',
  content_rating_drop: 'средний рейтинг товара упал.',
  content_seo_position_drop: 'позиция по ключу значимо просела — товар стал хуже находиться.',
};

const TRIGGER_ACTIONS: Record<string, string> = {
  stock_zero: 'сформируй поставку срочно. Параллельно проверь товары-замены в той же категории.',
  stock_critical: 'запусти поставку сегодня, остатков мало.',
  stock_low: 'запланируй поставку на ближайшие 3-5 дней.',
  stock_excess: 'снизь цену / запусти акцию / переложи на FBS для скидки на хранение.',
  stock_forecast_oos: 'запланируй поставку, чтобы избежать дыры в продажах.',
  buyout_drop: 'проверь карточку (фото, размерная сетка), отзывы и описание. Возможно, есть искажение ожиданий.',
  sales_drop_daily: 'проверь алёрты по этому товару и SEO-позиции — обычно одно из этого упало.',
  sales_drop_weekly: 'комплексный разбор: трафик/конверсия/цена/конкуренты.',
  sales_spike: 'проверь остатки — успеешь ли продать без OOS.',
  returns_spike: 'разбери причины возвратов в отзывах. Часто — несоответствие фото/описания.',
  adv_drr_high: 'снизь ставку или поставь кампанию на паузу.',
  adv_zero_orders: 'проверь ставку и таргетинг.',
  adv_budget_exhausted: 'добавь бюджет или пересмотри стратегию.',
  adv_ctr_drop: 'обнови креатив (главное фото, заголовок).',
  adv_cpc_spike: 'снизь максимальную ставку, либо переориентируйся на менее конкурентные ключи.',
  price_competitor_lower: 'проверь, можешь ли подвинуть цену без ухода в минус.',
  price_margin_negative: 'подними цену или уменьши логистические затраты.',
  price_spp_change: 'пересмотри цену с учётом новой скидки WB.',
  price_commission_change: 'обнови юнит-экономику и при необходимости подними цену.',
  content_negative_review: 'ответь быстро через /feedback — публичный ответ повышает доверие.',
  content_rating_drop: 'проанализируй последние негативные отзывы — там обычно вся история.',
  content_seo_position_drop: 'проверь, не изменился ли заголовок/описание. Запусти A/B тест фото.',
};

/**
 * Per-event detail card — opened when user taps an item in the group list.
 * rev 26f: added "Что это значит" + "Что делать" sections per trigger.
 */
export function buildEventCard(detail: AlertItemDetail): string {
  const dot = SEV_DOT[detail.severity] ?? '⚪';
  const groupLabel = TRIGGER_LABEL_RU[detail.trigger] ?? detail.trigger;
  const lines: string[] = [];
  lines.push(`${dot} <b>${groupLabel}</b>`);
  lines.push('');
  // Title carries the WB nomenclature title verbatim — trust the data.
  lines.push(`📦 <b>${detail.title}</b>`);
  if (detail.nmId) lines.push(`<i>${nmLink(detail.nmId)}</i>`);
  lines.push('');
  if (detail.qty != null) {
    lines.push(`Текущий остаток: <b>${detail.qty} шт</b>`);
  }
  if (detail.avgDaily != null && detail.avgDaily > 0) {
    lines.push(`Темп продаж: <b>${detail.avgDaily.toFixed(1)} шт/день</b>`);
  }
  if (detail.qty != null && detail.avgDaily != null && detail.avgDaily > 0) {
    const days = detail.qty / detail.avgDaily;
    if (days < 30) {
      lines.push(`Хватит на: <b>${days < 1 ? 'меньше дня' : `${days.toFixed(1)} дн.`}</b>`);
    }
  }
  if (detail.potentialLossRub != null && detail.potentialLossRub > 0) {
    lines.push(`Потенциальные потери: <b>~${fmtRub(detail.potentialLossRub)}/мес</b>`);
  }
  if (detail.description) {
    lines.push('');
    lines.push(`<i>${detail.description}</i>`);
  }
  // rev 26f: explain what the alert means in plain language.
  const meansText = TRIGGER_MEANS[detail.trigger];
  if (meansText) {
    lines.push('');
    lines.push(`🤔 <b>Что это значит:</b> ${meansText}`);
  }
  // rev 26f: tell the user what to do. If we have a concrete suggested_action,
  // prefer the action-specific wording (apply button label below); otherwise
  // fall back to the trigger-generic recipe.
  if (detail.suggestedAction) {
    const explain: Record<string, string> = {
      restock: 'жми «📦 Заказать поставку» — попадёт в очередь поставок (с подтверждением).',
      reprice: 'жми «💰 Изменить цену» — действие в pending-режиме до подтверждения.',
      pause_ads: 'жми «⏸️ Приостановить рекламу» — кампании остановятся.',
      reply_review: 'жми «💬 Ответить» — соберу AI-черновик за тебя.',
    };
    lines.push('');
    lines.push(`⚡ <b>Что делать:</b> ${explain[detail.suggestedAction] ?? detail.suggestedAction}`);
  } else {
    const actionText = TRIGGER_ACTIONS[detail.trigger];
    if (actionText) {
      lines.push('');
      lines.push(`⚡ <b>Что делать:</b> ${actionText}`);
    }
  }
  return lines.join('\n');
}

/**
 * /today triage card (rev 27a). Replaces the old placeholder that only
 * opened the main menu. Shows: top-3 critical events (by potential loss),
 * group counts, and a mini-dashboard of orders/revenue/buyout for today.
 */
import type { TopCriticalRow, AlertGroupRow as TodayAlertGroupRow, DayAggregateRow } from './data.js';
import { TRIGGER_LABEL_RU as TRIGGER_LABEL_RU_LOCAL } from './menus.js';

export function buildTodayCard(
  topCritical: TopCriticalRow[],
  groups: TodayAlertGroupRow[],
  today: DayAggregateRow | null,
  yesterday: DayAggregateRow | null,
  shopName?: string,
): string {
  const lines: string[] = [];
  const scope = shopName ? ` · ${shopName}` : '';
  lines.push(`📊 <b>Сегодня${scope}</b>`);
  lines.push('');

  // 1) Top-3 critical — what's burning right now
  if (topCritical.length > 0) {
    lines.push(`🔴 <b>Критично: ${topCritical.length}</b>`);
    for (const c of topCritical) {
      const where = c.shopName ? ` · ${c.shopName}` : '';
      const loss = c.potentialLossRub != null && c.potentialLossRub > 0
        ? ` — теряем ~${fmtRub(c.potentialLossRub / 30)}/день`
        : '';
      const triggerLabel = TRIGGER_LABEL_RU_LOCAL[c.trigger] ?? c.trigger;
      const titleShort = c.title.length > 38 ? c.title.slice(0, 37) + '…' : c.title;
      lines.push(`• <b>${escapeHtmlSafe(titleShort)}</b>${where}`);
      lines.push(`  <i>${triggerLabel}${loss}</i>`);
    }
    lines.push('');
  } else {
    lines.push('✅ <b>Критичных событий нет</b>');
    lines.push('');
  }

  // 2) Group counts (severity ≠ critical or critical that fell off top-3)
  const remaining = groups.filter((g) => g.severity !== 'critical' || g.count > 0);
  const total = remaining.reduce((s, g) => s + g.count, 0);
  if (total > 0) {
    lines.push(`🟡 <b>Ещё: ${total}</b>`);
    for (const g of remaining.slice(0, 4)) {
      const label = TRIGGER_LABEL_RU_LOCAL[g.trigger] ?? g.trigger;
      const dot = g.severity === 'critical' ? '🔴' : g.severity === 'high' ? '🟡' : g.severity === 'medium' ? '🟠' : '🔵';
      lines.push(`${dot} ${label} · <b>${g.count}</b>`);
    }
    if (remaining.length > 4) lines.push(`<i>… и ещё ${remaining.length - 4} групп</i>`);
    lines.push('');
  }

  // 3) Daily mini-dashboard
  if (today) {
    const deltaPct = yesterday && yesterday.ordersCount > 0
      ? ((today.ordersCount - yesterday.ordersCount) / yesterday.ordersCount) * 100
      : null;
    const arrow = deltaPct != null
      ? (deltaPct > 0 ? `📈 +${deltaPct.toFixed(0)}%` : deltaPct < 0 ? `📉 ${deltaPct.toFixed(0)}%` : '—')
      : '';
    lines.push(`📈 <b>Сегодняшняя сводка:</b>`);
    lines.push(`Заказы: <b>${today.ordersCount}</b> ${arrow}`);
    lines.push(`Выручка: <b>${fmtRub(today.ordersRub)}</b>`);
    if (today.buyoutPct != null) {
      lines.push(`Выкуп: <b>${today.buyoutPct.toFixed(0)}%</b>`);
    }
  }
  return lines.join('\n');
}

function escapeHtmlSafe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function welcomeMessage(displayName?: string): string {
  const name = displayName ? `, ${displayName}` : '';
  return [
    `🌅 <b>Привет${name}!</b>`,
    '',
    'Я бот <b>SigmaSeller</b> — твой второй экран по магазинам на Wildberries.',
    '',
    '<b>Что я умею:</b>',
    '📊 показывать сводку и алёрты',
    '💰 предлагать цены и применять их в один тап',
    '📦 формировать черновики поставок по low-stock',
    '💬 готовить AI-черновик ответа на отзыв',
    '📈 показывать движение SEO позиций',
    '📊 ABC-анализ и юнит-экономику товара',
    '🧪 статус A/B-тестов фотографий',
    '',
    'Базовый набор: /today /shops /alerts /help.',
    'Полный список — кнопка «Все команды» в меню Telegram.',
    'Или просто напиши вопрос — я отвечу с данными из твоего кабинета.',
    '',
    'Меню ниже 👇',
  ].join('\n');
}

export function helpMessage(): string {
  return [
    'ℹ️ <b>SigmaSeller Bot — что умеет</b>',
    '',
    '📊 <b>Сводки</b>',
    '— Утренняя автоматическая сводка в 9:00 МСК',
    '— Команда /today показывает текущее состояние по всем твоим магазинам',
    '',
    '🏪 <b>Магазины</b>',
    '— /shops · выбрать магазин → дашборд за сегодня/вчера/7д/30д',
    '— Топ товаров по выручке',
    '— Что скоро закончится (на основе скорости продаж)',
    '',
    '🔔 <b>Алёрты</b>',
    '— /alerts · активные предупреждения мониторинга',
    '— Группировка по типу проблемы, развёрнутый список по тапу',
    '',
    '📈 <b>SEO позиции</b>',
    '— /seo · топ ключей и движение позиций за сутки',
    '',
    '💬 <b>Отзывы</b>',
    '— /feedback · негативные отзывы без ответа, черновик ответа от AI',
    '',
    '📦 <b>Поставки</b>',
    '— /supplies · черновик поставки для товаров с низким остатком',
    '',
    '💰 <b>Цены</b>',
    '— /prices · ценовые рекомендации, применение в один тап',
    '',
    '📊 <b>ABC-анализ</b>',
    '— /abc · категории A/B/C, мёртвый груз, рекомендации',
    '',
    '🧪 <b>A/B-тесты</b>',
    '— /abtests · статистика по фото-тестам, объявить победителя',
    '',
    '📊 <b>Юнит-экономика</b>',
    '— /unit &lt;nm_id&gt; · маржа и прибыль по товару за 30 дней',
    '',
    '⚙️ <b>Прочее</b>',
    '— /settings · настройки уведомлений (скоро)',
    '— /unsub · отписаться от утренних сводок',
    '',
    'Поддержка: пиши службу поддержки.',
  ].join('\n');
}

// ============================================================================
// Unit economics (rev 25t)
// ============================================================================

export interface UnitEconReport {
  nmId: number;
  period: { from: string; to: string };
  qtySold: number;
  perUnit: {
    revenueKop: number;
    logisticsKop: number;
    commissionKop: number;
    penaltyKop: number;
    cogsKop: number;
    totalCostsKop: number;
    profitKop: number;
    marginPct: number;
    roi: number;
  };
  error?: string;
}

export function buildUnitEconomicsCard(title: string, data: UnitEconReport): string {
  if (data.error) {
    return `📊 <b>Юнит-экономика · ${data.nmId ? nmLink(data.nmId) : '?'}</b>\n\n⚠️ ${data.error}`;
  }
  const u = data.perUnit;
  const lines: string[] = [];
  lines.push(`📊 <b>Юнит-экономика · ${escapeHtml(title.length > 50 ? title.slice(0, 49) + '…' : title)}</b>`);
  lines.push(`<i>${nmLink(data.nmId)} · 30 дней · продано ${data.qtySold} шт</i>`);
  lines.push('');
  lines.push('<pre>');
  lines.push(`Выручка/шт:   ${fmtRub(Math.round(u.revenueKop / 100)).padStart(12)}`);
  lines.push(`Комиссия:     ${('-' + fmtRub(Math.round(u.commissionKop / 100))).padStart(12)}`);
  lines.push(`Логистика:    ${('-' + fmtRub(Math.round(u.logisticsKop / 100))).padStart(12)}`);
  lines.push(`Штрафы:       ${('-' + fmtRub(Math.round(u.penaltyKop / 100))).padStart(12)}`);
  lines.push(`Себестоим.:   ${('-' + fmtRub(Math.round(u.cogsKop / 100))).padStart(12)}`);
  lines.push(`────────────────────────────`);
  lines.push(`Прибыль/шт:   ${fmtRub(Math.round(u.profitKop / 100)).padStart(12)}`);
  lines.push(`Маржа:        ${(u.marginPct + '%').padStart(12)}`);
  lines.push(`ROI:          ${(u.roi + '%').padStart(12)}`);
  lines.push('</pre>');
  if (u.cogsKop === 0) {
    lines.push('');
    lines.push('<i>⚠️ Себестоимость = 0 — заполни в кабинете «Карточки → COGS», иначе маржа считается без учёта закупки.</i>');
  }
  return lines.join('\n');
}

// ============================================================================
// A/B tests (rev 25s)
// ============================================================================

import type { AbTestRow } from './data.js';
import type { AbVariantStats } from '../../services/abPhoto.js';

const AB_GOAL_RU: Record<string, string> = {
  orders: 'Заказы',
  ctr: 'CTR (открытия карточки)',
  revenue: 'Выручка',
};
const AB_STATUS_RU: Record<string, string> = {
  running: '🟢 идёт',
  paused: '⏸ пауза',
  completed: '✅ завершён',
};

export function buildAbTestsOverview(tests: AbTestRow[]): string {
  if (tests.length === 0) {
    return '🧪 <b>A/B-тесты</b>\n\n<i>Нет тестов. Запустить можно в кабинете → раздел «A/B фото».</i>';
  }
  const running = tests.filter((t) => t.status === 'running').length;
  const completed = tests.filter((t) => t.status === 'completed').length;
  const lines: string[] = [];
  lines.push('🧪 <b>A/B-тесты фотографий</b>');
  lines.push('');
  lines.push(`Идёт: <b>${running}</b> · Завершено: <b>${completed}</b>`);
  lines.push('<i>Тапни тест — открою статистику и кнопку «объявить победителя».</i>');
  return lines.join('\n');
}

export function buildAbTestCard(
  t: AbTestRow,
  stats: Record<'A' | 'B', AbVariantStats>,
  autoWinner: 'A' | 'B' | null,
): string {
  const status = AB_STATUS_RU[t.status] ?? t.status;
  const goal = AB_GOAL_RU[t.goal] ?? t.goal;
  const lines: string[] = [];
  lines.push(`🧪 <b>${escapeHtml(t.title.length > 60 ? t.title.slice(0, 59) + '…' : t.title)}</b>`);
  lines.push(`<i>${nmLink(t.nmId)}</i>`);
  lines.push('');
  lines.push(`Статус: ${status}`);
  lines.push(`Цель: <b>${goal}</b>`);
  lines.push(`Период: ${t.periodDays} дней`);
  if (t.winnerVariant) lines.push(`🏆 Победитель: <b>${t.winnerVariant}</b>`);
  else if (autoWinner) lines.push(`🤖 Авто-победитель: <b>${autoWinner}</b> <i>(можно подтвердить кнопкой)</i>`);
  lines.push('');
  lines.push('<pre>');
  lines.push('Метрика         A        B');
  lines.push('────────────────────────────');
  const fmt = (n: number) => String(n).padStart(8);
  const pct = (n: number | null) => (n != null ? `${(n * 100).toFixed(1)}%` : '   —  ').padStart(8);
  const rub = (n: number) => fmtRub(Math.round(n / 100)).padStart(8);
  lines.push(`Показы      ${fmt(stats.A.viewCount)} ${fmt(stats.B.viewCount)}`);
  lines.push(`Открытий    ${fmt(stats.A.openCardCount)} ${fmt(stats.B.openCardCount)}`);
  lines.push(`Заказы      ${fmt(stats.A.orderCount)} ${fmt(stats.B.orderCount)}`);
  lines.push(`CTR откр.   ${pct(stats.A.ctrOpen)} ${pct(stats.B.ctrOpen)}`);
  lines.push(`Выручка     ${rub(stats.A.revenueKopecks)} ${rub(stats.B.revenueKopecks)}`);
  lines.push('</pre>');
  return lines.join('\n');
}

// ============================================================================
// ABC analysis (rev 25r)
// ============================================================================

export interface AbcAnalysisData {
  period: string;
  totalProducts: number;
  totalRevenue: number;
  abcSummary: { A: number; B: number; C: number };
  deadStockCount: number;
  topProducts: Array<{ nmId: number; revenue: number; orders: number; sales: number; abc: string }>;
  deadStock: Array<{ nmId: number; revenue: number; orders: number; sales: number; abc: string }>;
  recommendations: string[];
}

export function buildAbcReport(data: AbcAnalysisData): string {
  const lines: string[] = [];
  lines.push(`📊 <b>ABC-анализ ассортимента · ${data.period}</b>`);
  lines.push('');
  lines.push(`Товаров всего: <b>${data.totalProducts}</b>`);
  lines.push(`Оборот: <b>${fmtRub(data.totalRevenue)}</b>`);
  lines.push('');
  lines.push(`<b>Категории по выручке (правило 80/15/5):</b>`);
  lines.push(`🟢 A · <b>${data.abcSummary.A}</b> товаров (80% оборота)`);
  lines.push(`🟡 B · <b>${data.abcSummary.B}</b> товаров (следующие 15%)`);
  lines.push(`🔴 C · <b>${data.abcSummary.C}</b> товаров (последние 5%)`);
  if (data.deadStockCount > 0) {
    lines.push(`💀 Без продаж за период: <b>${data.deadStockCount}</b>`);
  }
  if (data.topProducts.length > 0) {
    lines.push('');
    lines.push('<b>Топ-5 по выручке:</b>');
    for (const p of data.topProducts.slice(0, 5)) {
      lines.push(`• ${nmLink(p.nmId)} · ${fmtRub(p.revenue)} · ${p.sales} продаж`);
    }
  }
  if (data.deadStock.length > 0) {
    lines.push('');
    lines.push('<b>«Мёртвый груз» (без продаж):</b>');
    for (const p of data.deadStock.slice(0, 5)) {
      lines.push(`• ${nmLink(p.nmId)}`);
    }
  }
  if (data.recommendations.length > 0) {
    lines.push('');
    lines.push('<b>💡 Рекомендации:</b>');
    for (const r of data.recommendations) lines.push(`• ${r}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Pricing (rev 25q)
// ============================================================================

import type { PricingDecisionRow } from './data.js';

const PRICING_STRATEGY_RU: Record<string, string> = {
  maximize_profit: 'Максимизация прибыли',
  hold_supply: 'Удержание остатка',
  match_competitor: 'Догнать конкурента',
  clear_overstock: 'Распродажа излишков',
  flash_promo: 'Промо',
};

function fmtRubFromKop(kop: number): string {
  return fmtRub(Math.round(kop / 100));
}

export function buildPricingOverview(rows: PricingDecisionRow[]): string {
  if (rows.length === 0) {
    return '💰 <b>Цены</b>\n\n✅ Нет ожидающих рекомендаций. Алгоритм пересчитывает их раз в сутки.';
  }
  const lines: string[] = [];
  lines.push(`💰 <b>Ценовые рекомендации</b>`);
  lines.push('');
  lines.push(`Найдено: <b>${rows.length}</b> ожидающих решений.`);
  lines.push('<i>Тапни строку — открою карточку с подробностями и кнопкой «Применить».</i>');
  return lines.join('\n');
}

export function buildPricingDecisionCard(r: PricingDecisionRow): string {
  const strategy = PRICING_STRATEGY_RU[r.strategyType] ?? r.strategyType;
  const oldRub = Math.round(r.oldPriceKop / 100);
  const newRub = Math.round(r.newPriceKop / 100);
  const delta = newRub - oldRub;
  const deltaPct = oldRub > 0 ? Math.round((delta / oldRub) * 100) : 0;
  const arrow = delta > 0 ? '↗' : delta < 0 ? '↘' : '=';
  const lines: string[] = [];
  lines.push(`💰 <b>${escapeHtml(r.title.length > 60 ? r.title.slice(0, 59) + '…' : r.title)}</b>`);
  lines.push(`<i>${nmLink(r.nmId)}</i>`);
  lines.push('');
  lines.push(`Сейчас: <b>${fmtRubFromKop(r.oldPriceKop)}</b>`);
  lines.push(`Предлагаю: <b>${fmtRubFromKop(r.newPriceKop)}</b>  ${arrow} ${delta > 0 ? '+' : ''}${deltaPct}%`);
  lines.push('');
  // rev 27d: pricing transparency — strategy + reason promoted to own block.
  lines.push(`📐 <b>Почему эта цена:</b>`);
  lines.push(`Стратегия — ${strategy}.`);
  if (r.reason) {
    lines.push(escapeHtml(r.reason));
  } else {
    lines.push(`<i>Подробное обоснование появится в карточке после следующего обновления модели цен.</i>`);
  }
  lines.push('');
  lines.push('<i>Применение поставит задачу в WB. Новая цена появится в кабинете WB через ~5 минут.</i>');
  return lines.join('\n');
}

// ============================================================================
// Supplies (rev 25p)
// ============================================================================

import type { SupplyDraftRow, LowStockRow as _LowStockRow } from './data.js';

const SUPPLY_STATUS_RU: Record<string, string> = {
  draft: '📝 черновик',
  pending: '⏳ в очереди',
  confirmed: '✅ подтверждён',
  cancelled: '❌ отменён',
};

export function buildSuppliesOverview(drafts: SupplyDraftRow[], lowStockCount: number): string {
  const lines: string[] = [];
  lines.push('📦 <b>Поставки</b>');
  lines.push('');
  if (drafts.length > 0) {
    lines.push('<b>Активные черновики:</b>');
    for (const d of drafts) {
      const status = SUPPLY_STATUS_RU[d.status] ?? d.status;
      const name = d.name ? d.name : `#${d.draftId}`;
      lines.push(`• ${name} · ${status} · ${d.totalItems} поз. / ${d.totalQty} шт.`);
    }
    lines.push('');
  }
  if (lowStockCount > 0) {
    lines.push(`⚠️ Скоро закончится: <b>${lowStockCount}</b> ${lowStockCount === 1 ? 'товар' : lowStockCount < 5 ? 'товара' : 'товаров'}.`);
    lines.push('<i>Тапни товар ниже — создам черновик поставки.</i>');
  } else {
    lines.push('<i>Сейчас ни один товар не требует срочной поставки.</i>');
  }
  lines.push('');
  lines.push('<i>Черновик надо будет финализировать в кабинете SigmaSeller (выбрать склад, дату, упаковку).</i>');
  return lines.join('\n');
}

export function buildSupplyQuantityPrompt(
  productTitle: string,
  currentStock: number | null,
  avgDaily: number | null,
): string {
  const lines: string[] = [];
  lines.push(`📦 <b>${productTitle.length > 60 ? productTitle.slice(0, 59) + '…' : productTitle}</b>`);
  lines.push('');
  if (currentStock != null) lines.push(`Текущий остаток: <b>${currentStock} шт</b>`);
  if (avgDaily != null && avgDaily > 0) {
    lines.push(`Темп продаж: <b>${avgDaily.toFixed(1)} шт/день</b>`);
    if (currentStock != null) {
      const recommend = Math.max(10, Math.ceil(avgDaily * 30 - currentStock));
      lines.push(`Рекомендую: <b>≈${recommend} шт</b> (на 30 дней).`);
    }
  }
  lines.push('');
  lines.push('<b>Напиши число — сколько штук поставить:</b>');
  lines.push('<i>Например, 50</i>');
  return lines.join('\n');
}

export function buildSupplyCreated(draftId: number, title: string, quantity: number): string {
  return [
    `✅ <b>Черновик #${draftId} создан</b>`,
    '',
    `📦 ${title.length > 60 ? title.slice(0, 59) + '…' : title}`,
    `Количество: <b>${quantity} шт</b>`,
    '',
    '<b>Дальше:</b>',
    '• <b>Отправить в WB</b> — создам preorder через API, бот сам подберёт склад.',
    '• Или открой кабинет → «Поставки → Черновики» для ручной настройки.',
  ].join('\n');
}

export function buildSupplySubmitted(preorderID: number, warehouseName: string, title: string, quantity: number): string {
  return [
    `✅ <b>Поставка создана в Wildberries</b>`,
    '',
    `Preorder ID: <code>${preorderID}</code>`,
    `Склад: <b>${warehouseName}</b>`,
    `Товар: ${title.length > 50 ? title.slice(0, 49) + '…' : title}`,
    `Количество: <b>${quantity} шт</b>`,
    '',
    '<i>Перейди в кабинет WB → «Поставки» чтобы выбрать дату и оформить отгрузку.</i>',
  ].join('\n');
}

// ============================================================================
// Feedback / reviews (rev 25n)
// ============================================================================

import type { PendingReviewRow } from './data.js';

function ratingStars(rating: number | null): string {
  if (rating == null) return '☆☆☆☆☆';
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildReviewsOverview(count: number): string {
  if (count === 0) {
    return '💬 <b>Отзывы</b>\n\n✅ Нет неотвеченных негативных отзывов. Молодцы!';
  }
  return [
    '💬 <b>Негативные отзывы без ответа</b>',
    '',
    `Найдено: <b>${count}</b>. Тапни отзыв — открою карточку с AI-черновиком ответа.`,
  ].join('\n');
}

export function buildReviewCard(r: PendingReviewRow): string {
  const lines: string[] = [];
  lines.push(`${ratingStars(r.rating)} <b>${r.rating ?? '—'}/5</b>`);
  if (r.userName) lines.push(`<i>от ${escapeHtml(r.userName)}</i>`);
  lines.push('');
  if (r.productTitle) {
    const t = r.productTitle.length > 60 ? r.productTitle.slice(0, 59) + '…' : r.productTitle;
    lines.push(`📦 ${escapeHtml(t)}`);
    if (r.nmId) lines.push(`<i>${nmLink(r.nmId)}</i>`);
    lines.push('');
  }
  if (r.text) {
    const t = r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text;
    lines.push(`<b>Отзыв:</b>`);
    lines.push(escapeHtml(t));
  }
  if (r.cons) {
    lines.push('');
    lines.push(`<b>Минусы:</b> ${escapeHtml(r.cons)}`);
  }
  if (r.pros) {
    lines.push('');
    lines.push(`<b>Плюсы:</b> ${escapeHtml(r.pros)}`);
  }
  return lines.join('\n');
}

export function buildReviewDraftPreview(r: PendingReviewRow, draft: string): string {
  const lines: string[] = [];
  lines.push(`✍️ <b>AI-черновик ответа</b>`);
  lines.push(`${ratingStars(r.rating)} ${r.rating ?? '—'}/5 · ${escapeHtml(r.userName ?? 'покупатель')}`);
  lines.push('');
  lines.push('<i>Текст ответа:</i>');
  lines.push('');
  lines.push(escapeHtml(draft));
  lines.push('');
  lines.push('<i>Можно отправить как есть, или попросить ещё вариант.</i>');
  return lines.join('\n');
}

// ============================================================================
// SEO positions (rev 25m)
// ============================================================================

import type { KeywordPositionRow } from './data.js';

export function buildSeoList(rows: KeywordPositionRow[]): string {
  if (rows.length === 0) {
    return '📈 <b>SEO позиции</b>\n\n<i>Нет отслеживаемых ключей. Добавь их в кабинете → /seo.</i>';
  }
  const lines: string[] = [];
  lines.push(`📈 <b>SEO позиции</b> · топ-${Math.min(rows.length, 20)}`);
  lines.push('<i>Стрелка показывает движение позиции за сутки.</i>');
  lines.push('');
  lines.push('<pre>');
  lines.push('Ключ                       Позиция   Δ');
  lines.push('───────────────────────────────────────');
  for (const r of rows.slice(0, 20)) {
    const kw = r.keyword.length > 24 ? r.keyword.slice(0, 23) + '…' : r.keyword;
    const pos = r.latestPosition != null ? String(r.latestPosition).padStart(5) : '  —  ';
    let delta = '   =';
    if (r.delta != null && r.delta !== 0) {
      // delta > 0 = position got worse (number grew = lower in search)
      // delta < 0 = position improved
      delta = r.delta < 0 ? `↗${-r.delta}`.padStart(4) : `↘${r.delta}`.padStart(4);
    }
    lines.push(`${kw.padEnd(26)}${pos}  ${delta}`);
  }
  lines.push('</pre>');
  return lines.join('\n');
}
