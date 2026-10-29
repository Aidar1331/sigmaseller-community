/**
 * Парсер slash-команд.
 *
 * Принимает первую строку сообщения юзера (которая может начинаться со
 * слэша). Возвращает разобранную команду + объект args для tool-вызова.
 *
 * Не валидирует наличие самой команды — это делает executor. Парсер только
 * разбивает строку и приводит типы.
 */

import { findCommand, type CommandSpec, type CommandArg } from './registry.js';

export interface ParsedCommand {
  spec: CommandSpec;
  /** Аргументы, готовые к передаче в tool. Имена = из spec.args[].name. */
  args: Record<string, any>;
  /** Сырая строка после имени команды — для команд с optional-rest */
  rest: string;
  /** Ошибки парсинга (если есть). Если не пустой — лучше не выполнять. */
  errors: string[];
}

export interface ParseInput {
  text: string;
}

/**
 * Возвращает null если первая строка не является командой
 * (не начинается со «/») — обычный AI-чат-флоу должен продолжиться.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const firstLine = text.split('\n', 1)[0].trim();
  if (!firstLine.startsWith('/')) return null;

  // Разбиваем на токены: «/audit 731640698 90» → ['audit','731640698','90']
  const tokens = firstLine.slice(1).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const cmdName = tokens[0];
  const spec = findCommand(cmdName);
  if (!spec) {
    // Неизвестная команда — возвращаем «обёрнутую» структуру, executor выдаст
    // suggestion list.
    return {
      spec: {
        name: cmdName,
        category: 'meta',
        description: 'unknown',
        args: [],
        tool: null,
      },
      args: {},
      rest: tokens.slice(1).join(' '),
      errors: [`Неизвестная команда «/${cmdName}». Попробуй /help`],
    };
  }

  const rawArgs = tokens.slice(1);
  const result: Record<string, any> = {};
  const errors: string[] = [];

  for (let i = 0; i < spec.args.length; i++) {
    const argSpec = spec.args[i];
    const raw = rawArgs[i];

    if (argSpec.type === 'optional-rest') {
      // Захватывает ВСЁ оставшееся как одну строку («/find подарок маме»)
      const rest = rawArgs.slice(i).join(' ');
      result[argSpec.name] = rest || undefined;
      break;
    }

    if (raw === undefined) {
      if (!argSpec.optional) {
        errors.push(`Не хватает аргумента ${argSpec.name} (${argSpec.hint ?? argSpec.type})`);
      }
      continue;
    }

    const parsed = parseValue(raw, argSpec);
    if (parsed.error) {
      errors.push(`${argSpec.name}: ${parsed.error}`);
    } else {
      result[argSpec.name] = parsed.value;
    }
  }

  return {
    spec,
    args: result,
    rest: rawArgs.join(' '),
    errors,
  };
}

function parseValue(raw: string, spec: CommandArg): { value?: any; error?: string } {
  switch (spec.type) {
    case 'nmId': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        return { error: `ожидается артикул WB (число), а получил «${raw}»` };
      }
      return { value: n };
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { error: `ожидается число, а получил «${raw}»` };
      }
      return { value: n };
    }
    case 'percent': {
      // «-5%», «+10», «1500» (новая цена), «5%»
      // Возвращаем строку — executor решит как трактовать (зависит от tool)
      return { value: raw };
    }
    case 'date': {
      // YYYY-MM-DD или «вчера», «сегодня», «-7д»
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw };
      if (raw === 'сегодня') return { value: new Date().toISOString().slice(0, 10) };
      if (raw === 'вчера') {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return { value: d.toISOString().slice(0, 10) };
      }
      const rel = /^-(\d+)д$/.exec(raw);
      if (rel) {
        const d = new Date(); d.setDate(d.getDate() - Number(rel[1]));
        return { value: d.toISOString().slice(0, 10) };
      }
      return { error: `ожидается дата YYYY-MM-DD или «вчера»/«-7д», а получил «${raw}»` };
    }
    case 'string':
    case 'optional-rest':
      return { value: raw };
    default:
      return { value: raw };
  }
}
