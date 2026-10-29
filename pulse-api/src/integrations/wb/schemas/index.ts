/**
 * WB API Response Schemas — central export.
 *
 * Usage in toDb files:
 *   import { reportDetailResponseSchema, CRITICAL_FINANCE_FIELDS } from './schemas/index.js';
 *   import { validateWbResponse, detectFieldAbsence } from './schemas/validate.js';
 */

export { reportDetailRowSchema, reportDetailResponseSchema, CRITICAL_FINANCE_FIELDS } from './reportDetail.schema.js';
export { funnelProductSchema, funnelProductsResponseSchema, funnelHistoryResponseSchema, CRITICAL_FUNNEL_FIELDS } from './salesFunnel.schema.js';
export { advFullstatsResponseSchema, advCampaignFullstatsSchema, CRITICAL_ADV_FIELDS } from './advFullstats.schema.js';
export { stockItemSchema, stocksResponseSchema, CRITICAL_STOCK_FIELDS } from './stocks.schema.js';
export { cardSchema, cardsListResponseSchema, CRITICAL_CARD_FIELDS } from './cards.schema.js';
export { validateWbResponse, detectFieldAbsence } from './validate.js';
