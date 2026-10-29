/**
 * Inline-keyboard builders for the bot.
 *
 * grammY's `InlineKeyboard` API is fluent — `.text(label, callbackData).row()`
 * for layout. callback_data is encoded as `verb:arg1:arg2`. Verbs:
 *
 *   menu:main                      — back to root
 *   shops:list                     — list of user's shops
 *   shop:<shopId>:<period>         — per-shop dashboard, period one of
 *                                    today | yesterday | 7d | 30d
 *   alerts:list                    — alert-group overview
 *   settings                       — notification preferences (TODO rev 25f)
 *
 * Decoding is centralised in `parseCallback()` to keep handlers tidy.
 */

import { InlineKeyboard } from 'grammy';
import type { ShopRow, AlertGroupRow } from './data.js';

// Human-readable group labels for the 24 monitoring triggers — mirrors the
// triggerLabels map in pulse-web/src/app/task-monitor/page.tsx.
export const TRIGGER_LABEL_RU: Record<string, string> = {
  stock_zero: 'Нулевой остаток',
  stock_critical: 'Критически мало',
  stock_low: 'Мало товара',
  stock_excess: 'Избыток на WB (FBO)',
  stock_forecast_oos: 'Прогноз OOS',
  stock_warehouse_imbalance: 'Дисбаланс складов',
  stock_new_arrival: 'Поступление товара',
  sales_drop_daily: 'Падение заказов (день)',
  sales_drop_weekly: 'Падение заказов (неделя)',
  sales_spike: 'Всплеск заказов',
  buyout_drop: 'Падение выкупа',
  returns_spike: 'Всплеск возвратов',
  adv_drr_high: 'ДРР выше нормы',
  adv_zero_orders: 'Реклама без заказов',
  adv_budget_exhausted: 'Бюджет исчерпан',
  adv_ctr_drop: 'Падение CTR',
  adv_cpc_spike: 'Рост CPC',
  price_competitor_lower: 'Конкурент снизил цену',
  price_margin_negative: 'Отрицательная маржа',
  price_spp_change: 'Изменение СПП',
  price_commission_change: 'Изменение комиссии',
  content_negative_review: 'Негативный отзыв',
  content_rating_drop: 'Падение рейтинга',
  content_seo_position_drop: 'Падение SEO позиций',
};

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Сводка за сегодня', 'today').row()
    .text('🏪 Магазины', 'shops:list')
    .text('🔔 Алёрты', 'alerts:list').row()
    .text('📈 SEO позиции', 'seo:list')
    .text('💬 Отзывы', 'reviews:list').row()
    .text('📦 Поставки', 'supplies:list')
    .text('💰 Цены', 'prices:list').row()
    .text('📊 ABC-анализ', 'abc:30')
    .text('🧪 A/B-тесты', 'abtests:list').row()
    .text('⚙️ Настройки', 'settings');
}

export function seoBackMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
}

export function backToMain(): InlineKeyboard {
  return new InlineKeyboard().text('⬅️ Главное меню', 'menu:main');
}

export function shopsListMenu(shops: ShopRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of shops) {
    kb.text(`🏪 ${s.name}`, `shop:${s.shopId}:today`).row();
  }
  kb.text('⬅️ Главное меню', 'menu:main');
  return kb;
}

const PERIOD_LABEL: Record<string, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  '7d': '7 дней',
  '30d': '30 дней',
};

export function shopDashboardMenu(shopId: number, activePeriod: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Period switcher row — active period gets ⚫ marker
  for (const p of ['today', 'yesterday', '7d', '30d']) {
    const marker = p === activePeriod ? '⚫' : '⚪';
    kb.text(`${marker} ${PERIOD_LABEL[p]}`, `shop:${shopId}:${p}`);
  }
  kb.row();
  kb.text('🔄 Обновить данные', `refresh:${shopId}:${activePeriod}`).row();
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

const SEV_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟡',
  medium: '🟠',
  info: '🔵',
};

