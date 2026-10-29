import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getCardsList, getSubjectCharacteristics } from '../../integrations/wb/content.js';

interface QueryCardHealthArgs {
  nmIds?: number[];
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryCardHealth(args: QueryCardHealthArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const PAGE_LIMIT = 100;
    const HARD_CAP = 500;
    let cards: Awaited<ReturnType<typeof getCardsList>>['cards'] = [];
    let cursor: { nmID?: number; updatedAt?: string; limit: number } = { limit: PAGE_LIMIT };
    while (cards.length < HARD_CAP) {
      const page = await getCardsList(apiKey, { cursor });
      const pageCards = page?.cards ?? [];
      cards.push(...pageCards);
      const total = page?.cursor?.total ?? pageCards.length;
      if (total < PAGE_LIMIT) break;
      cursor = { nmID: page.cursor.nmID, updatedAt: page.cursor.updatedAt, limit: PAGE_LIMIT };
    }
    if (args.nmIds?.length) {
      const wanted = new Set(args.nmIds);
      cards = cards.filter((c) => wanted.has(c.nmID));
    }
    const results: any[] = [];

    for (const card of cards) {
      let score = 0;
      const issues: string[] = [];

      // Title check
      if (card.title && card.title.length >= 20) { score += 20; }
      else { issues.push('Короткий заголовок (< 20 символов)'); }

      // Description check
      if (card.description && card.description.length >= 100) { score += 20; }
      else { issues.push('Короткое описание (< 100 символов)'); }

      // Photos check
      const photoCount = card.photos?.length ?? 0;
      if (photoCount >= 3) { score += 25; }
      else if (photoCount >= 1) { score += 10; issues.push(`Мало фото (${photoCount}), рекомендуется 3+`); }
      else { issues.push('Нет фотографий'); }

      // Characteristics check
      const charcsCount = card.characteristics?.length ?? 0;
      if (charcsCount >= 5) { score += 20; }
      else if (charcsCount >= 2) { score += 10; issues.push('Мало характеристик'); }
      else { issues.push('Критически мало характеристик'); }

      // Sizes/barcodes check
      const sizesCount = card.sizes?.length ?? 0;
      if (sizesCount >= 1) { score += 15; }
      else { issues.push('Нет размеров/баркодов'); }

      results.push({
        nmId: card.nmID,
        vendorCode: card.vendorCode,
        title: card.title?.slice(0, 80),
        score,
        issues,
        photoCount,
        charcsCount,
        sizesCount,
      });
    }

    const avgScore = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
      : 0;

    return JSON.stringify({
      totalCards: results.length,
      averageScore: avgScore,
      criticalCards: results.filter(r => r.score < 50).length,
      cards: results.sort((a, b) => a.score - b.score),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка проверки карточек' });
  }
}
