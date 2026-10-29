/**
 * Action Queue executors.
 *
 * Each entry maps `action_type` → `ActionExecutor`. The pulse-workers process
 * calls `registerAllActionExecutors()` once at startup. The legacy inline
 * actionXxx.ts files stay alongside — when ENABLE_ACTION_QUEUE=0 the LLM still
 * hits those, and the executors here are dormant.
 *
 * As we migrate more tools (Phase 4B+), each gets a file here. Pilot: set_price.
 */

import { registerActionExecutor } from '../actionQueue.js';
import { setPriceExecutor } from './setPriceExecutor.js';
import { replyFeedbackExecutor } from './replyFeedbackExecutor.js';
import { updateBidExecutor } from './updateBidExecutor.js';
import { startCampaignExecutor } from './startCampaignExecutor.js';
import { pauseCampaignExecutor } from './pauseCampaignExecutor.js';
import { replyQuestionExecutor } from './replyQuestionExecutor.js';
import { sendChatMessageExecutor } from './sendChatMessageExecutor.js';
import { manageDiscountExecutor } from './manageDiscountExecutor.js';
import { managePromotionExecutor } from './managePromotionExecutor.js';
import { updateCardExecutor } from './updateCardExecutor.js';
import { createCardExecutor } from './createCardExecutor.js';
import { updateCharacteristicsExecutor } from './updateCharacteristicsExecutor.js';
import { manageClustersExecutor } from './manageClustersExecutor.js';
import { createSupplyExecutor } from './createSupplyExecutor.js';
import { confirmFbsOrderExecutor } from './confirmFbsOrderExecutor.js';
import { createPassExecutor } from './createPassExecutor.js';
import { approveReturnExecutor } from './approveReturnExecutor.js';
import { rejectReturnExecutor } from './rejectReturnExecutor.js';
import { createFbsSupplyExecutor } from './createFbsSupplyExecutor.js';
import { deliverFbsSupplyExecutor } from './deliverFbsSupplyExecutor.js';

let registered = false;

export function registerAllActionExecutors(): void {
  if (registered) return; // idempotent — survives multiple worker re-imports
  // All 16 dangerous tools now have queue executors. Legacy inline paths
  // remain in place behind ENABLE_ACTION_QUEUE=0.
  registerActionExecutor('set_price', setPriceExecutor);
  registerActionExecutor('reply_feedback', replyFeedbackExecutor);
  registerActionExecutor('update_bid', updateBidExecutor);
  registerActionExecutor('start_campaign', startCampaignExecutor);
  registerActionExecutor('pause_campaign', pauseCampaignExecutor);
  registerActionExecutor('reply_question', replyQuestionExecutor);
  registerActionExecutor('send_chat_message', sendChatMessageExecutor);
  registerActionExecutor('manage_discount', manageDiscountExecutor);
  registerActionExecutor('manage_promotion', managePromotionExecutor);
  registerActionExecutor('update_card', updateCardExecutor);
  registerActionExecutor('create_card', createCardExecutor);
  registerActionExecutor('update_characteristics', updateCharacteristicsExecutor);
  registerActionExecutor('manage_clusters', manageClustersExecutor);
  registerActionExecutor('create_supply', createSupplyExecutor);
  registerActionExecutor('confirm_fbs_order', confirmFbsOrderExecutor);
  registerActionExecutor('create_pass', createPassExecutor);
  registerActionExecutor('approve_return', approveReturnExecutor);
  registerActionExecutor('reject_return', rejectReturnExecutor);
  // FBS E2E (0131)
  registerActionExecutor('create_fbs_supply', createFbsSupplyExecutor);
  registerActionExecutor('deliver_fbs_supply', deliverFbsSupplyExecutor);
  registered = true;
}
