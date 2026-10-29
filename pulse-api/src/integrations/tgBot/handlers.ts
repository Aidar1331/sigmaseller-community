/**
 * Command and callback_query handlers for the Pulse bot.
 *
 * All handlers reply with HTML by default. Inline-keyboard taps come
 * through `bot.on('callback_query:data', ...)`; the verb-prefix dispatch
 * lives in handleCallback() below.
 */

import type { Bot } from 'grammy';
import log from '../../lib/logger.js';
import {
  userIdByChatId, listShopsForUser, listAlertGroups,
  alertGroupItems, alertItemById, topKeywordMovers,
  listPendingNegativeReviews, reviewById, markReviewAnswered,
  listOpenSupplyDrafts, createBotSupplyDraft, shopLowStockProducts,
  listProposedPricingDecisions, pricingDecisionById, setDecisionStatus,
  listAbTests, abTestById, loadAbTestPhases, declareAbWinner,
  topCriticalEvents, workspaceDayAggregate,
} from './data.js';
import { computeStatsByVariant, pickWinner } from '../../services/abPhoto.js';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  mainMenu, backToMain, shopsListMenu, shopDashboardMenu,
  alertsListMenu, alertGroupDetailMenu, eventCardMenu,
  seoBackMenu, reviewsListMenu, reviewCardMenu, reviewDraftMenu,
  suppliesListMenu, supplyCancelMenu,
  pricingListMenu, pricingDecisionMenu,
  abcReportMenu,
  abTestsListMenu, abTestCardMenu,
  parseCallback,
  TRIGGER_LABEL_RU,
} from './menus.js';
import {
  buildShopDashboard, buildAlertsOverview, welcomeMessage, helpMessage,
  buildAlertGroupHeader, buildEventCard, buildSeoList,
  buildReviewsOverview, buildReviewCard, buildReviewDraftPreview,
  buildSuppliesOverview, buildSupplyQuantityPrompt, buildSupplyCreated,
  buildPricingOverview, buildPricingDecisionCard,
  buildAbcReport, type AbcAnalysisData,
  buildAbTestsOverview, buildAbTestCard,
  buildUnitEconomicsCard, type UnitEconReport,
  buildTodayCard, buildSupplySubmitted,
} from './messages.js';
import { submitDraftToWb } from './wbSupplySubmit.js';
import { calcUnitEconomics } from '../../agents/tools/calcUnitEconomics.js';
import { wbSetPrice } from '../wb/wbActions.js';
import { queryAssortmentHealth } from '../../agents/tools/queryAssortmentHealth.js';
import { env } from '../../env.js';
import { chatWithLLM, TOOL_LABEL_RU, type LlmEvent } from './llm.js';
import { parseLLMButtons } from './buttonParser.js';
import {
  loadPending, dropPending, renderConfirmationCard,
} from './pendingActions.js';
import {
  tryAcquireRefreshLock, releaseRefreshLock,
  refreshOrdersSales, refreshStocks,
  renderRefreshStatus, type RefreshLineState,
} from './refresh.js';
import {
  getOrCreateActiveSession, startNewSession,
  listRecentSessions, loadRecentTurns, getSessionTitle,
  relativeTimeRu, type SessionListItem,
} from './chatSessions.js';
import { resetHistory } from './chatMemory.js';
import { setActiveShop, getActiveShopId } from './activeShop.js';
import { InlineKeyboard, Keyboard } from 'grammy';

/**
 * Public-https base used by Telegram inline `web_app` buttons (rev 25v).
 * Falls back to the production domain so the picker still launches if the
 * env var is unset — Telegram silently drops the button if the URL doesn't
 * start with `https://`, so a bogus value is harmless rather than fatal.
 */
function suppliesWebAppUrl(): string | undefined {
  const base = env.FRONTEND_URL && env.FRONTEND_URL.startsWith('https://')
    ? env.FRONTEND_URL
    : 'https://sigmaseller.ru';
  return `${base.replace(/\/$/, '')}/tg/supplies-picker`;
}
import {
  startSupplyFlow, getSupplyFlow, clearSupplyFlow,
} from './supplyFlow.js';
import { consumeLinkCode, unlinkByChatId } from './linkCode.js';
import {
  pushFrame, popFrame, readStack, resetStack,
  type NavFrame,
} from './session.js';
import { loadButtonState, saveButtonState, type ButtonState } from './stateRouter.js';
import { draftReviewReply } from './reviewReply.js';
import { sendWbFeedbackAnswer } from '../wb/feedbacks.js';

const logger = log.child({ module: 'tgBot' });

/**
 * Whether a callback verb represents a NAVIGATION (changes view) vs an
 * ACTION (apply/snooze/dismiss/back). Navigation frames go onto the
 * Redis nav-stack; actions don't.
 */
function isNavigationVerb(verb: string): boolean {
  return verb === 'menu' || verb === 'shops' || verb === 'shop'
      || verb === 'alerts' || verb === 'event' || verb === 'settings'
      || verb === 'today' || verb === 'seo'
      || verb === 'reviews' || verb === 'rev' || verb === 'rev_draft' || verb === 'rev_tone'
      || verb === 'supplies' || verb === 'supply'
      || verb === 'prices' || verb === 'price'
      || verb === 'abc'
      || verb === 'abtests' || verb === 'abtest' || verb === 'ab_win';
}

async function runAbcAnalysis(workspaceId: number, days: number): Promise<AbcAnalysisData> {
  const json = await queryAssortmentHealth({ daysBack: days, _workspaceId: workspaceId });
  try { return JSON.parse(json) as AbcAnalysisData; } catch {
    return { period: `${days} дней`, totalProducts: 0, totalRevenue: 0, abcSummary: { A: 0, B: 0, C: 0 }, deadStockCount: 0, topProducts: [], deadStock: [], recommendations: [] };
  }
}

/**
 * Dispatch a state-router action loaded from Redis. Returns
 * `{ handled: true }` if the action was recognised + executed,
 * `{ handled: false }` to let the caller fall back to the
 * "в разработке" toast.
 *
 * As each β/γ command lands, its handler registers an entry here.
 * v0 stub: nothing wired — every action falls through.
 */
async function dispatchStateAction(ctx: any, state: ButtonState): Promise<{ handled: boolean }> {
  switch (state.action) {
    case 'REVIEW_SEND': return handleReviewSend(ctx, state);
    case 'PRICE_APPLY':  return handlePriceApply(ctx, state);
    default:
      return { handled: false };
  }
}

/**
 * State-router action: push a single-product price update to WB. Payload
 * carries the resolved newPriceRub (already de-kop'd at draft-time) so we
 * don't need to re-fetch the decision row. On success we mark the row
 * applied and confirm via callback toast. Failures surface the WB error
 * string in the alert so the user can retry.
 */
async function handlePriceApply(ctx: any, state: ButtonState): Promise<{ handled: boolean }> {
  const workspaceId = Number(state.workspaceId);
  const shopId = Number(state.shopId);
  const nmId = Number(state.nmId);
  const newPriceRub = Number(state.newPriceRub);
  const decisionId = Number(state.decisionId);
  if (!workspaceId || !shopId || !nmId || !newPriceRub || !decisionId) {
    await ctx.answerCallbackQuery({ text: 'Не хватает данных для применения', show_alert: true });
    return { handled: true };
  }
  const result = await wbSetPrice(workspaceId, shopId, nmId, newPriceRub);
  if (!result.success) {
    await ctx.answerCallbackQuery({
      text: `❌ Не удалось: ${(result.error ?? 'WB error').slice(0, 150)}`,
      show_alert: true,
    });
    return { handled: true };
  }
  await setDecisionStatus(workspaceId, decisionId, 'applied');
  await ctx.answerCallbackQuery({ text: '✅ Цена отправлена в WB' });
  try {
    await ctx.editMessageText(
      `✅ <b>Новая цена ${newPriceRub} ₽ отправлена в WB</b>\n\n<i>Появится в кабинете WB через ~5 минут.</i>`,
      { parse_mode: 'HTML', reply_markup: backToMain() },
    );
  } catch { /* no-op */ }
  return { handled: true };
}

/**
 * State-router action: send a previously-drafted review reply to WB.
 *
 * The state payload carries `{ action: 'REVIEW_SEND', workspaceId, shopId,
 * itemId, text }`. We POST to WB, update the local feedback row, and
 * confirm via callback toast. On failure we surface the error message
 * to the user so they can retry.
 */
async function handleReviewSend(ctx: any, state: ButtonState): Promise<{ handled: boolean }> {
  const workspaceId = Number(state.workspaceId);
  const shopId = state.shopId != null ? Number(state.shopId) : null;
  const itemId = String(state.itemId ?? '');
  const text = String(state.text ?? '');
  if (!workspaceId || !itemId || !text) {
    await ctx.answerCallbackQuery({ text: 'Не хватает данных для отправки', show_alert: true });
    return { handled: true };
  }
  try {
    await sendWbFeedbackAnswer(workspaceId, shopId, itemId, text);
    await markReviewAnswered(workspaceId, itemId, text);
    await ctx.answerCallbackQuery({ text: '✅ Ответ отправлен на WB', show_alert: false });
    try {
      await ctx.editMessageText(
        `✅ <b>Ответ отправлен на WB</b>\n\n<i>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</i>`,
        { parse_mode: 'HTML', reply_markup: backToMain() },
      );
    } catch { /* no-op */ }
    return { handled: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message, itemId }, 'review send failed');
    await ctx.answerCallbackQuery({
      text: `❌ Не удалось отправить: ${(err as Error).message.slice(0, 150)}`,
      show_alert: true,
    });
    return { handled: true };
  }
}

async function ensureLinkedUser(ctx: any): Promise<number | null> {
  if (!ctx.chat) return null;
  const chatId = String(ctx.chat.id);
  const userId = await userIdByChatId(chatId);
  if (!userId) {
    await ctx.reply(
      '🔒 Этот чат пока не привязан к аккаунту SigmaSeller.\n\n' +
        'Зайди в кабинете в «Настройки → Уведомления» и нажми «Привязать Telegram».',
    );
  }
  return userId;
}

