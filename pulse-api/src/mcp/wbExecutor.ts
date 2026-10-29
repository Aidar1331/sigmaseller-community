import { sellerWbKey } from '../services/sellerWbCredentials.js';
import { isWbBillingAuthorized } from '../services/wbBillingPolicy.js';
import type { ActionExecutor, ExecutionResult } from './tools.js';

export function wbWritesEnabled() { return process.env.MCP_WB_WRITES_ENABLED === '1' && isWbBillingAuthorized(); }

/** Closed endpoint set, exact shop credentials, one write attempt, no retries or owner fallback. */
export const executeWbAction: ActionExecutor = async (who, action) => {
  if (!wbWritesEnabled()) return { status: 'rejected', message: 'Отправка в WB выключена' };
  const key = await sellerWbKey(who.workspaceId,who.shopId);
  const headers = { Authorization: key, 'Content-Type': 'application/json' };
  const request = (url: string, method: string, body?: unknown) => fetch(url, { method, headers, redirect: 'error',
    signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let response: Response;
  if (action.kind === 'feedback_reply') {
    response = await request('https://feedbacks-api.wildberries.ru/api/v1/feedbacks/answer','POST',{ id: action.itemId,text: action.text });
  } else if (action.kind === 'question_reply') {
    response = await request('https://feedbacks-api.wildberries.ru/api/v1/questions','PATCH',{ id: action.itemId,answer: { text: action.text },state: 'wbRu' });
  } else if (action.kind === 'price_change') {
    response = await request('https://discounts-prices-api.wildberries.ru/api/v2/upload/task','POST',{ data: [{ nmID: action.nmId,price: action.priceRub,discount: action.discountPercent }] });
  } else if (action.kind === 'campaign_pause') {
    response = await request(`https://advert-api.wildberries.ru/adv/v0/pause?id=${action.campaignId}`,'GET');
  } else {
    // WB updates replace fields. Read the current card, check the exact object and expected description,
    // then preserve the remaining editable fields. Never use another returned card as a fallback.
    const read = await request('https://content-api.wildberries.ru/content/v2/get/cards/list','POST',{
      settings: { cursor: { limit: 100 },filter: { textSearch: String(action.nmId),withPhoto:0 } },
    });
    if (!read.ok) return { status: 'rejected', message: 'Не удалось проверить карточку перед изменением; отправка отменена' };
    const data = await read.json() as any;
    const card = data.cards?.find((c: any) => c.nmID === action.nmId);
    if (!card || (card.description ?? '') !== action.expectedDescription) return { status: 'rejected', message: 'Описание изменилось или карточка не найдена. Подготовьте новое предложение.' };
    if (!Array.isArray(card.sizes) || !card.sizes.length || card.sizes.some((s:any)=>!s.chrtID) || (card.needKiz && card.kizMarked !== true)) {
      return { status:'rejected',message:'Карточка требует проверки размеров или маркировки в кабинете WB. Изменение не отправлено.' };
    }
    const pick=(value:any,names:string[])=>Object.fromEntries(names.filter(n=>value?.[n]!==undefined).map(n=>[n,value[n]]));
    response = await request('https://content-api.wildberries.ru/content/v2/cards/update','POST',[{
      nmID: card.nmID,vendorCode: card.vendorCode,title: card.title,brand: card.brand,description: action.description,
      gtin:card.gtin,kizMarked:card.kizMarked,
      documents:card.documents ? { items:card.documents.items?.map((d:any)=>pick(d,['id','type','number','productNumber','tradeName','applicant','startDate','endDate','isEndless'])),excludeDocuments:card.documents.excludeDocuments } : undefined,
      characteristics: card.characteristics?.map((c: any) => ({ id:c.id,value:c.value })),
      dimensions:pick(card.dimensions,['length','width','height','weightBrutto']),
      sizes:card.sizes.map((s:any)=>pick(s,['chrtID','techSize','wbSize','skus'])),
    }]);
  }
  // Do not expose WB error bodies (which may include tokens or personal data).
  if (!response.ok) return { status: response.status >= 500 ? 'unknown' : 'rejected', message: `WB вернул HTTP ${response.status}. Повтор автоматически не выполняется.` };
  const text = await response.text();
  let data: any = {};
  if (text) { try { data = JSON.parse(text); } catch { return { status:'unknown',message:'WB вернул непонятный ответ. Проверьте результат в кабинете.' }; } }
  if (data.error || data.errorText || data.additionalErrors?.length) return { status: 'rejected', message: 'WB не принял изменение. Проверьте параметры в кабинете.' };
  const result: ExecutionResult = { status:'accepted',message:'WB принял запрос. Окончательный результат проверьте в кабинете после обработки.' };
  const externalId = data.data?.id ?? data.data?.uploadID;
  if (typeof externalId === 'number' || typeof externalId === 'string') result.externalId = String(externalId).slice(0,100);
  return result;
};
