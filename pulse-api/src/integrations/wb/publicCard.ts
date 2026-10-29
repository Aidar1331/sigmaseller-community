/**
 * WB Public Card API — данные с витрины (без авторизации продавца).
 *
 * Endpoint: card.wb.ru/cards/v4/detail
 * Лимит: ~600 req/мин на IP. Никаких ключей не нужно.
 *
 * Используется для аудита карточек конкурентов: цена, остатки, рейтинг,
 * бренд, поставщик, категория. Это «вид покупателя», поэтому цена тут
 * уже включает СПП и любые промо WB.
 *
 * NB: цены в этом эндпоинте — целые числа в КОПЕЙКАХ×10 (исторически WB
 * использует «pricing unit» = 0.01 копейки). Чтобы получить рубли,
 * делим на 100. Базовая = `price.basic`, витринная (с СПП) = `price.product`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'publicCard' });

const execFileAsync = promisify(execFile);

// WB public CDN (card.wb.ru / basket-*.wbbasket.ru) проверяет TLS/HTTP2
// fingerprint клиента. Node fetch (undici) даёт JA3, который WB блокирует
// 403 даже на корректном UA. curl же проходит штатно. Поэтому делаем
// HTTP-вызовы через child_process curl — простой и надёжный обход без
// внешних зависимостей. Это публичная витрина, никакого обхода ToS.
const CURL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function curlGetJson<T>(url: string, timeoutSec = 8): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-s', '-A', CURL_UA, '--max-time', String(timeoutSec), '--fail-with-body', url],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as T;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    if (e?.code === 22) return null; // 4xx / 5xx
    throw err;
  }
}

async function curlHeadOk(url: string, timeoutSec = 4): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-A', CURL_UA, '--max-time', String(timeoutSec), '-I', url],
      { maxBuffer: 1024 },
    );
    return stdout.trim() === '200';
  } catch {
    return false;
  }
}

export interface PublicCardSize {
  origName: string | null;
  totalQty: number;
  basicKop: number;
  productKop: number;
  logisticsKop: number;
  returnKop: number;
}

export interface PublicCardSummary {
  nmId: number;
  name: string | null;
  brand: string | null;
  brandId: number | null;
  supplier: string | null;
  supplierId: number | null;
  supplierRating: number | null;
  subject: string | null;
  subjectId: number | null;
  /** Базовая цена «до скидки» в КОПЕЙКАХ (= зачёркнутая на сайте). */
  basePriceKop: number | null;
  /** Цена покупателя в КОПЕЙКАХ (включает все WB-скидки и СПП). */
  showcasePriceKop: number | null;
  /** Суммарная скидка от базы до витрины, %. Включает скидку продавца + СПП + промо. */
  totalDiscountPct: number | null;
  /** Сумма остатков по всем размерам/складам. */
  totalQuantity: number;
  /** Кол-во загруженных фото. */
  picsCount: number;
  /** Рейтинг товара (0 = нет оценок). */
  rating: number | null;
  /** Количество отзывов. */
  feedbacks: number | null;
  /** Размеры с остатками. */
  sizes: PublicCardSize[];
  /** ID активных промо-акций WB. */
  promotionIds: number[];
  /** Среднее время доставки в часах (по основному складу). */
  deliveryHours: number | null;
  /** Прямая ссылка на витрину. */
  url: string;
  /** Полное описание товара (из basket CDN, если доступен). */
  description?: string | null;
  /** Характеристики «название → значение». */
  characteristics?: Array<{ name: string; value: string }>;
  /** Артикул продавца (vendor_code из basket card.json). */
  vendorCode?: string | null;
  /** URLs фото (большие jpg/webp). Пусто если basket не найден. */
  photoUrls?: string[];
}

/**
 * basket-номер CDN, на котором хранятся info+фото для данного vol-диапазона.
 * Карта baskets у WB меняется — для надёжности пробуем параллельно 1..40,
 * первый ответ 200 кешируем в памяти процесса. Повторные запросы по тому
 * же vol мгновенные.
 */
