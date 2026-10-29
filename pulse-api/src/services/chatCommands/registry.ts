/**
 * Реестр slash-команд для AI-чата (2026-06-01).
 *
 * Команда (например `/audit 731640698`) перехватывается в /ai/chat
 * route и выполняется БЕЗ LLM-размышлений: парсер вытащит args, executor
 * вызовет соответствующий AI-tool с уже готовыми параметрами.
 *
 * Чем это лучше «обычного» AI-чата:
 *   - Мгновенно (не нужно ждать LLM рассуждения)
 *   - Дёшево (0 input/output токенов LLM на саму команду)
 *   - Предсказуемо (команда всегда делает одно и то же)
 *
 * Категории:
 *   product   — действия по конкретному артикулу
 *   search    — поиск товаров в каталоге
 *   money     — финансы, цены, реклама
 *   logistics — поставки и склад
 *   feedback  — отзывы, вопросы, чаты
 *   action    — необратимые действия в кабинете WB
 *   meta      — служебные (help, version)
 */

export type CommandCategory = 'product' | 'search' | 'money' | 'logistics' | 'feedback' | 'action' | 'meta';

export interface CommandArg {
  /** Имя аргумента (для парсинга и help) */
  name: string;
  /** Тип — для базовой валидации */
  type: 'nmId' | 'string' | 'number' | 'date' | 'percent' | 'optional-rest';
  /** Опциональный? */
  optional?: boolean;
  /** Подсказка в help (пример или короткое описание) */
  hint?: string;
}