export function alertsListMenu(groups: AlertGroupRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (groups.length === 0) {
    kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
    return kb;
  }
  // Show top-8 groups in the inline keyboard; if more, mention in text.
  const top = groups.slice(0, 8);
  for (const g of top) {
    const label = TRIGGER_LABEL_RU[g.trigger] ?? g.trigger;
    const emoji = SEV_EMOJI[g.severity] ?? '⚪';
    kb.text(`${emoji} ${label} · ${g.count}`, `alerts:${g.trigger}`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

export interface AlertItemForMenu {
  eventId: number;
  title: string;
  potentialLossRub: number | null;
}

/**
 * Compact list view inside an alert group — each item is its OWN button
 * row (text shows truncated title + loss estimate where available, callback
 * opens the per-event card). Top-`visible` items shown; if there are more,
 * a stub "more" button reveals next page (TODO rev 25g).
 */
export function alertGroupDetailMenu(
  trigger: string,
  items: AlertItemForMenu[],
  visible = 8,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const top = items.slice(0, visible);
  for (let i = 0; i < top.length; i++) {
    const it = top[i];
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][i] ?? `${i + 1}.`;
    // Truncate title to fit visually; reserve ~10 chars for loss tag.
    const maxTitle = it.potentialLossRub != null ? 22 : 32;
    const shortTitle = it.title.length > maxTitle ? it.title.slice(0, maxTitle - 1) + '…' : it.title;
    const lossTag = it.potentialLossRub != null
      ? ` · ~${formatLossShort(it.potentialLossRub)}`
      : '';
    kb.text(`${num} ${shortTitle}${lossTag}`, `event:${it.eventId}`).row();
  }
  if (items.length > visible) {
    kb.text(`… ещё ${items.length - visible}`, `alerts:${trigger}:more`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

/** Short-form RUB formatter for the button-label tag (~3k / ~12k / ~5m). */
function formatLossShort(rub: number): string {
  const abs = Math.abs(rub);
  if (abs >= 1_000_000) return `${(rub / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ₽`;
  if (abs >= 1_000) return `${Math.round(rub / 1000)}k ₽`;
  return `${Math.round(rub)} ₽`;
}

/** Map of suggested_action → user-facing button label. */
export const ACTION_BUTTON_LABEL: Record<string, string> = {
  restock: '📦 Заказать поставку',
  reprice: '💰 Изменить цену',
  pause_ads: '⏸️ Приостановить рекламу',
  reply_review: '💬 Ответить на отзыв',
};

export function eventCardMenu(
  eventId: number,
  _trigger: string,
  suggestedAction: string | null,
  nmId?: number | null,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (suggestedAction) {
    const label = ACTION_BUTTON_LABEL[suggestedAction] ?? '✅ Применить рекомендацию';
    kb.text(label, `apply:${eventId}`).row();
  }
  // rev 26f: AI helper button — pre-seeded context so user gets root-cause
  // analysis instead of just snoozing the alert blindly.
  if (nmId) {
    kb.text('🤖 Спросить ИИ — почему?', `ask:${eventId}`).row();
  }
  kb.text('🔕 Напомнить 24ч', `snooze:${eventId}:24`)
    .text('🔕 На неделю', `snooze:${eventId}:168`).row();
  kb.text('🗑 Закрыть алёрт', `dismiss:${eventId}`).row();
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

// ============================================================================
// A/B tests (rev 25s)
// ============================================================================

export interface AbTestForMenu {
  testId: number;
  title: string;
  status: string;
  winnerVariant: string | null;
}

export function abTestsListMenu(tests: AbTestForMenu[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (tests.length === 0) {
    kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
    return kb;
  }
  for (let i = 0; i < Math.min(tests.length, 8); i++) {
    const t = tests[i];
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'][i];
    const marker = t.winnerVariant ? '🏆' : t.status === 'running' ? '🟢' : '⏸';
    const short = t.title.length > 20 ? t.title.slice(0, 19) + '…' : t.title;
    kb.text(`${num} ${marker} ${short}`, `abtest:${t.testId}`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

export function abTestCardMenu(testId: number, alreadyCompleted: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!alreadyCompleted) {
    kb.text('🏆 Победил A', `ab_win:${testId}:A`)
      .text('🏆 Победил B', `ab_win:${testId}:B`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

// ============================================================================
// ABC analysis (rev 25r)
// ============================================================================

const ABC_PERIODS = ['30', '60', '90'] as const;

export function abcReportMenu(activePeriod: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of ABC_PERIODS) {
    const marker = p === activePeriod ? '⚫' : '⚪';
    kb.text(`${marker} ${p} дн`, `abc:${p}`);
  }
  kb.row();
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

// ============================================================================
// Pricing (rev 25q)
// ============================================================================

export interface PricingItemForMenu {
  decisionId: number;
  title: string;
  deltaPct: number;
}

export function pricingListMenu(items: PricingItemForMenu[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (items.length === 0) {
    kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
    return kb;
  }
  for (let i = 0; i < Math.min(items.length, 8); i++) {
    const it = items[i];
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'][i];
    const arrow = it.deltaPct > 0 ? '↗' : it.deltaPct < 0 ? '↘' : '=';
    const short = it.title.length > 18 ? it.title.slice(0, 17) + '…' : it.title;
    kb.text(`${num} ${short} · ${arrow}${Math.abs(it.deltaPct)}%`, `price:${it.decisionId}`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

/**
 * Per-decision actions. The Apply button uses the state-router because
 * we want to attach the full price payload (workspaceId + shopId + nmId
 * + newPriceRub) so reject of a stale callback is impossible. Reject
 * goes through a plain callback since it only takes a decisionId.
 */
export function pricingDecisionMenu(decisionId: number, applyShortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Применить', `click:${applyShortId}`).row()
    .text('🗑 Отклонить', `price_reject:${decisionId}`)
    .text('⬅️ Назад', 'back').row()
    .text('🏠 Меню', 'menu:main');
}

// ============================================================================
// Supplies (rev 25p)
// ============================================================================

export interface LowStockItemForMenu {
  nmId: number;
  title: string;
  quantity: number;
  daysLeft: number;
}

export function suppliesListMenu(lowStock: LowStockItemForMenu[], webAppUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < Math.min(lowStock.length, 6); i++) {
    const it = lowStock[i];
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'][i];
    const days = it.daysLeft < 1 ? '<1д' : `${it.daysLeft.toFixed(1)}д`;
    const short = it.title.length > 20 ? it.title.slice(0, 19) + '…' : it.title;
    kb.text(`${num} ${short} · ${days}`, `supply:start:${it.nmId}`).row();
  }
  // WebApp picker (rev 25v) — only attach when an HTTPS URL is configured
  // (Telegram rejects http:// for inline web_app buttons).
  if (webAppUrl && webAppUrl.startsWith('https://')) {
    kb.webApp('🌐 Выбрать товар из каталога', webAppUrl).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

export function supplyCancelMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('❌ Отмена', 'supply:cancel').row()
    .text('🏠 Меню', 'menu:main');
}

// ============================================================================
// Reviews / feedback (rev 25n)
// ============================================================================

export interface ReviewItemForMenu {
  itemId: string;
  rating: number | null;
  userName: string | null;
  productTitle: string | null;
}

/**
 * List view of pending negative reviews. itemId is a WB string id (long)
 * so we keep it as-is in callback_data; rev callbacks are short enough
 * to fit (`rev:<itemId>` < 64 bytes for WB ids).
 */
export function reviewsListMenu(reviews: ReviewItemForMenu[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (reviews.length === 0) {
    kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
    return kb;
  }
  for (let i = 0; i < Math.min(reviews.length, 8); i++) {
    const r = reviews[i];
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'][i];
    const stars = r.rating != null ? '★'.repeat(r.rating) : '?';
    const name = r.userName ?? 'покупатель';
    const short = name.length > 15 ? name.slice(0, 14) + '…' : name;
    kb.text(`${num} ${stars} · ${short}`, `rev:${r.itemId}`).row();
  }
  kb.text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
  return kb;
}

/**
 * Per-review actions before drafting:
 *   ✍️ AI-черновик  → triggers Sonnet, transitions to draft view
 *   Назад / Меню
 */
export function reviewCardMenu(itemId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✍️ Сгенерировать AI-ответ', `rev_draft:${itemId}`).row()
    .text('⬅️ Назад', 'back').text('🏠 Меню', 'menu:main');
}

/**
 * After draft is shown — short-id state callback for "send", because the
 * draft body may need a re-derive on regenerate. shortIdSend is from the
 * state-router; regenerate uses the plain `rev_draft:<itemId>` callback
 * which retriggers the model.
 */
export function reviewDraftMenu(itemId: string, shortIdSend: string): InlineKeyboard {
  // rev 27b: tone shifters surface inline so the seller can iterate without
  // typing a new free-text request. The base "Ещё вариант" remains for a
  // neutral re-roll.
  return new InlineKeyboard()
    .text('📤 Отправить на WB', `click:${shortIdSend}`).row()
    .text('🔄 Ещё вариант', `rev_draft:${itemId}`)
    .text('🤍 Мягче', `rev_tone:${itemId}:softer`).row()
    .text('🧊 Строже', `rev_tone:${itemId}:firmer`)
    .text('⬅️ Назад', 'back').row()
    .text('🏠 Меню', 'menu:main');
}

export interface ParsedCallback {
  verb: string;
  args: string[];
}
export function parseCallback(data: string): ParsedCallback {
  const parts = data.split(':');
  return { verb: parts[0], args: parts.slice(1) };
}
