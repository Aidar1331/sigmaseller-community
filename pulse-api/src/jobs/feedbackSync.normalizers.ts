/**
 * Pure normalizers для WB feedbacks/questions.
 *
 * Вынесено из feedbackSync.ts чтобы можно было покрыть юнит-тестами без
 * импорта db/client (который требует DATABASE_URL/JWT_SECRET env).
 *
 * Если WB поменяет структуру ответа /api/v1/feedbacks/* или /api/v1/questions/*,
 * тесты в tests/jobs/feedbackSync.normalizer.test.ts отловят регрессию.
 */

function pickString(obj: any, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickNumber(obj: any, keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function normalizeFeedback(item: any, workspaceId: number, shopId: number) {
  const itemId = String(
    item?.id ?? item?.feedbackId ?? item?.reviewId ?? item?.uid ?? item?.uuid ?? '',
  ).trim();
  if (!itemId) return null;

  const nmId =
    pickNumber(item, ['nmId', 'nm_id', 'nmid', 'nmID']) ??
    pickNumber(item?.productDetails, ['nmId', 'nm_id', 'nmid', 'nmID']);
  const productTitle =
    pickString(item, ['productTitle', 'productName', 'subjectName', 'nmName']) ??
    pickString(item?.productDetails, ['productName', 'name', 'title']);
  const brandName =
    pickString(item, ['brandName', 'brand']) ??
    pickString(item?.productDetails, ['brandName', 'brand']);
  const vendorCode =
    pickString(item, ['vendorCode', 'vendor_code', 'supplierArticle']) ??
    pickString(item?.productDetails, ['supplierArticle']);
  // Clamp в 1-5: WB иногда возвращает мусорные значения; всё что вне диапазона → null
  const rawRating = pickNumber(item, ['rating', 'rank', 'score', 'productValuation']);
  const rating = rawRating != null && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
  const userName = pickString(item, ['userName', 'user_name', 'authorName', 'author']);
  const text = pickString(item, ['text', 'reviewText', 'comment', 'body']) ?? '';
  const pros = pickString(item, ['pros', 'advantages']);
  const cons = pickString(item, ['cons', 'disadvantages']);
  const photoLinks = Array.isArray(item?.photoLinks) ? item.photoLinks : [];
  const answerText =
    pickString(item, ['answerText', 'responseText']) ?? pickString(item?.answer, ['text']);
  const answerState =
    pickString(item, ['answerState', 'status']) ?? pickString(item?.answer, ['state']);
  // WB v1 определяет статус через TOP-LEVEL `state`:
  //   'none'  → нет ответа
  //   'wbRu'  → ответ есть (даже если answer.text/state приходят пустыми —
  //             это особенность WB API).
  const topState = pickString(item, ['state']);
  const isAnswered = Boolean(
    item?.isAnswered ?? item?.answered ?? answerText ?? (topState && topState !== 'none'),
  );

  return {
    workspaceId,
    shopId,
    marketplace: 'wb' as const,
    itemType: 'review' as const,
    itemId,
    nmId: nmId ?? null,
    vendorCode,
    productTitle,
    brandName,
    userName,
    rating,
    text,
    pros,
    cons,
    photosCount: photoLinks.length,
    hasVideo: Boolean(item?.video),
    answerText,
    answerState,
    isAnswered,
    status: isAnswered ? ('answered' as const) : ('new' as const),
    createdAt: toDate(item?.createdDate ?? item?.createdAt ?? item?.dateCreated),
    updatedAt: toDate(item?.updatedDate ?? item?.updatedAt),
    answeredAt: toDate(item?.answeredAt ?? item?.answerDate),
    syncedAt: new Date(),
    raw: item ?? {},
  };
}

export function normalizeQuestion(item: any, workspaceId: number, shopId: number) {
  const itemId = String(
    item?.id ?? item?.questionId ?? item?.questionID ?? item?.uid ?? '',
  ).trim();
  if (!itemId) return null;

  const nmId =
    pickNumber(item, ['nmId', 'nm_id', 'nmid', 'nmID']) ??
    pickNumber(item?.productDetails, ['nmId', 'nm_id', 'nmid', 'nmID']);
  const productTitle =
    pickString(item, ['productTitle', 'productName', 'subjectName', 'nmName']) ??
    pickString(item?.productDetails, ['productName', 'name', 'title']);
  const brandName =
    pickString(item, ['brandName', 'brand']) ??
    pickString(item?.productDetails, ['brandName', 'brand']);
  const vendorCode =
    pickString(item, ['vendorCode', 'vendor_code', 'supplierArticle']) ??
    pickString(item?.productDetails, ['supplierArticle']);

  const text = pickString(item, ['text', 'question', 'body', 'comment']) ?? '';
  const answerText =
    pickString(item, ['answerText', 'responseText']) ?? pickString(item?.answer, ['text']);
  const answerState =
    pickString(item, ['answerState', 'status']) ?? pickString(item?.answer, ['state']);
  const topState = pickString(item, ['state']);
  const isAnswered = Boolean(
    item?.isAnswered ?? item?.answered ?? answerText ?? (topState && topState !== 'none'),
  );

  return {
    workspaceId,
    shopId,
    marketplace: 'wb' as const,
    itemType: 'question' as const,
    itemId,
    nmId: nmId ?? null,
    vendorCode,
    productTitle,
    brandName,
    rating: null,
    text,
    pros: null,
    cons: null,
    answerText,
    answerState,
    isAnswered,
    status: isAnswered ? ('answered' as const) : ('new' as const),
    createdAt: toDate(item?.createdDate ?? item?.createdAt ?? item?.dateCreated),
    updatedAt: toDate(item?.updatedDate ?? item?.updatedAt),
    answeredAt: toDate(item?.answeredAt ?? item?.answerDate),
    syncedAt: new Date(),
    raw: item ?? {},
  };
}