export interface CommandSpec {
  /** Имя без слэша */
  name: string;
  /** Алиасы (короткие формы или синонимы) */
  aliases?: string[];
  category: CommandCategory;
  /** Короткое описание для /help (≤80 символов) */
  description: string;
  args: CommandArg[];
  /** Имя AI-tool который дергаем (если есть). Если null — кастомный handler */
  tool: string | null;
  /** Если команда требует подтверждения (write-операции) */
  requiresConfirm?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Реестр. Команда = единственный источник истины. UI (autocomplete) и
// /help рендерятся из этого массива.
// ─────────────────────────────────────────────────────────────────────

export const COMMANDS: CommandSpec[] = [
  // ── META ──────────────────────────────────────────────────────────
  {
    name: 'help',
    aliases: ['?', 'commands'],
    category: 'meta',
    description: 'Список всех команд и краткая справка',
    args: [{ name: 'topic', type: 'string', optional: true, hint: 'категория или имя команды' }],
    tool: null, // обрабатывается напрямую в executor
  },

  // ── PRODUCT (всё что про конкретный артикул) ─────────────────────
  {
    name: 'audit',
    category: 'product',
    description: 'AI-аудит карточки по метрикам и событиям. Что не так и что делать',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'periodDays', type: 'number', optional: true, hint: 'по умолчанию 30' }],
    tool: 'product_metrics_audit',
  },
  {
    name: 'audit-content',
    aliases: ['content-audit'],
    category: 'product',
    description: 'AI-аудит контента карточки (title, фото, характеристики)',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: 'query_card_health',
  },
  {
    name: 'events',
    aliases: ['log'],
    category: 'product',
    description: 'События по артикулу: цена, поставка, акция, AI-действия',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'days', type: 'number', optional: true, hint: 'по умолчанию 30' }],
    tool: 'query_alerts',
  },
  {
    name: 'funnel',
    category: 'product',
    description: 'Воронка артикула: показы → корзина → заказ → выкуп',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'days', type: 'number', optional: true }],
    tool: 'query_funnel',
  },
  {
    name: 'seo',
    category: 'product',
    description: 'SEO позиции артикула по ключам',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: 'query_seo',
  },
  {
    name: 'buyout',
    category: 'product',
    description: 'Процент выкупа артикула и сравнение со средним',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: 'query_funnel',
  },
  {
    name: 'card',
    aliases: ['details'],
    category: 'product',
    description: 'Полная карточка артикула: метрики, остатки, реклама, цена',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: 'query_product',
  },

  // ── SEARCH ───────────────────────────────────────────────────────
  {
    name: 'find',
    aliases: ['search'],
    category: 'search',
    description: 'Семантический поиск товара в каталоге («подарок маме»)',
    args: [{ name: 'query', type: 'optional-rest', hint: 'свободный текст' }],
    tool: 'query_products_by_semantics',
  },
  {
    name: 'similar',
    category: 'search',
    description: 'Найти товары похожие на артикул',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'limit', type: 'number', optional: true }],
    tool: 'query_products_by_semantics',
  },
  {
    name: 'where',
    aliases: ['chars'],
    category: 'search',
    description: 'Какие характеристики есть у товаров магазина',
    args: [{ name: 'category', type: 'string', optional: true }],
    tool: 'list_available_characteristics',
  },
  {
    name: 'filter',
    category: 'search',
    description: 'Поиск по характеристикам («/filter Цвет=чёрный Сезон=зима»)',
    args: [{ name: 'filters', type: 'optional-rest', hint: 'Ключ=Значение через пробел' }],
    tool: 'query_products_by_characteristics',
  },

  // ── MONEY ────────────────────────────────────────────────────────
  {
    name: 'sales',
    category: 'money',
    description: 'Продажи: заказы, выкуп, возвраты за период',
    args: [{ name: 'days', type: 'number', optional: true, hint: 'по умолчанию 7' }],
    tool: 'query_sales',
  },
  {
    name: 'finance',
    aliases: ['profit'],
    category: 'money',
    description: 'Финансы: выручка, маржа, ДРР, прибыль',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_finance',
  },
  {
    name: 'abc',
    category: 'money',
    description: 'ABC-анализ товаров (A=80% выручки, B=15%, C=5%)',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_sales',
  },
  {
    name: 'regions',
    category: 'money',
    description: 'Продажи и заказы по регионам',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_regional',
  },
  {
    name: 'ads',
    aliases: ['advertising'],
    category: 'money',
    description: 'Реклама: расход, ДРР, кампании с проблемами',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_advertising',
  },
  {
    name: 'drr',
    category: 'money',
    description: 'ДРР по товарам — какие кампании сливают',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_advertising',
  },

  // ── LOGISTICS ────────────────────────────────────────────────────
  {
    name: 'stocks',
    aliases: ['stock'],
    category: 'logistics',
    description: 'Остатки по складам и предупреждения о выбытии',
    args: [{ name: 'nmId', type: 'nmId', optional: true, hint: 'опц. фильтр по артикулу' }],
    tool: 'query_stocks',
  },
  {
    name: 'restock',
    category: 'logistics',
    description: 'Когда подвозить артикул на склад (прогноз)',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: 'query_stocks',
  },
  {
    name: 'warehouses',
    aliases: ['warehouse'],
    category: 'logistics',
    description: 'Склады WB и текущие коэффициенты приёмки',
    args: [],
    tool: 'query_warehouses',
  },
  {
    name: 'supplies',
    aliases: ['supply'],
    category: 'logistics',
    description: 'Активные поставки FBO/FBS и их статусы',
    args: [],
    tool: 'query_supplies',
  },
  {
    name: 'storage',
    category: 'logistics',
    description: 'Стоимость платного хранения по товарам',
    args: [{ name: 'days', type: 'number', optional: true }],
    tool: 'query_storage',
  },

  // ── FEEDBACK ─────────────────────────────────────────────────────
  {
    name: 'reviews',
    aliases: ['feedbacks'],
    category: 'feedback',
    description: 'Последние отзывы которые ждут ответа',
    args: [{ name: 'rating', type: 'number', optional: true, hint: 'фильтр 1-5' }],
    tool: 'query_feedback_summary',
  },
  {
    name: 'negative',
    category: 'feedback',
    description: 'Критические отзывы (1-2 звезды) которые нужно срочно отработать',
    args: [],
    tool: 'query_feedback_summary',
  },
  {
    name: 'questions',
    category: 'feedback',
    description: 'Вопросы покупателей которые ждут ответа',
    args: [],
    tool: 'query_questions',
  },
  {
    name: 'chats',
    category: 'feedback',
    description: 'Активные чаты с покупателями',
    args: [],
    tool: 'query_chats',
  },

  // ── ACTION (write — нужно подтверждение) ─────────────────────────
  {
    name: 'price',
    category: 'action',
    description: 'Изменить цену артикула (на сумму или %)',
    args: [
      { name: 'nmId', type: 'nmId' },
      { name: 'change', type: 'percent', hint: '«-5%» или «1500» (новая цена в ₽)' },
    ],
    tool: 'action_set_price',
    requiresConfirm: true,
  },
  {
    name: 'reply',
    category: 'action',
    description: 'Ответить на отзыв (AI готовит черновик, ты подтверждаешь)',
    args: [{ name: 'feedbackId', type: 'string' }],
    tool: 'action_reply_feedback',
    requiresConfirm: true,
  },
  {
    name: 'pause-ad',
    category: 'action',
    description: 'Поставить рекламную кампанию на паузу',
    args: [{ name: 'campaignId', type: 'number' }],
    tool: 'action_pause_campaign',
    requiresConfirm: true,
  },
  {
    name: 'fbs',
    category: 'action',
    description: 'Создать FBS-поставку для срочной отгрузки',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'qty', type: 'number' }],
    tool: 'action_create_fbs_supply',
    requiresConfirm: true,
  },
  {
    name: 'fbw',
    category: 'action',
    description: 'Подготовить заявку FBW (открывает форму брони в WB)',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'qty', type: 'number' }, { name: 'warehouseId', type: 'number', optional: true }],
    tool: 'action_prepare_fbw_supply',
    requiresConfirm: true,
  },
  {
    name: 'discount',
    category: 'action',
    description: 'Поставить или изменить скидку на артикул (%)',
    args: [{ name: 'nmId', type: 'nmId' }, { name: 'pct', type: 'percent' }],
    tool: 'action_set_price',
    requiresConfirm: true,
  },
  {
    name: 'ab-photo',
    aliases: ['ab', 'abtest'],
    category: 'action',
    description: 'Запустить A/B-тест главного фото',
    args: [{ name: 'nmId', type: 'nmId' }],
    tool: null, // редирект на UI /ab-photo с pre-fill nm_id
    requiresConfirm: true,
  },
];

