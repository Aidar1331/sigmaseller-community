/**
 * WB Feedbacks & Questions API integration
 */

import { getWbApiKey, wbGetJson } from './wbClient.js';

// Types
export interface WbFeedback {
  id: string;
  imtId: number;
  nmId: number;
  subjectId: number;
  userName: string;
  matchingSize: string;
  text: string;
  productValuation: number;
  createdDate: string;
  state: string;
  answer: { text: string; state: string } | null;
  photoLinks: string[];
  video: { link: string } | null;
  wasViewed: boolean;
  isAbleSupplierFeedbackValuation: boolean;
  supplierFeedbackValuation: number;
  isAbleSupplierProductValuation: boolean;
  supplierProductValuation: number;
  isAbleReturnProductOrders: boolean;
  returnProductOrdersDate: string | null;
  bables: string[];
  pros: string;
  cons: string;
}

export interface WbQuestion {
  id: string;
  text: string;
  createdDate: string;
  state: string;
  answer: { text: string; state: string; editable: boolean } | null;
  productDetails: {
    nmId: number;
    imtId: number;
    productName: string;
    supplierArticle: string;
    supplierName: string;
    brandName: string;
  };
  wasViewed: boolean;
}

interface FetchParams {
  isAnswered?: boolean;
  take?: number;
  skip?: number;
  nmId?: number;
  dateFrom?: number;
  dateTo?: number;
  order?: 'dateAsc' | 'dateDesc';
}

const BASE_URL = 'https://feedbacks-api.wildberries.ru';

/**
 * Fetch feedbacks (reviews) from WB
 */
export async function fetchWbFeedbacks(workspaceId: number, params: FetchParams = {}, shopId?: number): Promise<{
  data: { feedbacks: WbFeedback[]; };
  error: boolean;
  errorText: string;
  additionalErrors: string | null;
}> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const query = new URLSearchParams();
  if (params.isAnswered !== undefined) query.set('isAnswered', String(params.isAnswered));
  if (params.take !== undefined) query.set('take', String(params.take));
  if (params.skip !== undefined) query.set('skip', String(params.skip));
  if (params.nmId) query.set('nmId', String(params.nmId));
  if (params.dateFrom) query.set('dateFrom', String(params.dateFrom));
  if (params.dateTo) query.set('dateTo', String(params.dateTo));
  if (params.order) query.set('order', params.order);

  const res = await fetch(`${BASE_URL}/api/v1/feedbacks?${query}`, {
    headers: {
      Authorization: apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`WB Feedbacks API error: ${res.status}`);
  }

  return res.json() as Promise<{
    data: { feedbacks: WbFeedback[]; };
    error: boolean;
    errorText: string;
    additionalErrors: string | null;
  }>;
}

/**
 * Fetch questions from WB
 */
