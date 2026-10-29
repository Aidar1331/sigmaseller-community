/**
 * Executor для slash-команд.
 *
 * Принимает ParsedCommand и контекст (workspaceId/shopId/userId),
 * выполняет соответствующий AI-tool, возвращает структурированный результат
 * для отрисовки в чате.
 *
 * Если команда — `/help` или unknown — отдаём human-readable текст без вызова tool.
 * Если команда requiresConfirm — НЕ выполняем сразу, отдаём action-card
 * с кнопками «Применить»/«Отменить» (UI решит как показать).
 */

import { getToolByName } from '../../agents/tools/index.js';
import { COMMANDS, findCommand, listByCategory, suggestCommands } from './registry.js';
import { type ParsedCommand } from './parser.js';

export interface ExecContext {
  workspaceId: number;
  shopId?: number;
  userId?: number;
}

export interface CommandResult {
  /** Тип результата для UI */
  type: 'text' | 'tool-result' | 'action-card' | 'error' | 'help' | 'redirect';
  /** Произвольный текст результата (markdown) */
  text?: string;
  /** Если type='tool-result' — JSON-результат tool */
  toolResult?: any;
  /** Имя tool который был вызван (для UI) */
  toolName?: string;
  /** Если type='action-card' — описание действия для подтверждения */
  action?: {
    description: string;
    toolName: string;
    args: Record<string, any>;
  };
  /** Если type='redirect' — на какой роут отправить */
  redirectTo?: string;
}