async function sendShopDashboard(ctx: any, userId: number, shopId: number, period: string): Promise<void> {
  const shops = await listShopsForUser(userId);
  const shop = shops.find((s) => s.shopId === shopId);
  if (!shop) {
    await ctx.reply('Магазин не найден или больше не активен.');
    return;
  }
  // rev 27f: remember the active shop so subsequent /alerts /prices etc.
  // narrow to it automatically.
  await setActiveShop(userId, shopId);
  const text = await buildShopDashboard(shop.workspaceId, shopId, shop.name, period);
  const keyboard = shopDashboardMenu(shopId, period);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Persistent bottom reply-keyboard for the main nav (rev 26g).
 * Stays below the chat input so users always have one-tap access to the
 * top-level views, like a native app's bottom-tab bar. Button taps send the
 * button text as a regular message — `bot.on('message:text')` routes those
 * texts to the same handlers used for slash commands.
 */
export const REPLY_KB_LABELS = {
  today: '📊 Сводка',
  shops: '🏪 Магазины',
  alerts: '🔔 Алёрты',
  chat: '💬 Чат с ИИ',
  balance: '💳 Баланс',
  help: 'ℹ️ Помощь',
  newchat: '🆕 Новый чат',
  chats: '🗨️ История',
} as const;

export function mainReplyKeyboard(): Keyboard {
  return new Keyboard()
    .text(REPLY_KB_LABELS.today).text(REPLY_KB_LABELS.shops).row()
    .text(REPLY_KB_LABELS.alerts).text(REPLY_KB_LABELS.balance).row()
    .text(REPLY_KB_LABELS.chat).text(REPLY_KB_LABELS.chats).row()
    .text(REPLY_KB_LABELS.newchat).text(REPLY_KB_LABELS.help).row()
    .resized().persistent();
}

/**
 * Map a reply-keyboard text to the slash command verb it should route to.
 * Returns null if the text isn't a known reply-button label — caller can
 * then forward the text to the LLM as normal free-text input.
 */
export function replyKbVerbForText(text: string): string | null {
  const t = text.trim();
  switch (t) {
    case REPLY_KB_LABELS.today: return 'today';
    case REPLY_KB_LABELS.shops: return 'shops';
    case REPLY_KB_LABELS.alerts: return 'alerts';
    case REPLY_KB_LABELS.chat: return 'chat_hint';
    case REPLY_KB_LABELS.balance: return 'balance';
    case REPLY_KB_LABELS.help: return 'help';
    case REPLY_KB_LABELS.newchat: return 'newchat';
    case REPLY_KB_LABELS.chats: return 'chats';
    default: return null;
  }
}

/**
 * /today screen (rev 27a). Pulls top-3 critical events, group counts, and
 * today+yesterday workspace aggregates, renders the triage card, attaches
 * AI-button + refresh button.
 */
/**
 * /balance screen (rev 27c-balance). Shows WB account balance per shop,
 * plus the SigmaSeller AI-token balance. WB has a 1 req/min rate limit
 * per key, so for users with many shops this can be slow — we fetch in
 * parallel and show partial results if some fail.
 */
async function sendBalanceCard(ctx: any, userId: number): Promise<void> {
  const shops = await listShopsForUser(userId);
  if (shops.length === 0) {
    await ctx.reply('💳 Подключи магазин WB чтобы увидеть баланс. /shops');
    return;
  }
  const workspaceId = shops[0].workspaceId;
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {});

  const { getBalance: getWbBalance } = await import('../wb/balance.js');
  const { getBalance: getAiBalance } = await import('../../services/aiTokens.js');

  // Look up each shop's api_key
  const keyRows = await db.execute(sql<{ shop_id: number; name: string; api_key: string | null }>`
    SELECT shop_id::int AS shop_id, name, api_key
      FROM marketplace_shops
     WHERE workspace_id = ${workspaceId}
       AND platform = 'wb'
       AND is_active = true
     ORDER BY shop_id;
  `);
  const balances = await Promise.all((keyRows.rows as any[]).map(async (s) => {
    if (!s.api_key) return { name: String(s.name), error: 'нет API-ключа' };
    try {
      const b = await getWbBalance(String(s.api_key));
      return { name: String(s.name), current: b.current, withdrawable: b.forWithdraw };
    } catch (err) {
      return { name: String(s.name), error: trimShort((err as Error).message) };
    }
  }));
  const ai = await getAiBalance(workspaceId).catch(() => null);

  const lines: string[] = [];
  lines.push('💳 <b>Балансы</b>');
  lines.push('');
  let totalCurrent = 0;
  let totalWithdraw = 0;
  let anyOk = false;
  for (const b of balances) {
    if ('error' in b) {
      lines.push(`🏪 <b>${escapeHtmlForChat(b.name)}</b>`);
      lines.push(`<i>⚠️ ${escapeHtmlForChat(b.error ?? 'неизвестная ошибка')}</i>`);
    } else {
      anyOk = true;
      totalCurrent += b.current ?? 0;
      totalWithdraw += b.withdrawable ?? 0;
      lines.push(`🏪 <b>${escapeHtmlForChat(b.name)}</b>`);
      lines.push(`На счёте: <b>${fmtRubsTotalsLocal(b.current)}</b>`);
      lines.push(`К выводу: <b>${fmtRubsTotalsLocal(b.withdrawable)}</b>`);
    }
    lines.push('');
  }
  if (anyOk && balances.length > 1) {
    lines.push(`<b>Итого:</b> на счёте <b>${fmtRubsTotalsLocal(totalCurrent)}</b>, к выводу <b>${fmtRubsTotalsLocal(totalWithdraw)}</b>`);
    lines.push('');
  }
  if (ai) {
    const rub = Math.floor(ai.balanceKopecks / 100);
    lines.push(`🤖 <b>AI-баланс SigmaSeller:</b> ${fmtRubsTotalsLocal(rub)}`);
    if (ai.totalSpentKopecks > 0) {
      lines.push(`<i>За всё время потрачено: ${fmtRubsTotalsLocal(Math.ceil(ai.totalSpentKopecks / 100))}</i>`);
    }
  }
  lines.push('');
  lines.push('<i>WB обновляет баланс с задержкой ~1 мин. AI-токены пополняются в кабинете → «Подписка».</i>');

  const kb = new InlineKeyboard()
    .text('🔄 Обновить', 'balance_refresh').row()
    .text('🏠 Меню', 'menu:main');
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

function trimShort(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
}
function fmtRubsTotalsLocal(rub: number): string {
  if (!Number.isFinite(rub)) return '— ₽';
  const intl = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  return `${intl.format(Math.round(rub))} ₽`;
}

/**
 * Renders a one-liner "active shop" banner for shop-scoped commands
 * (rev 27k.3). Returns either "🎯 Активный: <name>" with hint or a
 * "🌐 Все магазины (тапни /shops чтоб выбрать)" placeholder.
 */
/**
 * Structured help screen (rev 27k.4). Shows topic-based cards with
 * inline drill-down so the user picks "what do I need help with" rather
 * than scrolling a wall of slash-command descriptions.
 */
async function sendHelpCard(ctx: any): Promise<void> {
  const text = [
    'ℹ️ <b>Помощь · SigmaSeller Bot</b>',
    '',
    'Выбери тему ↓ — открою короткое описание и нужные команды.',
    '',
    '<b>Быстрые команды:</b>',
    '• /today — что сейчас горит',
    '• /balance — баланс на WB',
    '• /shops — выбрать активный магазин',
    '• /newchat — сброс контекста ИИ',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('📊 Сводки и метрики', 'help:metrics').row()
    .text('🔔 Алёрты и события', 'help:alerts').row()
    .text('💰 Цены и юнит-эк', 'help:pricing').row()
    .text('📦 Поставки', 'help:supplies').row()
    .text('💬 Отзывы', 'help:reviews').row()
    .text('🤖 AI-чат', 'help:ai').row()
    .text('💳 Финансы и баланс', 'help:finance').row()
    .text('⚙️ Настройки', 'help:settings').row()
    .text('🏠 Меню', 'menu:main');
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

const HELP_TOPICS: Record<string, { title: string; body: string[] }> = {
  metrics: {
    title: '📊 Сводки и метрики',
    body: [
      'Быстрый ответ на «как у меня дела сегодня». Сводка за день, разбивка по магазинам и периодам, ABC-аналитика, юнит-экономика по любому товару.',
      '',
      '📍 <b>Зачем:</b> чтобы держать руку на пульсе без открытия личного кабинета. Утром глянул — понял что критично, что норм.',
      '🔜 <b>Скоро:</b> сравнение «вчера/неделя/месяц» одной кнопкой, графики динамики прямо в чате.',
      '',
      '<i>Команды: /today /shops /abc /unit</i>',
    ],
  },
  alerts: {
    title: '🔔 Алёрты и события',
    body: [
      'Мониторинг 24/7 — бот сам ловит проблемы и шлёт push. OOS, падения выкупа, отрицательная маржа, негативные отзывы и ещё 20+ типов.',
      '',
      '📍 <b>Зачем:</b> ловить проблемы за минуты, а не за дни. Каждый час OOS на хитовом товаре = потерянные деньги.',
      '🔜 <b>Скоро:</b> тонкие настройки порогов (когда именно считать «критично»), мульти-канал (Slack/email).',
      '',
      '<i>Команды: /alerts</i>',
    ],
  },
  pricing: {
    title: '💰 Цены и юнит-эк',
    body: [
      'Рекомендации по ценам с обоснованием. ИИ может предложить смену цены прямо в чате — ты подтверждаешь, и оно уезжает в WB.',
      '',
      '📍 <b>Зачем:</b> цена — главный рычаг маржи. Своевременная коррекция = больше денег без лишних усилий.',
      '🔜 <b>Скоро:</b> пакетное применение «применить все рекомендации», графики «после применения» (эффект через 24/72ч).',
      '',
      '<i>Команды: /prices /unit · «снизь цену на артикул X до 3000» в чате</i>',
    ],
  },
  supplies: {
    title: '📦 Поставки',
    body: [
      'Бот покажет товары на грани OOS, поможет составить черновик поставки, и одной кнопкой отправит preorder в WB через API.',
      '',
      '📍 <b>Зачем:</b> поставка занимает время — заметить нехватку за неделю до OOS = успеть продать без простоев.',
      '🔜 <b>Скоро:</b> выбор склада из списка, мульти-товарные поставки, mono-pallet/super-safe варианты упаковки.',
      '',
      '<i>Команды: /supplies</i>',
    ],
  },
  reviews: {
    title: '💬 Отзывы',
    body: [
      'Неотвеченные негативные отзывы + AI-черновик ответа за 3 секунды. Тон можно поменять — «мягче» или «строже» — и переотправить.',
      '',
      '📍 <b>Зачем:</b> публичный ответ на негатив = доверие будущих покупателей. Ответили вовремя — конверсия растёт.',
      '🔜 <b>Скоро:</b> история переписки с одним покупателем, шаблоны под типовые жалобы, авто-ответ на 5★ отзывы.',
      '',
      '<i>Команды: /feedback</i>',
    ],
  },
  ai: {
    title: '🤖 AI-чат',
    body: [
      'Спрашивай свободным текстом — ИИ отвечает с данными твоего кабинета. Видны стадии: «🔍 Ищу товар → 📊 Считаю → 💡 Ответ».',
      '',
      '📍 <b>Зачем:</b> любой нестандартный вопрос («где маржа < 15%», «почему упало в субботу») получает ответ без лезть в дашборды.',
      '🔜 <b>Скоро:</b> голосовые сообщения (whisper), генерация графиков, авто-задачи «следи за X и предложи Y».',
      '',
      '<i>Команды: /chats /newchat · просто пиши вопрос текстом · лимит 15/день</i>',
    ],
  },
  finance: {
    title: '💳 Финансы и баланс',
    body: [
      'Баланс на счёте WB, доступно к выводу — по каждому магазину. Плюс остаток AI-токенов SigmaSeller.',
      '',
      '📍 <b>Зачем:</b> не дать деньгам зависать на WB-счёте без вывода. Контроль расходов на AI.',
      '🔜 <b>Скоро:</b> прогноз выплат на неделю вперёд, история движений, алёрты «нужен топ-ап».',
      '',
      '<i>Команды: /balance · «сколько на счёте» в чате</i>',
    ],
  },
  settings: {
    title: '⚙️ Настройки и прочее',
    body: [
      'Управление уведомлениями, отписка, перепривязка чата.',
      '',
      '📍 <b>Зачем:</b> чтобы алёрты приходили только нужные и в удобное время.',
      '🔜 <b>Скоро:</b> per-trigger подписки, тихие часы, расписания утренней сводки.',
      '',
      '<i>Команды: /settings /unsub /start · поддержка — оператор</i>',
    ],
  },
};

async function scopeBannerForUser(userId: number, shops: { shopId: number; name: string }[]): Promise<string> {
  const activeId = await getActiveShopId(userId);
  const active = activeId ? shops.find((s) => s.shopId === activeId) : undefined;
  if (active) {
    return `🎯 <b>${active.name}</b> · <i>смени в /shops</i>\n\n`;
  }
  if (shops.length === 1) {
    return `🏪 <b>${shops[0].name}</b>\n\n`;
  }
  return `🌐 <i>Все магазины · фокус на один — /shops</i>\n\n`;
}

async function sendTodayCard(ctx: any, userId: number): Promise<void> {
  const shops = await listShopsForUser(userId);
  if (shops.length === 0) {
    await ctx.reply(
      '🏪 У тебя пока нет подключённых магазинов WB.\n\n' +
        'Подключи в кабинете → «Настройки → Магазины»: добавь API-ключ WB, и сюда сразу польются данные.',
    );
    return;
  }
  const activeShopId = await getActiveShopId(userId);
  const filterShop = activeShopId
    ? shops.find((s) => s.shopId === activeShopId)
    : undefined;
  const workspaceId = shops[0].workspaceId;
  const todayIso = new Date().toISOString().slice(0, 10);
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [topCritical, groups, today, yesterday] = await Promise.all([
    topCriticalEvents(workspaceId, 3, filterShop?.shopId),
    listAlertGroups(workspaceId),
    workspaceDayAggregate(workspaceId, todayIso, filterShop?.shopId),
    workspaceDayAggregate(workspaceId, yesterdayIso, filterShop?.shopId),
  ]);
  const text = buildTodayCard(topCritical, groups, today, yesterday, filterShop?.name);
  const kb = new InlineKeyboard();
  if (topCritical.length > 0) {
    kb.text('🔔 К алёртам', 'alerts:list').row();
  }
  kb.text('🤖 Спросить ИИ что делать', 'ask_today').text('🔄 Обновить', 'today_refresh').row();
  if (filterShop) {
    kb.text(`🎯 Фокус: ${filterShop.name} · сменить`, 'shops:list').row();
  } else {
    kb.text('🎯 Фокус на магазин', 'shops:list').row();
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

function buildChatsList(sessions: SessionListItem[]): string {
  if (sessions.length === 0) {
    return [
      '🗨️ <b>История чатов</b>',
      '',
      'Пока нет чатов с ИИ. Напиши любой вопрос — начнётся новая беседа.',
    ].join('\n');
  }
  const lines: string[] = ['🗨️ <b>Последние чаты с ИИ</b>', ''];
  lines.push('<i>Тапни чтобы продолжить, /newchat чтобы начать новый.</i>');
  return lines.join('\n');
}

function chatsListMenu(sessions: SessionListItem[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of sessions) {
    const when = relativeTimeRu(s.lastMsgAt);
    const safeTitle = s.title.length > 32 ? s.title.slice(0, 31) + '…' : s.title;
    kb.text(`🗨️ ${safeTitle} · ${when}`, `chat:resume:${s.sessionId}`).row();
  }
  kb.text('🆕 Новый чат', 'chat:new').row();
  kb.text('🏠 Меню', 'menu:main');
  return kb;
}

async function handleResumeChat(ctx: any, userId: number, sessionId: number): Promise<void> {
  // Hydrate Redis from the persisted session so chatWithLLM picks up the
  // restored context transparently. We replace the active session for this
  // user with the resumed one by closing any other open session.
  const turns = await loadRecentTurns(sessionId, 20);
  const title = (await getSessionTitle(sessionId)) ?? 'Без названия';

  // rev 27L: unified-AI tables. Mark this conversation active by archiving
  // other open telegram-source conversations of this user, then re-activate
  // the requested one.
  await db.execute(sql`
    UPDATE agent_conversations
       SET status = 'archived', updated_at = NOW()
     WHERE user_id = ${userId}
       AND status = 'active'
       AND meta->>'source' = 'telegram'
       AND conversation_id != ${sessionId};
  `);
  await db.execute(sql`
    UPDATE agent_conversations
       SET status = 'active', updated_at = NOW()
     WHERE conversation_id = ${sessionId};
  `);

  // Write turns into Redis chatMemory so the next chatWithLLM call has
  // them. Skip if no turns survived (deleted user messages, etc).
  await resetHistory(userId);
  if (turns.length > 0) {
    const { appendUser, appendAssistant } = await import('./chatMemory.js');
    for (const t of turns) {
      if (t.role === 'user') await appendUser(userId, t.content);
      else await appendAssistant(userId, t.content);
    }
  }

  await ctx.answerCallbackQuery({ text: 'Чат восстановлен' });
  await ctx.reply(
    `📂 <b>Восстановлен чат:</b> ${escapeHtmlForChat(title)}\n\n<i>Продолжай как обычно.</i>`,
    { parse_mode: 'HTML' },
  );
}

function escapeHtmlForChat(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleRefresh(ctx: any, userId: number, shopId: number, period: string): Promise<void> {
  const shops = await listShopsForUser(userId);
  const shop = shops.find((s) => s.shopId === shopId);
  if (!shop) {
    await ctx.answerCallbackQuery({ text: 'Магазин не найден', show_alert: true });
    return;
  }

  const acquired = await tryAcquireRefreshLock(userId, shopId);
  if (!acquired) {
    await ctx.answerCallbackQuery({
      text: 'Уже обновляю, подожди ~1 минуту',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Запустил обновление' });

  // Initial status block — two stages, both queued.
  const lines: RefreshLineState[] = [
    { label: 'Заказы и продажи', status: 'queued' },
    { label: 'Остатки', status: 'queued' },
  ];

  const renderAndEdit = async (): Promise<void> => {
    try {
      await ctx.editMessageText(renderRefreshStatus(lines, shop.name), { parse_mode: 'HTML' });
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'refresh editMessageText no-op');
    }
  };

  await renderAndEdit();

  try {
    // Fire both in parallel; whichever finishes first patches its line and
    // we re-render. Promise.all keeps the function blocked until all done.
    await Promise.all([
      refreshOrdersSales(shop.workspaceId, shopId).then((res) => {
        lines[0] = res;
        return renderAndEdit();
      }),
      refreshStocks(shop.workspaceId, shopId).then((res) => {
        lines[1] = res;
        return renderAndEdit();
      }),
    ]);
  } finally {
    await releaseRefreshLock(userId, shopId);
  }

  // Brief settled state visible before flipping back to dashboard.
  await new Promise((r) => setTimeout(r, 500));

  // Final state: re-render the fresh dashboard.
  const text = await buildShopDashboard(shop.workspaceId, shopId, shop.name, period);
  const keyboard = shopDashboardMenu(shopId, period);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'refresh final editMessageText no-op');
  }
}

async function editShopDashboard(ctx: any, userId: number, shopId: number, period: string): Promise<void> {
  const shops = await listShopsForUser(userId);
  const shop = shops.find((s) => s.shopId === shopId);
  if (!shop) {
    await ctx.answerCallbackQuery({ text: 'Магазин не найден', show_alert: true });
    return;
  }
  // rev 27f: same active-shop recording as sendShopDashboard.
  await setActiveShop(userId, shopId);
  const text = await buildShopDashboard(shop.workspaceId, shopId, shop.name, period);
  const keyboard = shopDashboardMenu(shopId, period);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    // editMessageText fails if the new text is identical to the previous
    // (Telegram rejects no-op edits with HTTP 400). Catch and answer the
    // callback so the user still gets the spinner-stop.
    logger.debug({ err: (err as Error).message }, 'editMessageText no-op');
  }
  await ctx.answerCallbackQuery();
}

export function registerHandlers(bot: Bot): void {
  // /start [code] — either link-bind or welcome
  bot.command('start', async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const username = ctx.from?.username ?? null;
    const payload = (ctx.match || '').trim();

    if (payload) {
      const result = await consumeLinkCode(payload, chatId, username);
      if (result.ok) {
        await ctx.reply(
          '✅ <b>Telegram привязан к аккаунту SigmaSeller.</b>\n\n' +
            'Утренние сводки в 9:00 МСК будут приходить сюда.\n\n' +
            'Внизу — постоянное меню. Жми что нужно.',
          { parse_mode: 'HTML', reply_markup: mainReplyKeyboard() },
        );
        return;
      }
      const reasonMsg = result.reason === 'expired_or_invalid'
        ? 'Код устарел или уже использован. Сгенерируй новый в кабинете.'
        : result.reason === 'duplicate'
        ? 'Этот чат уже привязан к другому аккаунту SigmaSeller. Отвяжи через /unsub в первом.'
        : 'Ошибка привязки. Попробуй ещё раз.';
      await ctx.reply(`❌ ${reasonMsg}`);
      return;
    }

    // No payload — just a welcome greeting (returns to main menu).
    const userId = await userIdByChatId(chatId);
    if (!userId) {
      await ctx.reply(
        '👋 Привет! Этот чат пока не привязан к аккаунту SigmaSeller.\n\n' +
          'Зайди в кабинете в «Настройки → Уведомления» и нажми «Привязать Telegram».',
      );
      return;
    }
    const displayName = ctx.from?.first_name;
    // rev 27N: only the persistent bottom keyboard on /start — the second
    // inline "🚀 Что хочешь сделать?" message was redundant (operator's request).
    await ctx.reply(welcomeMessage(displayName), {
      parse_mode: 'HTML',
      reply_markup: mainReplyKeyboard(),
    });
  });

  // /help — structured help (rev 27k.4)
  bot.command('help', async (ctx) => {
    await sendHelpCard(ctx);
  });

  // /today — real triage screen (rev 27a)
  bot.command('today', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    await sendTodayCard(ctx, userId);
  });

  // /shops — list shops
  bot.command('shops', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      // rev 27h: empty state with explainer + CTA, not a dead-end.
      await ctx.reply(
        '🏪 <b>Магазинов пока нет.</b>\n\n' +
          'Чтобы подключить:\n' +
          '1. Зайди в кабинет SigmaSeller (web)\n' +
          '2. «Настройки → Магазины» → «Добавить магазин»\n' +
          '3. Вставь API-ключ WB (Личный кабинет WB → Доступ к API)\n\n' +
          'Через 5-10 минут сюда начнут поступать данные.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.reply('🏪 <b>Выбери магазин:</b>', {
      parse_mode: 'HTML',
      reply_markup: shopsListMenu(shops),
    });
  });

  // /alerts — group overview
  bot.command('alerts', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply(
        '🔔 <b>Алёрты появятся когда подключишь магазины.</b>\n\n' +
          'В кабинете → «Настройки → Магазины» добавь WB API-ключ. Через пару часов сюда польются события мониторинга.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    // rev 27f: respect active-shop scope.
    const activeShopId = await getActiveShopId(userId);
    const activeShop = activeShopId ? shops.find((s) => s.shopId === activeShopId) : undefined;
    const workspaceId = shops[0].workspaceId;
    const groups = await listAlertGroups(workspaceId, activeShop?.shopId);
    const total = groups.reduce((s, g) => s + g.count, 0);
    const scopeBanner = activeShop
      ? `🎯 <i>Фокус: ${activeShop.name}</i>\n\n`
      : '';
    await ctx.reply(scopeBanner + buildAlertsOverview(total, groups.length), {
      parse_mode: 'HTML',
      reply_markup: alertsListMenu(groups),
    });
  });

  // /unit — unit economics per nm (rev 25t)
  bot.command('unit', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('📊 Подключи магазин, чтобы считать юнит-экономику.');
      return;
    }
    const arg = (ctx.match || '').trim();
    const nmId = parseInt(arg, 10);
    if (!Number.isInteger(nmId) || nmId <= 0) {
      await ctx.reply(
        '📊 <b>Юнит-экономика</b>\n\n' +
        'Напиши <code>/unit &lt;nm_id&gt;</code> — посчитаю прибыль/маржу за 30 дней.\n\n' +
        '<i>Например:</i> <code>/unit 12345678</code>\n\n' +
        'Или спроси в чате: «сколько я зарабатываю с товара 12345678».',
        { parse_mode: 'HTML', reply_markup: backToMain() },
      );
      return;
    }
    const workspaceId = shops[0].workspaceId;
    const json = await calcUnitEconomics({ nmId, _workspaceId: workspaceId });
    let data: UnitEconReport;
    try { data = JSON.parse(json); } catch { data = { nmId, period: { from: '', to: '' }, qtySold: 0, perUnit: { revenueKop: 0, logisticsKop: 0, commissionKop: 0, penaltyKop: 0, cogsKop: 0, totalCostsKop: 0, profitKop: 0, marginPct: 0, roi: 0 }, error: 'parse error' }; }
    // Title lookup from wb_cards
    const titleRow = await db.execute(sql`
      SELECT COALESCE(title, subject_name, '#'||nm_id::text) AS title
        FROM wb_cards
       WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
       LIMIT 1;
    `);
    const title = (titleRow.rows[0] as any)?.title ?? `#${nmId}`;
    await ctx.reply(buildUnitEconomicsCard(String(title), data), {
      parse_mode: 'HTML',
      reply_markup: backToMain(),
    });
  });

  // /abtests — A/B photo tests + declare winner (rev 25s)
  bot.command('abtests', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('🧪 Подключи магазин — тогда покажу A/B-тесты.');
      return;
    }
    const tests = await listAbTests(shops[0].workspaceId, undefined, 10);
    await ctx.reply(buildAbTestsOverview(tests), {
      parse_mode: 'HTML',
      reply_markup: abTestsListMenu(tests.map((t) => ({
        testId: t.testId, title: t.title, status: t.status, winnerVariant: t.winnerVariant,
      }))),
    });
  });

  // /abc — assortment health / ABC analysis (rev 25r)
  bot.command('abc', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('📊 Подключи магазин, чтобы получить анализ ассортимента.');
      return;
    }
    const data = await runAbcAnalysis(shops[0].workspaceId, 30);
    await ctx.reply(buildAbcReport(data), {
      parse_mode: 'HTML',
      reply_markup: abcReportMenu('30'),
    });
  });

  // /prices — pricing recommendations + apply (rev 25q)
  bot.command('prices', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('💰 Подключи магазин — тогда смогу показать рекомендации.');
      return;
    }
    const banner = await scopeBannerForUser(userId, shops);
    const rows = await listProposedPricingDecisions(shops[0].workspaceId, 10);
    await ctx.reply(banner + buildPricingOverview(rows), {
      parse_mode: 'HTML',
      reply_markup: pricingListMenu(rows.map((r) => ({
        decisionId: r.decisionId,
        title: r.title,
        deltaPct: r.oldPriceKop > 0 ? Math.round(((r.newPriceKop - r.oldPriceKop) / r.oldPriceKop) * 100) : 0,
      }))),
    });
  });

  // /supplies — draft creation flow (rev 25p)
  bot.command('supplies', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('📦 Подключи магазин — тогда смогу формировать черновики поставок.');
      return;
    }
    const workspaceId = shops[0].workspaceId;
    const [drafts, lowStockArr] = await Promise.all([
      listOpenSupplyDrafts(workspaceId, 5),
      Promise.all(shops.map((s) => shopLowStockProducts(workspaceId, s.shopId, 14, 6))),
    ]);
    const lowStockFlat = lowStockArr.flat()
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 6);
    const banner = await scopeBannerForUser(userId, shops);
    await ctx.reply(banner + buildSuppliesOverview(drafts, lowStockFlat.length), {
      parse_mode: 'HTML',
      reply_markup: suppliesListMenu(lowStockFlat.map((it) => ({
        nmId: it.nmId, title: it.title, quantity: it.quantity, daysLeft: it.daysLeft,
      })), suppliesWebAppUrl()),
    });
  });

  // /feedback — pending negative reviews + AI-draft reply (rev 25n)
  bot.command('feedback', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('💬 Подключи магазин, чтобы видеть отзывы.');
      return;
    }
    const workspaceId = shops[0].workspaceId;
    const banner = await scopeBannerForUser(userId, shops);
    const reviews = await listPendingNegativeReviews(workspaceId, 10);
    await ctx.reply(banner + buildReviewsOverview(reviews.length), {
      parse_mode: 'HTML',
      reply_markup: reviewsListMenu(reviews.map((r) => ({
        itemId: r.itemId,
        rating: r.rating,
        userName: r.userName,
        productTitle: r.productTitle,
      }))),
    });
  });

  // /seo — top keyword movers (rev 25m)
  bot.command('seo', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const shops = await listShopsForUser(userId);
    if (shops.length === 0) {
      await ctx.reply('📈 Подключи магазин — тогда SEO-позиции начнут отслеживаться.');
      return;
    }
    const rows = await topKeywordMovers(shops[0].workspaceId, 20);
    await ctx.reply(buildSeoList(rows), { parse_mode: 'HTML', reply_markup: seoBackMenu() });
  });

  // /balance — WB account balance + AI tokens (rev 27c-balance)
  bot.command('balance', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    await sendBalanceCard(ctx, userId);
  });

  // /chats — list recent AI conversations (rev 26b)
  bot.command('chats', async (ctx) => {
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    const sessions = await listRecentSessions(userId, 10);
    await ctx.reply(buildChatsList(sessions), {
      parse_mode: 'HTML',
      reply_markup: chatsListMenu(sessions),
    });
  });

  // /newchat — close active, start fresh, clear Redis context
  bot.command('newchat', async (ctx) => {
    if (!ctx.chat) return;
    const userId = await ensureLinkedUser(ctx);
    if (!userId) return;
    await startNewSession(userId, String(ctx.chat.id));
    await resetHistory(userId);
    await ctx.reply(
      '🆕 <b>Новый чат начат.</b>\n\nКонтекст очищен — задавай любой вопрос с чистого листа.',
      { parse_mode: 'HTML' },
    );
  });

  // /settings — placeholder for rev 25f
  bot.command('settings', async (ctx) => {
    await ctx.reply(
      '⚙️ <b>Настройки</b>\n\n' +
        '<i>Раздел в разработке.</i>\n\n' +
        'Скоро тут можно будет: выбрать какие алёрты получать, какое время для сводки, отписаться от типов событий.',
      { parse_mode: 'HTML', reply_markup: backToMain() },
    );
  });

  // /unsub — unlink the chat
  bot.command('unsub', async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const res = await unlinkByChatId(chatId);
    if (res.removed > 0) {
      await ctx.reply(
        '👋 Отписал тебя от рассылок. Чтобы снова подключить — зайди в кабинет → «Настройки → Уведомления».',
      );
    } else {
      await ctx.reply('Этот чат не был привязан. Если хочешь подключить — зайди в кабинет → «Настройки → Уведомления».');
    }
  });

  // ── Inline-keyboard callback router ──────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    let { verb, args } = parseCallback(data);
    if (!ctx.chat) {
      await ctx.answerCallbackQuery({ text: 'Нет chat-контекста', show_alert: true });
      return;
    }
    const chatId = String(ctx.chat.id);
    const userId = await userIdByChatId(chatId);
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Чат не привязан к аккаунту', show_alert: true });
      return;
    }

    // State-router (rev 25j): `click:{shortId}` callbacks resolve to a
    // structured action via the Redis-backed state store. Loads
    // ButtonState by shortId and dispatches by state.action; if the
    // state has expired we surface a user-facing "кнопка устарела"
    // toast rather than silently failing.
    if (verb === 'click') {
      const shortId = args[0];
      const state = shortId ? await loadButtonState(shortId) : null;
      if (!state) {
        await ctx.answerCallbackQuery({
          text: '⏳ Кнопка устарела, открой раздел заново',
          show_alert: true,
        });
        return;
      }
      // Dispatch by state.action. Each action's handler is a per-command
      // file (added in rev 25p+ as commands ship). v0 placeholder: route
      // via the catch-all so users see "в разработке (β/γ)" rather than
      // silent fail. Specific handlers will land alongside their
      // commands and intercept here.
      const result = await dispatchStateAction(ctx, state);
      if (!result.handled) {
        await ctx.answerCallbackQuery({
          text: 'Эта операция пока в разработке',
          show_alert: true,
        });
      }
      return;
    }

    // back-stack: 'back' callback pops the top frame and re-dispatches the
    // previous one via the same switch, so `⬅️ Назад` always returns to
    // the previous view regardless of depth. Action verbs (apply/
    // snooze/dismiss) don't navigate, so they bypass the stack entirely.
    if (verb === 'back') {
      await popFrame(chatId);
      const stack = await readStack(chatId);
      const prev: NavFrame = stack[stack.length - 1] ?? { verb: 'menu', args: ['main'] };
      verb = prev.verb;
      args = prev.args;
      // do NOT push: we are *returning* to a previous frame
    } else if (isNavigationVerb(verb)) {
      // Reset the stack when user explicitly jumps to root.
      if (verb === 'menu' && args[0] === 'main') {
        await resetStack(chatId);
      }
      await pushFrame(chatId, { verb, args });
    }

    switch (verb) {
      case 'menu': {
        // menu:main
        if (args[0] === 'main') {
          const displayName = ctx.from?.first_name;
          try {
            await ctx.editMessageText(welcomeMessage(displayName), { parse_mode: 'HTML', reply_markup: mainMenu() });
          } catch { /* no-op edit */ }
          await ctx.answerCallbackQuery();
        }
        break;
      }
      case 'supply_confirm':
      // legacy: messages sent before rev 25z.4 (2026-05-24) used 'supply_submit'.
      // Keep the alias ~6 months so users tapping old inline buttons still work.
      case 'supply_submit': {
        // Submit a bot-created supply draft to the real WB API.
        const draftId = Number(args[0]);
        if (!Number.isInteger(draftId) || draftId <= 0) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Отправляю в WB…' });
        try {
          await ctx.editMessageText(
            '⏳ <i>Создаю preorder в Wildberries — это занимает 5-10 секунд.</i>',
            { parse_mode: 'HTML' },
          );
        } catch { /* no-op */ }
        const result = await submitDraftToWb(draftId);
        if (result.ok) {
          // Look up the draft to render a richer confirmation card.
          const meta = await db.execute(sql`
            SELECT i.title, i.quantity
              FROM supply_drafts d JOIN supply_draft_items i ON i.draft_id = d.draft_id
             WHERE d.draft_id = ${draftId} LIMIT 1;
          `);
          const m = meta.rows[0] as any;
          const text = buildSupplySubmitted(
            result.preorderID,
            result.warehouseName,
            String(m?.title ?? `draft #${draftId}`),
            Number(m?.quantity ?? 0),
          );
          try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToMain() });
          } catch {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() });
          }
        } else {
          const friendlyReason: Record<typeof result.reason, string> = {
            no_draft: 'черновик не найден или уже отправлен',
            no_barcode: 'у товара нет привязанного штрихкода',
            no_warehouse: 'не нашёл доступного склада WB',
            wb_error: 'WB не принял запрос',
          } as const;
          const text = [
            '⚠️ <b>Не получилось создать поставку в WB.</b>',
            '',
            `Причина: ${friendlyReason[result.reason]}.`,
            result.detail ? `<i>${result.detail}</i>` : '',
            '',
            'Черновик сохранён локально — можешь оформить вручную в кабинете SigmaSeller.',
          ].filter(Boolean).join('\n');
          try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToMain() });
          } catch {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() });
          }
        }
        break;
      }
      case 'help': {
        // help:<topic> — drill-down on a help section (rev 27k.4).
        // Special topic "_root" → re-render the root help card in-place.
        const topic = args[0];
        if (!topic || topic === '_root' || !HELP_TOPICS[topic]) {
          const rootText = [
            'ℹ️ <b>Помощь · SigmaSeller Bot</b>',
            '',
            'Выбери тему ↓ — открою короткое описание и нужные команды.',
            '',
            '<b>Быстрые команды:</b>',
            '• /today — что сейчас горит',
            '• /balance — баланс на WB',
            '• /shops — выбрать активный магазин',
            '• /newchat — сброс контекста ИИ',
          ].join('\n');
          const rootKb = new InlineKeyboard()
            .text('📊 Сводки и метрики', 'help:metrics').row()
            .text('🔔 Алёрты и события', 'help:alerts').row()
            .text('💰 Цены и юнит-эк', 'help:pricing').row()
            .text('📦 Поставки', 'help:supplies').row()
            .text('💬 Отзывы', 'help:reviews').row()
            .text('🤖 AI-чат', 'help:ai').row()
            .text('💳 Финансы и баланс', 'help:finance').row()
            .text('⚙️ Настройки', 'help:settings').row()
            .text('🏠 Меню', 'menu:main');
          try {
            await ctx.editMessageText(rootText, { parse_mode: 'HTML', reply_markup: rootKb });
          } catch {
            await ctx.reply(rootText, { parse_mode: 'HTML', reply_markup: rootKb });
          }
          await ctx.answerCallbackQuery();
          break;
        }
        const t = HELP_TOPICS[topic];
        const text = `${t.title}\n\n${t.body.join('\n')}`;
        const kb = new InlineKeyboard()
          .text('⬅️ К темам', 'help:_root').row()
          .text('🏠 Меню', 'menu:main');
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
        }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'today_refresh': {
        await ctx.answerCallbackQuery({ text: 'Обновляю' });
        try { await ctx.deleteMessage(); } catch { /* no-op */ }
        await sendTodayCard(ctx, userId);
        break;
      }
      case 'balance_refresh': {
        await ctx.answerCallbackQuery({ text: 'Запрашиваю свежий баланс' });
        try { await ctx.deleteMessage(); } catch { /* no-op */ }
        await sendBalanceCard(ctx, userId);
        break;
      }
      case 'ai_starter': {
        // rev 27j: pre-seeded starter questions from chat_hint card.
        const which = args[0];
        const seedMap: Record<string, string> = {
          top_profit: 'Покажи мой топ-5 самых прибыльных товаров за последние 30 дней. По марже и обороту.',
          anomalies: 'Используй get_anomaly_summary. Покажи мне сводку самого плохого в кабинете прямо сейчас.',
          oos_soon: 'Какие товары на грани OOS (хватит < 5 дней по текущим продажам)? Выведи топ-10.',
          low_margin: 'Найди мои товары с маржой ниже 15%. Используй get_anomaly_summary и get_unit_economics для топов.',
        };
        const seed = seedMap[which];
        if (!seed) {
          await ctx.answerCallbackQuery();
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Анализирую' });
        const sessionId4 = await getOrCreateActiveSession(userId, String(ctx.chat?.id ?? ''));
        const placeholder = await ctx.reply('🤔 <i>Анализирую…</i>', { parse_mode: 'HTML' });
        let lastE = 0, lastT = '';
        const edit = async (t: string): Promise<void> => {
          if (!t || t === lastT) return;
          const now = Date.now();
          if (now - lastE < 800) return;
          lastE = now; lastT = t;
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id,
              t.replace(/\[BUTTON:[^\]]*\]/g, '').trim(), { parse_mode: 'HTML' });
          } catch { /* no-op */ }
        };
        try {
          const result = await chatWithLLM(userId, seed, { onProgress: edit, sessionId: sessionId4 });
          const parsed = parseLLMButtons(result.text);
          const opts: any = { parse_mode: 'HTML' };
          if (parsed.buttons.length > 0) opts.reply_markup = { inline_keyboard: parsed.buttons };
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, parsed.text, opts);
          } catch {
            await ctx.reply(parsed.text, opts);
          }
        } catch (err) {
          logger.error({ err: (err as Error).message, which }, 'ai_starter failed');
        }
        break;
      }
      case 'ask_today': {
        // Pre-seeded analytical question for /today (rev 27a).
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Анализирую' });
        const seed = 'Посмотри сегодняшнюю ситуацию по моему кабинету. Что самое срочное, что я могу сделать прямо сейчас? Кратко: 3-5 пунктов в порядке важности.';
        const sessionId3 = await getOrCreateActiveSession(userId, String(ctx.chat?.id ?? ''));
        const placeholder = await ctx.reply('🤔 <i>Думаю о сегодня…</i>', { parse_mode: 'HTML' });
        let lastEdit = 0, lastTextBuf = '';
        const edit = async (t: string): Promise<void> => {
          if (!t || t === lastTextBuf) return;
          const now = Date.now();
          if (now - lastEdit < 800) return;
          lastEdit = now; lastTextBuf = t;
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id,
              t.replace(/\[BUTTON:[^\]]*\]/g, '').trim(), { parse_mode: 'HTML' });
          } catch { /* no-op */ }
        };
        try {
          const result = await chatWithLLM(userId, seed, { onProgress: edit, sessionId: sessionId3 });
          const parsed = parseLLMButtons(result.text);
          const opts: any = { parse_mode: 'HTML' };
          if (parsed.buttons.length > 0) opts.reply_markup = { inline_keyboard: parsed.buttons };
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, parsed.text, opts);
          } catch {
            await ctx.reply(parsed.text, opts);
          }
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'ask_today failed');
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id,
              '⚠️ Не получилось проанализировать. Попробуй позже.', { parse_mode: 'HTML' });
          } catch { /* no-op */ }
        }
        break;
      }
      case 'today': {
        // Bring up the main menu — same path as /today for now
        try {
          await ctx.editMessageText('📊 <b>Сводка</b>\n\nВыбери магазин для подробной картины.', {
            parse_mode: 'HTML',
            reply_markup: mainMenu(),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'shops': {
        // shops:list
        if (args[0] === 'list') {
          const shops = await listShopsForUser(userId);
          if (shops.length === 0) {
            await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
            return;
          }
          try {
            await ctx.editMessageText('🏪 <b>Выбери магазин:</b>', {
              parse_mode: 'HTML',
              reply_markup: shopsListMenu(shops),
            });
          } catch { /* no-op */ }
          await ctx.answerCallbackQuery();
        }
        break;
      }
      case 'shop': {
        // shop:<shopId>:<period>
        const shopId = Number(args[0]);
        const period = args[1] || 'today';
        if (!Number.isInteger(shopId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный магазин', show_alert: true });
          return;
        }
        await editShopDashboard(ctx, userId, shopId, period);
        break;
      }
      case 'refresh': {
        // refresh:<shopId>:<period>
        const shopId = Number(args[0]);
        const period = args[1] || 'today';
        if (!Number.isInteger(shopId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный магазин', show_alert: true });
          return;
        }
        await handleRefresh(ctx, userId, shopId, period);
        break;
      }
      case 'nm': {
        // nm:unit:<nmId>  |  nm:supply:<nmId>  — per-product quick actions
        // emitted via [BUTTON: ...] markers inside LLM replies (rev 26e).
        const sub = args[0];
        const nmId = Number(args[1]);
        if (!Number.isInteger(nmId) || nmId <= 0) {
          await ctx.answerCallbackQuery({ text: 'Неверный nm_id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        if (sub === 'unit') {
          await ctx.answerCallbackQuery();
          const json = await calcUnitEconomics({ nmId, _workspaceId: workspaceId });
          let data: UnitEconReport;
          try { data = JSON.parse(json); } catch { data = { nmId, period: { from: '', to: '' }, qtySold: 0, perUnit: { revenueKop: 0, logisticsKop: 0, commissionKop: 0, penaltyKop: 0, cogsKop: 0, totalCostsKop: 0, profitKop: 0, marginPct: 0, roi: 0 }, error: 'parse error' }; }
          const titleRow = await db.execute(sql`
            SELECT COALESCE(title, subject_name, '#'||nm_id::text) AS title
              FROM wb_cards WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
             LIMIT 1;`);
          const title = (titleRow.rows[0] as any)?.title ?? `#${nmId}`;
          await ctx.reply(buildUnitEconomicsCard(String(title), data), {
            parse_mode: 'HTML',
            reply_markup: backToMain(),
          });
        } else if (sub === 'supply') {
          // Re-use the existing supply:start:<nmId> flow by dispatching to
          // the same routine. Look up the product to get shop_id + title.
          const cardRow = await db.execute(sql`
            SELECT shop_id, COALESCE(title, subject_name, '#'||nm_id::text) AS title
              FROM wb_cards
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
             LIMIT 1;`);
          const card = cardRow.rows[0] as any;
          if (!card) {
            await ctx.answerCallbackQuery({ text: 'Товар не найден', show_alert: true });
            return;
          }
          const stockRow = await db.execute(sql`
            SELECT quantity FROM wb_stocks_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
             ORDER BY date DESC LIMIT 1;`);
          const salesRow = await db.execute(sql`
            SELECT AVG(sales_count)::numeric AS avg_daily
              FROM wb_orders_sales_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
               AND date::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE - 1;`);
          const currentStock = Number((stockRow.rows[0] as any)?.quantity ?? 0);
          const avgDaily = Number((salesRow.rows[0] as any)?.avg_daily ?? 0);
          await startSupplyFlow(userId, {
            step: 'quantity',
            workspaceId,
            shopId: Number(card.shop_id),
            nmId,
            productTitle: String(card.title),
            currentStock,
            avgDaily,
          });
          await ctx.answerCallbackQuery();
          await ctx.reply(buildSupplyQuantityPrompt(String(card.title), currentStock, avgDaily), {
            parse_mode: 'HTML', reply_markup: supplyCancelMenu(),
          });
        } else {
          await ctx.answerCallbackQuery();
        }
        break;
      }
      case 'cnf': {
        // cnf:<nonce> — apply pending write action
        const nonce = args[0];
        if (!nonce) {
          await ctx.answerCallbackQuery({ text: 'Нет nonce', show_alert: true });
          return;
        }
        const action = await loadPending(userId, nonce);
        if (!action) {
          await ctx.answerCallbackQuery({
            text: '⏳ Подтверждение истекло. Спроси у меня снова.',
            show_alert: true,
          });
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
          } catch { /* no-op */ }
          return;
        }
        try {
          if (action.type === 'set_price') {
            await wbSetPrice(action.workspaceId, action.shopId, action.nmId, action.newPriceRub);
          }
          await dropPending(userId, nonce);
          await ctx.answerCallbackQuery({ text: '✅ Применено' });
          try {
            await ctx.editMessageText(
              `✅ <b>Применено:</b> ${action.type === 'set_price'
                ? `цена ${action.newPriceRub} ₽ на «${action.productTitle}»`
                : 'действие'}`,
              { parse_mode: 'HTML' },
            );
          } catch { /* no-op */ }
        } catch (err) {
          logger.error({ err: (err as Error).message, userId, nonce }, 'apply pending failed');
          await ctx.answerCallbackQuery({
            text: '❌ Не получилось: ' + (err as Error).message.slice(0, 80),
            show_alert: true,
          });
        }
        break;
      }
      case 'cnl': {
        // cnl:<nonce> — cancel pending write action
        const nonce = args[0];
        if (!nonce) {
          await ctx.answerCallbackQuery();
          return;
        }
        await dropPending(userId, nonce);
        await ctx.answerCallbackQuery({ text: '❌ Отменено' });
        try {
          await ctx.editMessageText('❌ <b>Отменено.</b> Действие не применено.', { parse_mode: 'HTML' });
        } catch { /* no-op */ }
        break;
      }
      case 'chat': {
        // chat:resume:<sessionId>  |  chat:new
        const sub = args[0];
        if (sub === 'new') {
          if (!ctx.chat) {
            await ctx.answerCallbackQuery({ text: 'Нет контекста', show_alert: true });
            return;
          }
          await startNewSession(userId, String(ctx.chat.id));
          await resetHistory(userId);
          await ctx.answerCallbackQuery({ text: 'Контекст очищен' });
          await ctx.reply(
            '🆕 <b>Новый чат начат.</b>\n\nЗадавай любой вопрос с чистого листа.',
            { parse_mode: 'HTML' },
          );
        } else if (sub === 'resume') {
          const sessionId = Number(args[1]);
          if (!Number.isInteger(sessionId)) {
            await ctx.answerCallbackQuery({ text: 'Неверный чат', show_alert: true });
            return;
          }
          await handleResumeChat(ctx, userId, sessionId);
        } else {
          await ctx.answerCallbackQuery();
        }
        break;
      }
      case 'alerts': {
        // alerts:list  OR  alerts:<trigger>
        const sub = args[0];
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        if (!sub || sub === 'list') {
          const groups = await listAlertGroups(workspaceId);
          const total = groups.reduce((s, g) => s + g.count, 0);
          try {
            await ctx.editMessageText(buildAlertsOverview(total, groups.length), {
              parse_mode: 'HTML',
              reply_markup: alertsListMenu(groups),
            });
          } catch { /* no-op */ }
          await ctx.answerCallbackQuery();
        } else {
          // Drill-down into one trigger group — compact list, one button
          // per item; each opens its own event card (callback 'event:<id>').
          const items = await alertGroupItems(workspaceId, sub, 20);
          const header = buildAlertGroupHeader(sub, items);
          const kb = alertGroupDetailMenu(sub, items.map((it) => ({
            eventId: it.eventId, title: it.title, potentialLossRub: it.potentialLossRub,
          })));
          try {
            await ctx.editMessageText(header, { parse_mode: 'HTML', reply_markup: kb });
          } catch { /* no-op */ }
          await ctx.answerCallbackQuery();
        }
        break;
      }
      case 'event': {
        // event:<id> — show one event's detail card
        const eventId = Number(args[0]);
        if (!Number.isInteger(eventId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const detail = await alertItemById(workspaceId, eventId);
        if (!detail) {
          await ctx.answerCallbackQuery({ text: 'Алёрт не найден', show_alert: true });
          return;
        }
        const text = buildEventCard(detail);
        const kb = eventCardMenu(eventId, detail.trigger, detail.suggestedAction, detail.nmId);
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'ask': {
        // ask:<eventId> — pre-seed an AI question with the event context (rev 26f)
        const eventId = Number(args[0]);
        if (!Number.isInteger(eventId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const detail = await alertItemById(workspaceId, eventId);
        if (!detail) {
          await ctx.answerCallbackQuery({ text: 'Алёрт не найден', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Запрос ИИ…' });
        const triggerLabel = TRIGGER_LABEL_RU[detail.trigger] ?? detail.trigger;
        const seed = `Анализ алёрта «${triggerLabel}» по товару${detail.nmId ? ' nm ' + detail.nmId : ''}` +
          (detail.title ? ` («${detail.title}»)` : '') +
          (detail.description ? `. Данные: ${detail.description}.` : '.') +
          ' Объясни почему это произошло (2-3 главные причины) и что сделать (конкретные шаги).';
        const sessionId2 = await getOrCreateActiveSession(userId, String(ctx.chat?.id ?? ''));
        const placeholder = await ctx.reply('🤔 <i>Анализирую алёрт…</i>', { parse_mode: 'HTML' });
        let lastEdit = 0, lastText = '';
        const debouncedEdit = async (textSoFar: string): Promise<void> => {
          if (!textSoFar) return;
          const now = Date.now();
          if (now - lastEdit < 800) return;
          if (textSoFar === lastText) return;
          lastEdit = now;
          lastText = textSoFar;
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id,
              textSoFar.replace(/\[BUTTON:[^\]]*\]/g, '').trim(), { parse_mode: 'HTML' });
          } catch { /* no-op */ }
        };
        try {
          const result = await chatWithLLM(userId, seed, {
            onProgress: debouncedEdit,
            sessionId: sessionId2,
          });
          const parsed = parseLLMButtons(result.text);
          const opts: any = { parse_mode: 'HTML' };
          if (parsed.buttons.length > 0) opts.reply_markup = { inline_keyboard: parsed.buttons };
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, parsed.text, opts);
          } catch {
            await ctx.reply(parsed.text, opts);
          }
        } catch (err) {
          logger.error({ err: (err as Error).message, eventId }, 'ask AI failed');
          try {
            await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id,
              '⚠️ Не получилось проанализировать. Попробуй позже.', { parse_mode: 'HTML' });
          } catch { /* no-op */ }
        }
        break;
      }
      case 'apply':
      case 'dismiss':
      case 'snooze': {
        const eventId = Number(args[0]);
        if (!Number.isInteger(eventId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        let toastText = '';
        if (verb === 'apply') {
          await db.execute(sql`
            UPDATE agent_events
               SET status = 'applied', applied_at = NOW(), applied_by = ${userId}, updated_at = NOW()
             WHERE event_id = ${eventId} AND workspace_id = ${workspaceId};
          `);
          toastText = '✅ Применено';
        } else if (verb === 'dismiss') {
          await db.execute(sql`
            UPDATE agent_events SET status = 'dismissed', updated_at = NOW()
             WHERE event_id = ${eventId} AND workspace_id = ${workspaceId};
          `);
          toastText = '🗑 Скрыто';
        } else {
          const hours = Number(args[1] ?? '24');
          await db.execute(sql`
            UPDATE agent_events
               SET status = 'snoozed', snoozed_until = NOW() + ${`${hours} hours`}::interval, updated_at = NOW()
             WHERE event_id = ${eventId} AND workspace_id = ${workspaceId};
          `);
          toastText = `⏰ Отложено на ${hours < 24 ? `${hours} ч` : `${Math.round(hours / 24)} дн`}`;
        }
        // After acting, jump back to the group view so the user sees the
        // updated count without having to navigate manually.
        const detail = await alertItemById(workspaceId, eventId);
        const trigger = detail?.trigger ?? '';
        if (trigger) {
          const items = await alertGroupItems(workspaceId, trigger, 20);
          const header = buildAlertGroupHeader(trigger, items);
          const kb = alertGroupDetailMenu(trigger, items.map((it) => ({
            eventId: it.eventId, title: it.title, potentialLossRub: it.potentialLossRub,
          })));
          try {
            await ctx.editMessageText(header, { parse_mode: 'HTML', reply_markup: kb });
          } catch { /* no-op */ }
        }
        await ctx.answerCallbackQuery({ text: toastText, show_alert: false });
        break;
      }
      case 'settings': {
        try {
          await ctx.editMessageText(
            '⚙️ <b>Настройки</b>\n\n<i>Раздел в разработке.</i>',
            { parse_mode: 'HTML', reply_markup: backToMain() },
          );
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'seo': {
        // seo:list — top keyword movers
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const rows = await topKeywordMovers(workspaceId, 20);
        try {
          await ctx.editMessageText(buildSeoList(rows), {
            parse_mode: 'HTML',
            reply_markup: seoBackMenu(),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'abtests': {
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const tests = await listAbTests(workspaceId, undefined, 10);
        try {
          await ctx.editMessageText(buildAbTestsOverview(tests), {
            parse_mode: 'HTML',
            reply_markup: abTestsListMenu(tests.map((t) => ({
              testId: t.testId, title: t.title, status: t.status, winnerVariant: t.winnerVariant,
            }))),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'abtest': {
        // abtest:<testId> — detail card with stats
        const testId = Number(args[0]);
        if (!Number.isInteger(testId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const t = await abTestById(workspaceId, testId);
        if (!t) {
          await ctx.answerCallbackQuery({ text: 'Тест не найден', show_alert: true });
          return;
        }
        const phases = await loadAbTestPhases(testId);
        const stats = await computeStatsByVariant(workspaceId, t.nmId, phases);
        // TG bot card is still 2-variant only — narrow the multi-variant
        // pickWinner result back to 'A'|'B' (the only labels that could win
        // from a 2-variant stats input).
        const autoWinner = pickWinner(t.goal, stats) as 'A' | 'B' | null;
        try {
          await ctx.editMessageText(buildAbTestCard(t, stats, autoWinner), {
            parse_mode: 'HTML',
            reply_markup: abTestCardMenu(testId, t.status === 'completed' || !!t.winnerVariant),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'ab_win': {
        // ab_win:<testId>:<variant>  — declare winner manually
        const testId = Number(args[0]);
        const variant = args[1] === 'B' ? 'B' : 'A';
        if (!Number.isInteger(testId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        await declareAbWinner(workspaceId, testId, variant);
        await ctx.answerCallbackQuery({ text: `🏆 Победитель: ${variant}` });
        // Re-render the card with the new state
        const t = await abTestById(workspaceId, testId);
        if (t) {
          const phases = await loadAbTestPhases(testId);
          const stats = await computeStatsByVariant(workspaceId, t.nmId, phases);
          try {
            await ctx.editMessageText(buildAbTestCard(t, stats, null), {
              parse_mode: 'HTML',
              reply_markup: abTestCardMenu(testId, true),
            });
          } catch { /* no-op */ }
        }
        break;
      }
      case 'abc': {
        // abc:<days>
        const days = Number(args[0] || '30');
        const dStr = String(days);
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const data = await runAbcAnalysis(workspaceId, days);
        try {
          await ctx.editMessageText(buildAbcReport(data), {
            parse_mode: 'HTML',
            reply_markup: abcReportMenu(dStr),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'prices': {
        // prices:list
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const rows = await listProposedPricingDecisions(workspaceId, 10);
        try {
          await ctx.editMessageText(buildPricingOverview(rows), {
            parse_mode: 'HTML',
            reply_markup: pricingListMenu(rows.map((r) => ({
              decisionId: r.decisionId,
              title: r.title,
              deltaPct: r.oldPriceKop > 0 ? Math.round(((r.newPriceKop - r.oldPriceKop) / r.oldPriceKop) * 100) : 0,
            }))),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'price': {
        // price:<decisionId> — show decision card
        const decisionId = Number(args[0]);
        if (!Number.isInteger(decisionId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const d = await pricingDecisionById(workspaceId, decisionId);
        if (!d) {
          await ctx.answerCallbackQuery({ text: 'Рекомендация не найдена', show_alert: true });
          return;
        }
        if (d.status !== 'proposed') {
          await ctx.answerCallbackQuery({ text: `Уже ${d.status}`, show_alert: true });
          return;
        }
        const newPriceRub = Math.round(d.newPriceKop / 100);
        const applyShortId = await saveButtonState({
          action: 'PRICE_APPLY',
          workspaceId,
          shopId: d.shopId ?? shopsList[0]?.shopId ?? null,
          nmId: d.nmId,
          decisionId: d.decisionId,
          newPriceRub,
        });
        try {
          await ctx.editMessageText(buildPricingDecisionCard(d), {
            parse_mode: 'HTML',
            reply_markup: pricingDecisionMenu(d.decisionId, applyShortId),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'price_reject': {
        const decisionId = Number(args[0]);
        if (!Number.isInteger(decisionId)) {
          await ctx.answerCallbackQuery({ text: 'Неверный id', show_alert: true });
          return;
        }
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        await setDecisionStatus(workspaceId, decisionId, 'rejected');
        await ctx.answerCallbackQuery({ text: '🗑 Рекомендация отклонена' });
        // After reject, jump back to the list so user sees one less item.
        const rows = await listProposedPricingDecisions(workspaceId, 10);
        try {
          await ctx.editMessageText(buildPricingOverview(rows), {
            parse_mode: 'HTML',
            reply_markup: pricingListMenu(rows.map((r) => ({
              decisionId: r.decisionId,
              title: r.title,
              deltaPct: r.oldPriceKop > 0 ? Math.round(((r.newPriceKop - r.oldPriceKop) / r.oldPriceKop) * 100) : 0,
            }))),
          });
        } catch { /* no-op */ }
        break;
      }
      case 'supplies': {
        // supplies:list — fresh overview of drafts + low-stock items
        const shopsList = await listShopsForUser(userId);
        const workspaceId = shopsList[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const [drafts, lowStockArr] = await Promise.all([
          listOpenSupplyDrafts(workspaceId, 5),
          Promise.all(shopsList.map((s) => shopLowStockProducts(workspaceId, s.shopId, 14, 6))),
        ]);
        const lowStock = lowStockArr.flat()
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .slice(0, 6);
        try {
          await ctx.editMessageText(buildSuppliesOverview(drafts, lowStock.length), {
            parse_mode: 'HTML',
            reply_markup: suppliesListMenu(lowStock.map((it) => ({
              nmId: it.nmId, title: it.title, quantity: it.quantity, daysLeft: it.daysLeft,
            }))),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'supply': {
        // supply:start:<nmId>   → enter quantity-flow
        // supply:cancel         → drop flow
        const sub = args[0];
        if (sub === 'cancel') {
          await clearSupplyFlow(userId);
          await ctx.answerCallbackQuery({ text: 'Отменено' });
          try {
            await ctx.editMessageText('❌ Создание черновика отменено.', {
              parse_mode: 'HTML',
              reply_markup: backToMain(),
            });
          } catch { /* no-op */ }
          break;
        }
        if (sub === 'start') {
          const nmId = Number(args[1]);
          if (!Number.isInteger(nmId)) {
            await ctx.answerCallbackQuery({ text: 'Неверный nm_id', show_alert: true });
            return;
          }
          const shopsList = await listShopsForUser(userId);
          const workspaceId = shopsList[0]?.workspaceId;
          if (!workspaceId) {
            await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
            return;
          }
          // Find the row in low-stock listing across all shops to pick up
          // current stock + avg-daily for the prompt. Cheaper than another
          // SQL roundtrip.
          let match: { title: string; quantity: number; avgDaily: number; shopId: number } | null = null;
          for (const s of shopsList) {
            const rows = await shopLowStockProducts(workspaceId, s.shopId, 14, 20);
            const hit = rows.find((r) => r.nmId === nmId);
            if (hit) {
              match = { title: hit.title, quantity: hit.quantity, avgDaily: hit.avgDaily, shopId: s.shopId };
              break;
            }
          }
          if (!match) {
            await ctx.answerCallbackQuery({ text: 'Товар не найден в low-stock', show_alert: true });
            return;
          }
          await startSupplyFlow(userId, {
            step: 'quantity',
            workspaceId,
            shopId: match.shopId,
            nmId,
            productTitle: match.title,
            currentStock: match.quantity,
            avgDaily: match.avgDaily,
          });
          try {
            await ctx.editMessageText(
              buildSupplyQuantityPrompt(match.title, match.quantity, match.avgDaily),
              { parse_mode: 'HTML', reply_markup: supplyCancelMenu() },
            );
          } catch { /* no-op */ }
          await ctx.answerCallbackQuery();
          break;
        }
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие', show_alert: true });
        break;
      }
      case 'reviews': {
        // reviews:list — top-10 negative reviews
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const reviews = await listPendingNegativeReviews(workspaceId, 10);
        try {
          await ctx.editMessageText(buildReviewsOverview(reviews.length), {
            parse_mode: 'HTML',
            reply_markup: reviewsListMenu(reviews.map((r) => ({
              itemId: r.itemId,
              rating: r.rating,
              userName: r.userName,
              productTitle: r.productTitle,
            }))),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'rev': {
        // rev:<itemId> — show one review's card
        const itemId = args.join(':'); // WB ids can contain dashes; preserve verbatim
        if (!itemId) {
          await ctx.answerCallbackQuery({ text: 'Нет id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const r = await reviewById(workspaceId, itemId);
        if (!r) {
          await ctx.answerCallbackQuery({ text: 'Отзыв не найден', show_alert: true });
          return;
        }
        try {
          await ctx.editMessageText(buildReviewCard(r), {
            parse_mode: 'HTML',
            reply_markup: reviewCardMenu(itemId),
          });
        } catch { /* no-op */ }
        await ctx.answerCallbackQuery();
        break;
      }
      case 'rev_draft':
      case 'rev_tone': {
        // rev_draft:<itemId>              — neutral (re)generate
        // rev_tone:<itemId>:softer|firmer — tone-shifted regenerate (rev 27b)
        const itemId = verb === 'rev_tone' ? args[0] : args.join(':');
        const tone: 'neutral' | 'softer' | 'firmer' = verb === 'rev_tone'
          ? (args[1] === 'softer' ? 'softer' : args[1] === 'firmer' ? 'firmer' : 'neutral')
          : 'neutral';
        if (!itemId) {
          await ctx.answerCallbackQuery({ text: 'Нет id', show_alert: true });
          return;
        }
        const shops = await listShopsForUser(userId);
        const workspaceId = shops[0]?.workspaceId;
        if (!workspaceId) {
          await ctx.answerCallbackQuery({ text: 'Нет магазинов', show_alert: true });
          return;
        }
        const r = await reviewById(workspaceId, itemId);
        if (!r) {
          await ctx.answerCallbackQuery({ text: 'Отзыв не найден', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({
          text: tone === 'softer' ? '🤍 Мягче…' : tone === 'firmer' ? '🧊 Строже…' : '✍️ Перегенерирую…',
        });
        try { await ctx.api.sendChatAction(ctx.chat!.id, 'typing'); } catch { /* ok */ }
        let draft: string;
        try {
          draft = await draftReviewReply(workspaceId, r, tone);
        } catch (err) {
          logger.warn({ err: (err as Error).message, itemId, tone }, 'draftReviewReply failed');
          try {
            await ctx.editMessageText(
              '⚠️ Не получилось сгенерировать черновик. Попробуй ещё раз через минуту.',
              { parse_mode: 'HTML', reply_markup: reviewCardMenu(itemId) },
            );
          } catch { /* no-op */ }
          break;
        }
        const shortId = await saveButtonState({
          action: 'REVIEW_SEND',
          workspaceId,
          shopId: r.shopId,
          itemId,
          text: draft,
        });
        try {
          await ctx.editMessageText(buildReviewDraftPreview(r, draft), {
            parse_mode: 'HTML',
            reply_markup: reviewDraftMenu(itemId, shortId),
          });
        } catch { /* no-op */ }
        break;
      }
      default: {
        // Catch-all for LLM-suggested callbacks whose handlers don't
        // exist yet (β/γ scope). The system prompt has Claude propose
        // buttons like supplies_create_nm_*, feedback_ai_review_*,
        // prices_apply_nm_*, abc_clean, event_open_*. We accept the
        // callback (so the user sees we caught it), tell them honestly
        // that this is in development, and offer the menu fallback.
        const friendly =
          verb.startsWith('supplies_') ? 'Создание поставки появится в v2.0-γ.' :
          verb.startsWith('feedback_')  ? 'AI-ответ на отзывы — в v2.0-β.' :
          verb.startsWith('prices_')    ? 'Применение цен — в v2.0-γ.' :
          verb.startsWith('abc')        ? 'ABC-чистка — в v2.0-γ.' :
          verb.startsWith('event_')     ? 'Эта операция пока недоступна — открой /alerts.' :
          'Эта команда пока не подключена. Открой меню — /help.';
        await ctx.answerCallbackQuery({ text: friendly, show_alert: true });
      }
    }
  });

  // WebApp data receiver (rev 25v). When the in-Telegram WebView at
  // /tg/supplies-picker calls `Telegram.WebApp.sendData(JSON.stringify({...}))`,
  // the bot receives it here. Expected payload:
  //   { action: 'pick_product', nmId: <number>, title: <string>, shopId: <number> }
  // We bridge it into the existing /supply-flow state machine — the rest
  // of the path (ask for quantity → write supply_drafts row) is unchanged.
  bot.on('message:web_app_data', async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const userId = await userIdByChatId(chatId);
    if (!userId) {
      await ctx.reply('🔒 Чат не привязан к аккаунту.');
      return;
    }
    const raw = ctx.message?.web_app_data?.data;
    if (!raw) return;
    let payload: any;
    try { payload = JSON.parse(raw); } catch {
      await ctx.reply('⚠️ Не понял ответ из мини-приложения.');
      return;
    }
    if (payload?.action === 'pick_product') {
      const nmId = Number(payload.nmId);
      const title = String(payload.title ?? `#${nmId}`);
      const shopId = payload.shopId != null ? Number(payload.shopId) : null;
      if (!Number.isInteger(nmId) || nmId <= 0) {
        await ctx.reply('⚠️ Невалидный nm_id.');
        return;
      }
      const shops = await listShopsForUser(userId);
      const workspaceId = shops[0]?.workspaceId;
      if (!workspaceId) {
        await ctx.reply('🔒 Не вижу подключённых магазинов.');
        return;
      }
      await startSupplyFlow(userId, {
        step: 'quantity',
        workspaceId,
        shopId,
        nmId,
        productTitle: title,
        currentStock: null,
        avgDaily: null,
      });
      await ctx.reply(
        buildSupplyQuantityPrompt(title, null, null),
        { parse_mode: 'HTML', reply_markup: supplyCancelMenu() },
      );
      return;
    }
    await ctx.reply('⚠️ Неизвестный тип данных от мини-приложения.');
  });

  // Free-text → AI chat. Anything not starting with '/' is a question for
  // the LLM-copilot. Commands fall through to the unknown-command branch.
  bot.on('message:text', async (ctx) => {
    if (!ctx.chat) return;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Команда не распознана. Используй /help для списка.');
      return;
    }
    const chatId = String(ctx.chat.id);
    const userId = await userIdByChatId(chatId);
    if (!userId) {
      await ctx.reply('🔒 Чат не привязан к аккаунту. Подключи в кабинете → «Настройки → Уведомления».');
      return;
    }

    // rev 26g: persistent reply-keyboard taps come through as regular text
    // messages. Intercept the well-known labels and route them to the same
    // logic as the slash commands; anything else falls through to the LLM.
    const kbVerb = replyKbVerbForText(text);
    if (kbVerb) {
      try {
        switch (kbVerb) {
          case 'today': {
            await sendTodayCard(ctx, userId);
            return;
          }
          case 'shops': {
            const shops = await listShopsForUser(userId);
            if (shops.length === 0) {
              await ctx.reply('🏪 У тебя пока нет подключённых магазинов WB.');
              return;
            }
            await ctx.reply('🏪 <b>Выбери магазин:</b>', {
              parse_mode: 'HTML',
              reply_markup: shopsListMenu(shops),
            });
            return;
          }
          case 'alerts': {
            const shops = await listShopsForUser(userId);
            if (shops.length === 0) {
              await ctx.reply('🔔 Алёрты появятся после подключения магазинов.');
              return;
            }
            const workspaceId = shops[0].workspaceId;
            const groups = await listAlertGroups(workspaceId);
            const total = groups.reduce((s, g) => s + g.count, 0);
            await ctx.reply(buildAlertsOverview(total, groups.length), {
              parse_mode: 'HTML',
              reply_markup: alertsListMenu(groups),
            });
            return;
          }
          case 'chats': {
            const sessions = await listRecentSessions(userId, 10);
            await ctx.reply(buildChatsList(sessions), {
              parse_mode: 'HTML',
              reply_markup: chatsListMenu(sessions),
            });
            return;
          }
          case 'newchat': {
            await startNewSession(userId, chatId);
            await resetHistory(userId);
            await ctx.reply(
              '🆕 <b>Новый чат начат.</b>\n\nКонтекст очищен — задавай любой вопрос с чистого листа.',
              { parse_mode: 'HTML' },
            );
            return;
          }
          case 'balance': {
            await sendBalanceCard(ctx, userId);
            return;
          }
          case 'help': {
            await sendHelpCard(ctx);
            return;
          }
          case 'chat_hint': {
            // rev 27j: starter questions discoverable via inline-kb taps.
            const starterKb = new InlineKeyboard()
              .text('📊 Что у меня самое прибыльное?', 'ai_starter:top_profit').row()
              .text('🚨 Что у меня сейчас плохо?', 'ai_starter:anomalies').row()
              .text('📦 Что на грани OOS?', 'ai_starter:oos_soon').row()
              .text('💰 Где маржа < 15%?', 'ai_starter:low_margin').row();
            await ctx.reply(
              '💬 <b>Чат с ИИ-агентом</b>\n\nПросто напиши вопрос текстом — я отвечу с данными твоего кабинета.\n\n' +
                '<b>Или начни с готового вопроса:</b>',
              { parse_mode: 'HTML', reply_markup: starterKb },
            );
            return;
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, kbVerb }, 'reply-kb route failed');
      }
    }

    // Supply-flow dispatch (rev 25p): if there's an active flow, treat
    // this free-text as flow input rather than LLM input. Each step
    // either advances the flow + clears the flow on completion, or
    // re-prompts with a clarification.
    const flow = await getSupplyFlow(userId);
    if (flow && flow.step === 'quantity') {
      const qty = parseInt(text.replace(/\s+/g, ''), 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) {
        await ctx.reply('🤔 Не понял количество. Напиши целое число (например, 50) или нажми «Отмена».');
        return;
      }
      try {
        const draftId = await createBotSupplyDraft({
          workspaceId: flow.workspaceId,
          shopId: flow.shopId,
          nmId: flow.nmId,
          title: flow.productTitle,
          quantity: qty,
          currentStock: flow.currentStock,
          avgDaily: flow.avgDaily,
        });
        await clearSupplyFlow(userId);
        // rev 27c: add "Отправить в WB" CTA next to the draft confirmation.
        const submitKb = new InlineKeyboard()
          .text('📤 Отправить в WB', `supply_confirm:${draftId}`).row()
          .text('🏠 Меню', 'menu:main');
        await ctx.reply(buildSupplyCreated(draftId, flow.productTitle, qty), {
          parse_mode: 'HTML',
          reply_markup: submitKb,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, userId }, 'createBotSupplyDraft failed');
        await ctx.reply('⚠️ Не получилось создать черновик. Попробуй ещё раз через минуту.');
      }
      return;
    }

    // Pseudo-streaming UX (rev 25w + rev 26c). One Telegram message gets
    // edited as the model thinks: tool stages appear as separate lines, the
    // streamed final answer renders below a divider. 800ms debounce keeps
    // us under Telegram's per-chat edit budget.
    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    } catch { /* best-effort */ }
    const placeholder = await ctx.reply('🤔 <i>Думаю…</i>', { parse_mode: 'HTML' });
    const placeholderId = placeholder.message_id;

    interface ToolStage { name: string; ok?: boolean; summary?: string }
    const stages: ToolStage[] = [];
    const pendingNonces: string[] = [];
    let streamedText = '';

    const renderStages = (): string => {
      const lines: string[] = [];
      lines.push(`🧠 <i>${escapeHtmlForChat(text.slice(0, 80))}</i>`);
      for (const s of stages) {
        const label = TOOL_LABEL_RU[s.name] ?? `🔧 ${s.name}`;
        if (s.ok === undefined) {
          lines.push(`${label}…`);
        } else if (s.ok) {
          const tail = s.summary ? ` → <i>${escapeHtmlForChat(s.summary)}</i>` : ' ✅';
          lines.push(`${label}${tail}`);
        } else {
          lines.push(`${label} ❌${s.summary ? ' — ' + escapeHtmlForChat(s.summary) : ''}`);
        }
      }
      if (streamedText) {
        if (stages.length > 0) lines.push('─────');
        const visible = streamedText.replace(/\[BUTTON:[^\]]*\]/g, '').trim();
        if (visible) lines.push(visible);
      } else if (stages.length === 0) {
        lines.push('🤔 <i>Думаю…</i>');
      }
      return lines.join('\n');
    };

    let lastEdit = 0;
    let lastText = '';
    const flush = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastEdit < 800) return;
      const rendered = renderStages();
      if (rendered === lastText) return;
      lastEdit = now;
      lastText = rendered;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, placeholderId, rendered, { parse_mode: 'HTML' });
      } catch { /* parse-mode or rate errors — silent, final edit fixes it */ }
    };

    const debouncedEdit = async (textSoFar: string): Promise<void> => {
      streamedText = textSoFar;
      await flush();
    };

    const onEvent = async (e: LlmEvent): Promise<void> => {
      if (e.type === 'tool_start') {
        stages.push({ name: e.name });
        await flush(true);
      } else if (e.type === 'tool_end') {
        for (let i = stages.length - 1; i >= 0; i--) {
          if (stages[i].name === e.name && stages[i].ok === undefined) {
            stages[i] = { name: e.name, ok: e.ok, summary: e.summary };
            break;
          }
        }
        if (e.pendingNonce) pendingNonces.push(e.pendingNonce);
        await flush(true);
      }
    };

    const sessionId = await getOrCreateActiveSession(userId, chatId);
    try {
      const result = await chatWithLLM(userId, text, {
        onProgress: debouncedEdit,
        onEvent,
        sessionId,
      });
      const parsed = parseLLMButtons(result.text);
      logger.info(
        { userId, toolCalls: result.toolCalls, len: parsed.text.length, buttons: parsed.buttons.length },
        'llm chat reply',
      );
      const finalOpts: any = { parse_mode: 'HTML' };
      if (parsed.buttons.length > 0) {
        finalOpts.reply_markup = { inline_keyboard: parsed.buttons };
      }
      try {
        await ctx.api.editMessageText(ctx.chat.id, placeholderId, parsed.text, finalOpts);
      } catch {
        // Fall back to a fresh reply if the edit fails (e.g. message too
        // old, parse-mode HTML error in the final text).
        await ctx.reply(parsed.text, finalOpts);
      }
      // rev 26d: after the AI response lands, deliver any proposed write
      // actions as separate confirmation cards. Keeping them OUT of the
      // streamed body means tap-targets stay visible even if the user
      // scrolls back through the answer.
      for (const nonce of pendingNonces) {
        const action = await loadPending(userId, nonce);
        if (!action) continue;
        const card = renderConfirmationCard(action);
        const kb = new InlineKeyboard()
          .text('✅ Применить', `cnf:${nonce}`)
          .text('❌ Отменить', `cnl:${nonce}`).row();
        await ctx.reply(card, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, userId }, 'llm chat failed');
      try {
        await ctx.api.editMessageText(ctx.chat.id, placeholderId,
          '⚠️ AI-чат недоступен. Попробуй позже или используй /help.', { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ AI-чат недоступен. Попробуй позже или используй /help.');
      }
    }
  });
}
