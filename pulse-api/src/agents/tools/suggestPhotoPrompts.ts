/**
 * Tool: suggest_photo_prompts
 *
 * Subagent-обёртка вокруг `suggestPromptsForProduct` для вызова из AI-чата.
 * Безопасный query-tool (без confirmation), не пишет в WB — только генерирует
 * текстовые промпты на основе карточки товара + опционально аудита.
 *
 * Результат сохраняется в `studio_prompt_suggestions` (история Studio).
 * Пользователь видит промпты в чате и может открыть Студию для генерации.
 */

import { suggestPromptsForProduct } from '../../services/promptSuggester.js';

interface Args {
  nmId: number;
  auditId?: number;
  count?: number;
  // Injected by executeNode:
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function suggestPhotoPrompts(args: Args): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  if (!args.nmId || args.nmId <= 0) {
    return JSON.stringify({ error: 'Некорректный артикул' });
  }

  try {
    const result = await suggestPromptsForProduct({
      workspaceId: wsId,
      nmId: args.nmId,
      shopId: args._shopId ?? null,
      auditId: args.auditId ?? null,
      userId: args._userId ?? null,
      count: args.count,
    });

    const compactPrompts = result.prompts.map((p) => ({
      kind: p.kind,
      title: p.title,
      reasoning: p.reasoning,
      targetModel: p.targetModel,
      aspectRatio: p.aspectRatio,
      dimensions: p.dimensions,
      estimatedCostRub: p.estimatedCostRub,
      promptText: p.promptText,
    }));

    // Готовая ссылка для UI — открывает Студию с первым промптом уже заполненным
    const studioUrl = `/studio?nmId=${args.nmId}${args.auditId ? `&source=audit&auditId=${args.auditId}` : ''}`;

    return JSON.stringify({
      nmId: args.nmId,
      product: result.productContext,
      count: compactPrompts.length,
      prompts: compactPrompts,
      studioUrl,
      hint: `Промпты сохранены в историю Студии. Пользователь может открыть ${studioUrl} → вкладка «История промптов» для выбора и запуска генерации.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg, nmId: args.nmId });
  }
}
