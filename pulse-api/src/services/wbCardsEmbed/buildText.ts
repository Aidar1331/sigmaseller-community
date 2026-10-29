/**
 * Сборка текста для embedding карточки товара.
 *
 * Принцип: один embedding на карточку. Текст агрегирует title, brand,
 * категорию, описание и характеристики — всё что юзер может спросить
 * семантически («подарок маме», «синяя кожанка 38 размера», «парфюм
 * восточный шипровый»).
 *
 * Embedded text также сохраняется в `wb_cards.embedding_text` для:
 *   - дебага (что именно ушло в эмбединг)
 *   - дешёвой проверки изменения (если новая строка == старой, не зовём API)
 *
 * Формат — сериализованный плоский текст, не JSON: embedding-модели лучше
 * работают с естественным языком чем со структурой.
 */

interface RawCardCharacteristic {
  id?: number;
  name?: string;
  value?: string | string[] | number | null;
}

interface RawCardData {
  description?: string;
  characteristics?: RawCardCharacteristic[];
  [key: string]: unknown;
}

export interface CardForEmbed {
  nmId: number;
  title?: string | null;
  brandName?: string | null;
  subjectName?: string | null;
  vendorCode?: string | null;
  raw?: RawCardData | null;
}

/**
 * Возвращает каноничный текст для embedding.
 *
 * Пример вывода (брелок-Библия):
 *   «Брелок-Библия. Бренд: VENT-DESIGN. Категория: Брелоки.
 *    Это настоящая мини-книжка, с текстом на английском.
 *    Вид брелока: религиозный. Ставка НДС: Без НДС.
 *    Артикул: BK061»
 */
export function buildCardEmbeddingText(card: CardForEmbed): string {
  const parts: string[] = [];

  // 1) Главное имя — title или fallback'и
  if (card.title?.trim()) {
    parts.push(card.title.trim() + '.');
  }

  // 2) Бренд + категория одной строкой
  const meta: string[] = [];
  if (card.brandName?.trim()) meta.push(`Бренд: ${card.brandName.trim()}`);
  if (card.subjectName?.trim()) meta.push(`Категория: ${card.subjectName.trim()}`);
  if (meta.length) parts.push(meta.join('. ') + '.');

  // 3) Описание — может содержать материал, размеры, стиль; ценный сигнал
  // для семантики. Обрезаем чтобы не сжечь токены: 600 символов = ~150 токенов
  // — достаточно чтобы передать суть, не перетянет вес у title.
  const desc = card.raw?.description?.trim();
  if (desc) {
    parts.push(desc.length > 600 ? desc.slice(0, 600).trim() + '…' : desc);
  }

  // 4) Характеристики — flat «Цвет: Чёрный. Размер: 38.»
  // Пропускаем technical-only (Ставка НДС, ОКПД2, ТНВЭД) — они не помогают
  // семантическому поиску и шумят.
  const TECHNICAL_BLACKLIST = new Set([
    'Ставка НДС', 'ОКПД2', 'ТНВЭД', 'ТН ВЭД', 'Код ТН ВЭД', 'НДС',
    'ИП Пример', // не показывать имя ИП наугад
  ]);
  const chars = card.raw?.characteristics ?? [];
  const charLines: string[] = [];
  for (const c of chars) {
    if (!c?.name) continue;
    if (TECHNICAL_BLACKLIST.has(c.name)) continue;
    const v = c.value;
    const valueStr =
      Array.isArray(v) ? v.filter(Boolean).join(', ') :
      v != null ? String(v).trim() :
      '';
    if (!valueStr) continue;
    charLines.push(`${c.name}: ${valueStr}`);
  }
  if (charLines.length) parts.push(charLines.join('. ') + '.');

  // 5) vendor_code — иногда содержит цвет/размер в имени, последним
  if (card.vendorCode?.trim()) {
    parts.push(`Артикул: ${card.vendorCode.trim()}`);
  }

  // Сводим, чистим лишние пробелы
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Утилита: безопасно ли пропустить ре-эмбединг.
 * Если предыдущий embedding_text равен новому и embedded_at не пустой — да.
 */
export function shouldSkipReembed(prevText: string | null | undefined, newText: string): boolean {
  return typeof prevText === 'string' && prevText === newText;
}