export async function fetchWbQuestions(workspaceId: number, params: FetchParams = {}, shopId?: number): Promise<{
  data: { questions: WbQuestion[]; };
  error: boolean;
  errorText: string;
  additionalErrors: string | null;
}> {
  // Prefer shop-scoped API key so multi-shop workspaces get questions for the
  // requested shop, not just the first one registered.
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const query = new URLSearchParams();
  if (params.isAnswered !== undefined) query.set('isAnswered', String(params.isAnswered));
  if (params.take !== undefined) query.set('take', String(params.take));
  if (params.skip !== undefined) query.set('skip', String(params.skip));
  if (params.nmId) query.set('nmId', String(params.nmId));
  if (params.dateFrom) query.set('dateFrom', String(params.dateFrom));
  if (params.dateTo) query.set('dateTo', String(params.dateTo));
  if (params.order) query.set('order', params.order);

  const res = await fetch(`${BASE_URL}/api/v1/questions?${query}`, {
    headers: {
      Authorization: apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`WB Questions API error: ${res.status}`);
  }

  return res.json() as Promise<{
    data: { questions: WbQuestion[]; };
    error: boolean;
    errorText: string;
    additionalErrors: string | null;
  }>;
}

/**
 * Send answer to a feedback (review)
 */
export async function sendWbFeedbackAnswer(workspaceId: number, shopId: number | null, feedbackId: string, text: string): Promise<void> {
  // Защита: без явного shopId ключ возьмётся от ПЕРВОГО активного магазина
  // workspace — в мульти-магазинном workspace это может привести к отправке
  // ответа ключом не того магазина (WB вернёт 403, но семантически это
  // утечка). Требуем явный shopId для всех write-операций.
  if (shopId == null) {
    throw new Error(`sendWbFeedbackAnswer: shopId is required (workspaceId=${workspaceId}, feedbackId=${feedbackId})`);
  }
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const res = await fetch(`${BASE_URL}/api/v1/feedbacks/answer`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: feedbackId,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Feedback answer error: ${res.status} ${body}`);
  }
}

/**
 * Edit a previously sent feedback answer.
 *
 * PATCH /api/v1/feedbacks/answer — WB позволяет 1 правку в течение 60 дней
 * после отправки ответа. Если попытаться позже — вернёт ошибку.
 */
export async function editWbFeedbackAnswer(workspaceId: number, shopId: number | null, feedbackId: string, text: string): Promise<void> {
  if (shopId == null) {
    throw new Error(`editWbFeedbackAnswer: shopId is required (workspaceId=${workspaceId}, feedbackId=${feedbackId})`);
  }
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const res = await fetch(`${BASE_URL}/api/v1/feedbacks/answer`, {
    method: 'PATCH',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: feedbackId,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Feedback edit-answer error: ${res.status} ${body}`);
  }
}

/**
 * Reject a question (it goes through but is not published on WB site).
 *
 * PATCH /api/v1/questions с state: 'none' — покупатель получит ответ,
 * но вопрос+ответ не отобразятся публично. Используется для не-вопросов
 * вроде «спасибо за товар» / спама.
 */
export async function rejectWbQuestion(workspaceId: number, shopId: number | null, questionId: string, text: string): Promise<void> {
  if (shopId == null) {
    throw new Error(`rejectWbQuestion: shopId is required (workspaceId=${workspaceId}, questionId=${questionId})`);
  }
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const res = await fetch(`${BASE_URL}/api/v1/questions`, {
    method: 'PATCH',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: questionId, text, state: 'none' }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Question reject error: ${res.status} ${body}`);
  }
}

/**
 * Mark a question as viewed without answering. Used by UI "просмотрено" badge.
 *
 * PATCH /api/v1/questions с wasViewed: true.
 */
export async function markWbQuestionAsViewed(workspaceId: number, shopId: number | null, questionId: string): Promise<void> {
  if (shopId == null) {
    throw new Error(`markWbQuestionAsViewed: shopId is required (workspaceId=${workspaceId}, questionId=${questionId})`);
  }
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const res = await fetch(`${BASE_URL}/api/v1/questions`, {
    method: 'PATCH',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: questionId, wasViewed: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Question mark-viewed error: ${res.status} ${body}`);
  }
}

/**
 * Send answer to a question
 */