const volBasketCache = new Map<number, number>();

async function findBasket(nmId: number): Promise<number | null> {
  const vol = Math.floor(nmId / 100000);
  const cached = volBasketCache.get(vol);
  if (cached) return cached;

  const part = Math.floor(nmId / 1000);
  const tasks = Array.from({ length: 40 }, (_, i) => i + 1).map(async (b) => {
    const url = `https://basket-${String(b).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
    return (await curlHeadOk(url, 4)) ? b : null;
  });
  const results = await Promise.all(tasks);
  const hit = results.find((x): x is number => x != null);
  if (hit != null) {
    volBasketCache.set(vol, hit);
    return hit;
  }
  return null;
}

interface RawCardJson {
  imt_name?: string;
  vendor_code?: string;
  description?: string;
  options?: Array<{ name?: string; value?: string }>;
  media?: {
    photo_count?: number;
  };
}

/**
 * Скачать описание и характеристики из basket CDN. Возвращает null если
 * не удалось найти basket или JSON некорректный.
 */
async function fetchBasketCard(nmId: number): Promise<{
  basket: number;
  description: string | null;
  characteristics: Array<{ name: string; value: string }>;
  vendorCode: string | null;
  photoCount: number;
} | null> {
  const basket = await findBasket(nmId);
  if (basket == null) {
    logger.warn({ nmId }, 'WB basket not found in 1..40 — карточка слишком новая или CDN перестроен');
    return null;
  }
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  const url = `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
  try {
    const data = await curlGetJson<RawCardJson>(url, 6);
    if (!data) return null;
    const opts = Array.isArray(data.options) ? data.options : [];
    const characteristics = opts
      .filter((o) => o.name && o.value)
      .map((o) => ({ name: String(o.name), value: String(o.value) }));
    return {
      basket,
      description: data.description ? String(data.description).trim() : null,
      characteristics,
      vendorCode: data.vendor_code ? String(data.vendor_code) : null,
      photoCount: Number(data.media?.photo_count ?? 0),
    };
  } catch (err) {
    logger.warn({ nmId, err: err instanceof Error ? err.message : String(err) }, 'basket card.json fetch failed');
    return null;
  }
}

/**
 * Построить URL N-го фото товара (big webp). Требует найденный basket.
 */
function buildPhotoUrl(nmId: number, basket: number, index1Based: number): string {
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  return `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/big/${index1Based}.webp`;
}

interface RawProduct {
  id: number;
  name?: string;
  brand?: string;
  brandId?: number;
  supplier?: string;
  supplierId?: number;
  supplierRating?: number;
  subject?: string;
  subjectId?: number;
  pics?: number;
  rating?: number;
  reviewRating?: number;
  nmReviewRating?: number;
  feedbacks?: number;
  nmFeedbacks?: number;
  totalQuantity?: number;
  promotions?: number[];
  time1?: number;
  sizes?: Array<{
    origName?: string;
    name?: string;
    stocks?: Array<{ qty: number }>;
    price?: {
      basic?: number;
      product?: number;
      logistics?: number;
      return?: number;
    };
  }>;
}

/**
 * Fetch publicly-visible card data by nmId.
 *
 * Возвращает null если карточка не найдена или WB вернул пустой ответ.
 * Кидает ошибку только при сетевом сбое или 4xx/5xx.
 */
export async function fetchPublicCard(nmId: number): Promise<PublicCardSummary | null> {
  if (!Number.isFinite(nmId) || nmId <= 0) return null;

  const url = `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&hide_dtype=10&spp=30&lang=ru&nm=${nmId}`;

  let raw: any;
  try {
    raw = await curlGetJson<any>(url, 8);
    if (!raw) {
      logger.warn({ nmId }, 'WB public card not found (4xx/empty)');
      return null;
    }
  } catch (err) {
    logger.error({ nmId, err: err instanceof Error ? err.message : String(err) }, 'WB public card fetch failed');
    throw err;
  }

  const products: RawProduct[] = Array.isArray(raw?.products) ? raw.products : Array.isArray(raw?.data?.products) ? raw.data.products : [];
  const p = products.find((x) => Number(x?.id) === nmId);
  if (!p) return null;

  const sizes: PublicCardSize[] = (p.sizes ?? []).map((s) => {
    const stockQty = (s.stocks ?? []).reduce((acc, st) => acc + (Number(st.qty) || 0), 0);
    return {
      origName: s.origName ?? s.name ?? null,
      totalQty: stockQty,
      // price.basic / price.product хранятся в КОПЕЙКАХ напрямую
      // (1 259 600 → 12 596 ₽). Проверено E2E 2026-06-01 на nm=610835116
      // против витрины wildberries.ru.
      basicKop: Math.round(s.price?.basic ?? 0),
      productKop: Math.round(s.price?.product ?? 0),
      logisticsKop: Math.round(s.price?.logistics ?? 0),
      returnKop: Math.round(s.price?.return ?? 0),
    };
  });

  // Цена товара — берём с самого ходового размера (наибольший остаток).
  const sortedBySize = [...sizes].sort((a, b) => b.totalQty - a.totalQty);
  const headSize = sortedBySize[0] ?? sizes[0] ?? null;
  const basePriceKop = headSize && headSize.basicKop > 0 ? headSize.basicKop : null;
  const showcasePriceKop = headSize && headSize.productKop > 0 ? headSize.productKop : null;
  const totalDiscountPct = basePriceKop && showcasePriceKop && basePriceKop > 0
    ? Math.round(((basePriceKop - showcasePriceKop) / basePriceKop) * 100)
    : null;

  // Рейтинг: nmReviewRating > reviewRating > rating
  const rating = p.nmReviewRating ?? p.reviewRating ?? p.rating ?? null;
  const feedbacks = p.nmFeedbacks ?? p.feedbacks ?? null;
  const picsCount = Number(p.pics ?? 0);

  // Подтягиваем описание + характеристики + URLs фото из basket CDN.
  // Параллельно с тем, что уже есть из card.wb.ru. Если basket не найден
  // (свежая карточка, переехавшая в новый шард) — возвращаем без них.
  const basketData = await fetchBasketCard(nmId).catch(() => null);
  let photoUrls: string[] = [];
  if (basketData) {
    const photoCount = basketData.photoCount > 0 ? basketData.photoCount : picsCount;
    photoUrls = Array.from({ length: photoCount }, (_, i) => buildPhotoUrl(nmId, basketData.basket, i + 1));
  }

  return {
    nmId,
    name: p.name ?? null,
    brand: p.brand && p.brand !== '' ? p.brand : null,
    brandId: p.brandId ?? null,
    supplier: p.supplier ?? null,
    supplierId: p.supplierId ?? null,
    supplierRating: p.supplierRating ?? null,
    subject: p.subject ?? null,
    subjectId: p.subjectId ?? null,
    basePriceKop,
    showcasePriceKop,
    totalDiscountPct,
    totalQuantity: Number(p.totalQuantity ?? sizes.reduce((s, x) => s + x.totalQty, 0)),
    picsCount,
    rating: rating != null ? Number(rating) : null,
    feedbacks: feedbacks != null ? Number(feedbacks) : null,
    sizes,
    promotionIds: Array.isArray(p.promotions) ? p.promotions : [],
    deliveryHours: p.time1 != null ? Math.round(Number(p.time1) / 60) : null,
    url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
    description: basketData?.description ?? null,
    characteristics: basketData?.characteristics ?? [],
    vendorCode: basketData?.vendorCode ?? null,
    photoUrls,
  };
}