/** Быстрый поиск команды по имени или alias. Регистр-независимый. */
export function findCommand(name: string): CommandSpec | null {
  const lower = name.toLowerCase();
  for (const c of COMMANDS) {
    if (c.name === lower) return c;
    if (c.aliases?.includes(lower)) return c;
  }
  return null;
}

/** Подобрать команды по prefix для autocomplete. Сортировка по релевантности:
 * сначала те где имя начинается с prefix, потом те где prefix в середине. */
export function suggestCommands(prefix: string, limit = 8): CommandSpec[] {
  const p = prefix.toLowerCase().replace(/^\//, '');
  if (!p) return COMMANDS.slice(0, limit);
  const starts: CommandSpec[] = [];
  const contains: CommandSpec[] = [];
  for (const c of COMMANDS) {
    if (c.name.startsWith(p)) { starts.push(c); continue; }
    if (c.aliases?.some((a) => a.startsWith(p))) { starts.push(c); continue; }
    if (c.name.includes(p) || c.description.toLowerCase().includes(p)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, limit);
}

export function listByCategory(): Record<CommandCategory, CommandSpec[]> {
  const out: Record<CommandCategory, CommandSpec[]> = {
    product: [], search: [], money: [], logistics: [], feedback: [], action: [], meta: [],
  };
  for (const c of COMMANDS) out[c.category].push(c);
  return out;
}
