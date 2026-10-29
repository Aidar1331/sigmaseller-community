// Registry mapping DANGEROUS_TOOLS.actionType → check function.
// Phase 0: all entries are stubs that throw 'not implemented'. Phase 1+
// replaces them one domain at a time (pricing first).

import type { CheckFn } from '../types.js';
import { verifyPriceChange } from './verifyPriceChange.js';
import { verifyFeedbackReply } from './verifyFeedbackReply.js';
import { verifyCampaignStart } from './verifyCampaignStart.js';
import { verifyCampaignPause } from './verifyCampaignPause.js';
import { verifyBidChange } from './verifyBidChange.js';
import { verifyDiscountChange } from './verifyDiscountChange.js';
import { verifyCardUpdate } from './verifyCardUpdate.js';
import { verifyClusterChange } from './verifyClusterChange.js';
import { verifyQuestionReply } from './verifyQuestionReply.js';
import { verifyChatMessage } from './verifyChatMessage.js';
import { verifyCardCreate } from './verifyCardCreate.js';
import { verifyCharacteristicsUpdate } from './verifyCharacteristicsUpdate.js';
import { verifySupplyCreate } from './verifySupplyCreate.js';
import { verifyFbsConfirm } from './verifyFbsConfirm.js';
import { verifyPromotionManage } from './verifyPromotionManage.js';

// Keys match the short `agent_actions.action_type` stored by each tool (no
// `action_` prefix). This matches the convention in actionSetPrice.ts:80 etc.
export const checkRegistry: Record<string, CheckFn> = {
  set_price: verifyPriceChange,
  reply_feedback: verifyFeedbackReply,
  start_campaign: verifyCampaignStart,
  pause_campaign: verifyCampaignPause,
  update_bid: verifyBidChange,
  manage_discount: verifyDiscountChange,
  update_card: verifyCardUpdate,
  manage_clusters: verifyClusterChange,
  reply_question: verifyQuestionReply,
  send_chat_message: verifyChatMessage,
  create_card: verifyCardCreate,
  update_characteristics: verifyCharacteristicsUpdate,
  create_supply: verifySupplyCreate,
  confirm_fbs_order: verifyFbsConfirm,
  manage_promotion: verifyPromotionManage,
};

export function getChecker(actionType: string): CheckFn | null {
  return checkRegistry[actionType] ?? null;
}