export async function sendWbQuestionAnswer(workspaceId: number, shopId: number | null, questionId: string, text: string): Promise<void> {
  if (shopId == null) {
    throw new Error(`sendWbQuestionAnswer: shopId is required (workspaceId=${workspaceId}, questionId=${questionId})`);
  }
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured for workspace ' + workspaceId);

  const res = await fetch(`${BASE_URL}/api/v1/questions`, {
    method: 'PATCH',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: questionId,
      text,
      state: 'wbRu', // publish answer
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Question answer error: ${res.status} ${body}`);
  }
}

// ============================================================================
// Pinned Feedbacks (Закрепление отзывов)
// ============================================================================

export interface PinnedFeedback {
  pinId: number;
  feedbackId: string;
  imtId: number;
  nmId: number;
  state: 'pinned' | 'unpinned';
  pinMethod: string;
  pinOn: 'nm' | 'imt';
  changeStateAt: string;
  unpinnedCause?: string;
}

/**
 * Get pinned feedbacks
 * GET /api/feedbacks/v1/pins
 * Rate limit: 3 req/sec
 */
export async function getPinnedFeedbacks(
  workspaceId: number,
  params?: {
    state?: 'pinned' | 'unpinned';
    pinOn?: 'nm' | 'imt';
    imtId?: number;
    nmId?: number;
    limit?: number;
  },
  shopId?: number,
): Promise<{ data: PinnedFeedback[]; next: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const qs = new URLSearchParams();
  if (params?.state) qs.set('state', params.state);
  if (params?.pinOn) qs.set('pinOn', params.pinOn);
  if (params?.imtId) qs.set('imtId', String(params.imtId));
  if (params?.nmId) qs.set('nmId', String(params.nmId));
  if (params?.limit) qs.set('limit', String(params.limit));

  return wbGetJson<{ data: PinnedFeedback[]; next: number }>(
    `${BASE_URL}/api/feedbacks/v1/pins?${qs}`,
    apiKey
  );
}

/**
 * Pin feedback to product card
 * POST /api/feedbacks/v1/pins
 *
 * ВАЖНО: Требует подписку "Джем" или опцию "Закрепление отзыва"
 * Rate limit: 3 req/sec
 */
export async function pinFeedback(
  workspaceId: number,
  feedbackId: string,
  imtId: number,
  pinOn: 'imt' | 'nm' = 'imt',
  shopId?: number,
): Promise<void> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const res = await fetch(`${BASE_URL}/api/feedbacks/v1/pins`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{
      pinMethod: 'subscription',
      pinOn,
      imtId,
      feedbackId,
    }]),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Pin feedback error: ${res.status} ${body}`);
  }
}

/**
 * Unpin feedback
 * DELETE /api/feedbacks/v1/pins
 */
export async function unpinFeedback(
  workspaceId: number,
  pinId: number,
  shopId?: number,
): Promise<void> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const res = await fetch(`${BASE_URL}/api/feedbacks/v1/pins?pinId=${pinId}`, {
    method: 'DELETE',
    headers: {
      Authorization: apiKey,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Unpin feedback error: ${res.status} ${body}`);
  }
}

// ============================================================================
// New Feedbacks/Questions Counter
// ============================================================================

export interface NewFeedbacksCount {
  hasNewQuestions: boolean;
  hasNewFeedbacks: boolean;
}

/**
 * Get count of new (unviewed) feedbacks and questions
 * GET /api/v1/new-feedbacks-questions
 * Rate limit: 3 req/sec
 */
export async function getNewFeedbacksCount(workspaceId: number, shopId?: number): Promise<{ data: NewFeedbacksCount }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  return wbGetJson<{ data: NewFeedbacksCount }>(
    `${BASE_URL}/api/v1/new-feedbacks-questions`,
    apiKey
  );
}

/**
 * Mark feedbacks as viewed
 * POST /api/v1/feedbacks/read
 */
export async function markFeedbacksRead(workspaceId: number, feedbackIds: string[], shopId?: number): Promise<void> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const res = await fetch(`${BASE_URL}/api/v1/feedbacks/read`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: feedbackIds }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WB Mark feedbacks read error: ${res.status} ${body}`);
  }
}

/**
 * Get count of unanswered feedbacks
 * GET /api/v1/feedbacks/count-unanswered
 * Rate limit: 10 req/sec
 */
export async function getUnansweredFeedbacksCount(workspaceId: number, shopId?: number): Promise<{ count: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const res = await wbGetJson<{ data: { countUnanswered: number } }>(
    `${BASE_URL}/api/v1/feedbacks/count-unanswered`,
    apiKey
  );

  return { count: res.data?.countUnanswered ?? 0 };
}

/**
 * Get count of unanswered questions
 * GET /api/v1/questions/count-unanswered
 * Rate limit: 10 req/sec
 */
export async function getUnansweredQuestionsCount(workspaceId: number, shopId?: number): Promise<{ count: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error('WB API key not configured');

  const res = await wbGetJson<{ data: { countUnanswered: number } }>(
    `${BASE_URL}/api/v1/questions/count-unanswered`,
    apiKey
  );

  return { count: res.data?.countUnanswered ?? 0 };
}