export async function executeCommand(parsed: ParsedCommand, ctx: ExecContext): Promise<CommandResult> {
  // 1) Ошибки парсинга или unknown — отдаём suggestion + help
  if (parsed.errors.length > 0) {
    const suggestions = suggestCommands(parsed.spec.name, 5);
    const sugText = suggestions.length
      ? '\nМожет ты имел в виду: ' + suggestions.map((s) => `/${s.name}`).join(', ')
      : '';
    return {
      type: 'error',
      text: parsed.errors.join('. ') + sugText,
    };
  }

  // 2) /help [topic] — встроенная обработка
  if (parsed.spec.name === 'help') {
    return renderHelp(parsed.args.topic);
  }

  // 3) Redirect-команды (e.g. /ab-photo → /ab-photo страница с pre-fill)
  if (parsed.spec.tool === null) {
    if (parsed.spec.name === 'ab-photo' || parsed.spec.name === 'ab') {
      const nmId = parsed.args.nmId;
      return {
        type: 'redirect',
        text: `Открой ${`/ab-photo?nmId=${nmId}`} чтобы создать A/B-тест с этим артикулом.`,
        redirectTo: `/ab-photo?nmId=${nmId}`,
      };
    }
    return { type: 'error', text: `Команда /${parsed.spec.name} ещё не реализована.` };
  }

  // 4) write-команды с подтверждением — отдаём action-card вместо выполнения
  if (parsed.spec.requiresConfirm) {
    return {
      type: 'action-card',
      text: `Готовлю действие: ${parsed.spec.description}`,
      action: {
        description: `${parsed.spec.description} (${Object.entries(parsed.args).map(([k, v]) => `${k}=${v}`).join(', ')})`,
        toolName: parsed.spec.tool,
        args: { ...parsed.args, _workspaceId: ctx.workspaceId, _shopId: ctx.shopId, _userId: ctx.userId },
      },
    };
  }

  // 5а) Спецслучай: /audit запускает не tool, а сервис productMetricsAudit
  if (parsed.spec.name === 'audit') {
    const { runProductMetricsAudit } = await import('../productMetricsAudit.js');
    const periodDays = typeof parsed.args.periodDays === 'number' ? parsed.args.periodDays : 30;
    const result = await runProductMetricsAudit(ctx.workspaceId, parsed.args.nmId, periodDays);
    return {
      type: 'tool-result',
      toolName: 'product_metrics_audit',
      toolResult: result,
      text: `Выполнено: /audit ${parsed.args.nmId} (${periodDays} дн)`,
    };
  }

  // 5б) Обычный read-tool — вызываем напрямую
  const tool = getToolByName(parsed.spec.tool);
  if (!tool) {
    return { type: 'error', text: `Tool ${parsed.spec.tool} не зарегистрирован.` };
  }

  try {
    // Заполняем умолчания которые AI обычно добавляет сам (дата периода и т.п.)
    const enrichedArgs = enrichArgs(parsed, ctx);
    const result = await (tool.func as any)(enrichedArgs);
    let parsedResult: any;
    try { parsedResult = JSON.parse(result); }
    catch { parsedResult = result; }

    return {
      type: 'tool-result',
      toolName: parsed.spec.tool,
      toolResult: parsedResult,
      text: `Выполнено: /${parsed.spec.name}`,
    };
  } catch (err: any) {
    return {
      type: 'error',
      text: `Ошибка при выполнении /${parsed.spec.name}: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Подмешиваем стандартные ключи которые AI-tool ожидает: _workspaceId,
 * _shopId, _userId, и автоматические периоды для команд с date-параметром.
 */
function enrichArgs(parsed: ParsedCommand, ctx: ExecContext): Record<string, any> {
  const args: Record<string, any> = {
    ...parsed.args,
    _workspaceId: ctx.workspaceId,
    _shopId: ctx.shopId,
    _userId: ctx.userId,
  };

  // Для money/sales команд если юзер дал «days» — конвертим в from/to для
  // tool который ожидает date range.
  if (typeof args.days === 'number' && (parsed.spec.tool?.startsWith('query_'))) {
    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - args.days);
    args.from = from.toISOString().slice(0, 10);
    args.to = to.toISOString().slice(0, 10);
    delete args.days;
  }

  // Спецсоглашения per-tool:
  if (parsed.spec.name === 'similar' && args.nmId) {
    // /similar <nmId> — мапим в similarToNmId
    args.similarToNmId = args.nmId;
    delete args.nmId;
  }
  if (parsed.spec.name === 'find' && args.query) {
    // имя поля уже query — ничего
  }
  if (parsed.spec.name === 'filter' && args.filters) {
    // «Цвет=чёрный Сезон=зима» → {Цвет:'чёрный', Сезон:'зима'}
    const filters: Record<string, string> = {};
    for (const kv of String(args.filters).split(/\s+/)) {
      const [k, v] = kv.split('=');
      if (k && v) filters[k] = v;
    }
    args.filters = filters;
  }
  if (parsed.spec.name === 'audit' && args.nmId) {
    // productMetricsAudit endpoint берёт workspaceId/nmId/periodDays — не префикс _
    return {
      workspaceId: ctx.workspaceId,
      nmId: args.nmId,
      periodDays: args.periodDays ?? 30,
    };
  }

  return args;
}

/** Рендер /help [topic] */
function renderHelp(topic?: string): CommandResult {
  if (topic) {
    const lower = String(topic).toLowerCase();
    // По имени команды
    const cmd = findCommand(lower);
    if (cmd) {
      const argsLine = cmd.args.map((a) =>
        a.optional ? `[${a.name}]` : `<${a.name}>`,
      ).join(' ');
      return {
        type: 'help',
        text: [
          `**/${cmd.name}** ${argsLine}`,
          cmd.description,
          cmd.aliases?.length ? `Алиасы: ${cmd.aliases.map((a) => `/${a}`).join(', ')}` : null,
          cmd.requiresConfirm ? 'Требует подтверждения «Применить».' : null,
          cmd.args.map((a) => `  — ${a.name}: ${a.hint ?? a.type}${a.optional ? ' (опц.)' : ''}`).join('\n'),
        ].filter(Boolean).join('\n'),
      };
    }
    // По категории
    const byCat = listByCategory();
    if ((byCat as any)[lower]) {
      const list = (byCat as any)[lower] as typeof COMMANDS;
      return {
        type: 'help',
        text: `**Категория ${lower}:**\n` + list.map((c) => `  /${c.name} — ${c.description}`).join('\n'),
      };
    }
    return { type: 'help', text: `Не нашёл «${topic}». Попробуй /help без аргумента.` };
  }

  // /help без аргумента — короткий обзор по категориям
  const byCat = listByCategory();
  const sections = [
    ['🛍️ Товар', byCat.product],
    ['🔍 Поиск', byCat.search],
    ['💰 Деньги', byCat.money],
    ['📦 Логистика', byCat.logistics],
    ['💬 Отзывы', byCat.feedback],
    ['⚡ Действия (с подтверждением)', byCat.action],
  ] as const;

  const lines: string[] = ['**Slash-команды Sigma**', ''];
  for (const [title, list] of sections) {
    if (!list.length) continue;
    lines.push(`**${title}:**`);
    for (const c of list) {
      lines.push(`  /${c.name}${c.aliases?.length ? ` (или /${c.aliases[0]})` : ''} — ${c.description}`);
    }
    lines.push('');
  }
  lines.push('Подробнее по команде: `/help <имя>` или `/help <категория>` (product, search, money, logistics, feedback, action)');

  return { type: 'help', text: lines.join('\n') };
}
