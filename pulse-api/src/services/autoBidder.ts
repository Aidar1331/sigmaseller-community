/**
 * Auto Bidder Service
 * Calculates optimal bids based on competitor analysis
 * Based on wb-advert-auto-bid patterns
 */

import { withRetry } from '../lib/rateLimiter.js';
import { logJobs as logger } from '../lib/logger.js';

interface AdvertPlace {
  position: number;
  cpm: number;
  nmId?: number;
  advertId?: number;
}

interface BidCalculationInput {
  currentPosition: number;
  currentBid: number;
  targetPosition: number;
  minBid?: number;
  maxBid?: number;
  competitors: AdvertPlace[];
}

interface BidDecision {
  shouldChange: boolean;
  newBid: number;
  reason: string;
  estimatedPosition: number;
  competitorAtTarget?: AdvertPlace;
}

interface SearchAdsResponse {
  adverts: Array<{
    id: number;
    nmId: number;
    position: number;
    cpm: number;
    subjectId: number;
  }>;
  pages: Record<number, number[]>;
  prioritySubjects: number[];
}

/**
 * Get competitor bids for a keyword
 */
export async function getCompetitorBids(keyword: string): Promise<AdvertPlace[] | null> {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://catalog-ads.wildberries.ru/api/v5/search?keyword=${encodedKeyword}`;

  try {
    const response = await withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          'Accept': '*/*',
          'Origin': 'https://www.wildberries.ru',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          'Referer': `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodedKeyword}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to get ads: ${res.status}`);
      }

      return res.json() as Promise<SearchAdsResponse>;
    });

    const places: AdvertPlace[] = [];
    
    if (response.adverts) {
      response.adverts.forEach((ad, index) => {
        places.push({
          position: ad.position || index + 1,
          cpm: ad.cpm,
          nmId: ad.nmId,
          advertId: ad.id,
        });
      });
    }

    // Sort by position
    places.sort((a, b) => a.position - b.position);

    return places;
  } catch (error) {
    logger.error({ err: error }, 'Error getting competitor bids');
    // IMPORTANT: Return null on error, not empty array
    // Empty array = "no competitors" = drop to minimum bid
    // null = "API error" = don't change bid
    return null;
  }
}

/**
 * Calculate optimal bid for target position
 */
export function calculateOptimalBid(input: BidCalculationInput): BidDecision {
  const {
    currentPosition,
    currentBid,
    targetPosition,
    competitors,
  } = input;
  
  // Validate and sanitize bid limits
  const minBid = Math.max(1, input.minBid ?? 50);
  const maxBid = Math.max(minBid, input.maxBid ?? 10000);

  // If already at target position or better, no change needed
  if (currentPosition > 0 && currentPosition <= targetPosition) {
    return {
      shouldChange: false,
      newBid: currentBid,
      reason: `Already at position ${currentPosition}, target is ${targetPosition}`,
      estimatedPosition: currentPosition,
    };
  }

  // Find competitor at target position
  const targetCompetitor = competitors.find(c => c.position === targetPosition);
  
  if (!targetCompetitor) {
    // No competitor at target, use minimal bid above target-1
    const prevCompetitor = competitors.find(c => c.position === targetPosition - 1);
    if (prevCompetitor) {
      const newBid = Math.min(Math.max(prevCompetitor.cpm + 1, minBid), maxBid);
      return {
        shouldChange: newBid !== currentBid,
        newBid,
        reason: `Set bid above position ${targetPosition - 1} competitor (${prevCompetitor.cpm})`,
        estimatedPosition: targetPosition,
      };
    }

    // No reference point, use minimum bid
    return {
      shouldChange: currentBid !== minBid,
      newBid: minBid,
      reason: 'No competitors found, using minimum bid',
      estimatedPosition: competitors.length + 1,
    };
  }

  // Calculate bid to beat target position competitor
  const bidToWin = targetCompetitor.cpm + 1;
  
  if (bidToWin > maxBid) {
    // Too expensive, try to get closest possible position
    const affordableCompetitor = [...competitors]
      .sort((a, b) => b.cpm - a.cpm)
      .find(c => c.cpm < maxBid);

    if (affordableCompetitor) {
      const newBid = Math.min(affordableCompetitor.cpm + 1, maxBid);
      return {
        shouldChange: newBid !== currentBid,
        newBid,
        reason: `Target position too expensive (${bidToWin}), settling for position ${affordableCompetitor.position + 1}`,
        estimatedPosition: affordableCompetitor.position + 1,
        competitorAtTarget: targetCompetitor,
      };
    }

    return {
      shouldChange: currentBid !== maxBid,
      newBid: maxBid,
      reason: 'All positions above budget, using max bid',
      estimatedPosition: competitors.length + 1,
      competitorAtTarget: targetCompetitor,
    };
  }

  // We can afford the target position
  const newBid = Math.min(Math.max(bidToWin, minBid), maxBid);

  return {
    shouldChange: newBid !== currentBid,
    newBid,
    reason: `Bid ${newBid} to beat competitor at position ${targetPosition} (CPM: ${targetCompetitor.cpm})`,
    estimatedPosition: targetPosition,
    competitorAtTarget: targetCompetitor,
  };
}

/**
 * Calculate bid adjustments for DRR target
 */
export function calculateDrrBasedBid(params: {
  currentBid: number;
  currentDrr: number;
  targetDrr: number;
  minBid?: number;
  maxBid?: number;
  maxChangePercent?: number;
}): BidDecision {
  const { currentBid, currentDrr, targetDrr } = params;
  
  // Validate numeric inputs
  if (!Number.isFinite(currentBid) || !Number.isFinite(currentDrr) || !Number.isFinite(targetDrr)) {
    return {
      shouldChange: false,
      newBid: currentBid || 50,
      reason: 'Invalid numeric values (NaN or Infinity)',
      estimatedPosition: 0,
    };
  }
  
  // Validate and sanitize bid limits
  const minBid = Math.max(1, params.minBid ?? 50);
  const maxBid = Math.max(minBid, params.maxBid ?? 10000);
  const maxChangePercent = Math.max(1, Math.min(100, params.maxChangePercent ?? 20));

  // DRR = Ad Spend / Revenue * 100
  // If DRR is too high, we're spending too much - decrease bid
  // If DRR is too low, we can afford to spend more - increase bid

  const drrDiff = currentDrr - targetDrr;
  const tolerance = 2; // Allow 2% tolerance

  if (Math.abs(drrDiff) <= tolerance) {
    return {
      shouldChange: false,
      newBid: currentBid,
      reason: `DRR ${currentDrr.toFixed(1)}% is within target range (${targetDrr}% ± ${tolerance}%)`,
      estimatedPosition: 0,
    };
  }

  // Calculate adjustment percentage based on how far off we are
  const adjustmentPercent = Math.min(Math.abs(drrDiff) / 2, maxChangePercent);
  
  let newBid: number;
  let reason: string;

  if (drrDiff > 0) {
    // DRR too high - decrease bid
    newBid = Math.round(currentBid * (1 - adjustmentPercent / 100));
    reason = `DRR ${currentDrr.toFixed(1)}% is above target ${targetDrr}%, decreasing bid by ${adjustmentPercent.toFixed(1)}%`;
  } else {
    // DRR too low - increase bid
    newBid = Math.round(currentBid * (1 + adjustmentPercent / 100));
    reason = `DRR ${currentDrr.toFixed(1)}% is below target ${targetDrr}%, increasing bid by ${adjustmentPercent.toFixed(1)}%`;
  }

  // Clamp to min/max
  newBid = Math.min(Math.max(newBid, minBid), maxBid);

  return {
    shouldChange: newBid !== currentBid,
    newBid,
    reason,
    estimatedPosition: 0,
  };
}

/**
 * Get recommended bids for multiple campaigns
 */
export async function getRecommendedBids(params: {
  campaigns: Array<{
    campaignId: number;
    keyword: string;
    currentBid: number;
    currentPosition?: number;
    targetPosition?: number;
    currentDrr?: number;
    targetDrr?: number;
  }>;
  minBid?: number;
  maxBid?: number;
}): Promise<Array<{
  campaignId: number;
  keyword: string;
  decision: BidDecision;
  competitors: AdvertPlace[];
}>> {
  const results: Array<{
    campaignId: number;
    keyword: string;
    decision: BidDecision;
    competitors: AdvertPlace[];
  }> = [];

  for (const campaign of params.campaigns) {
    // Get competitor bids for the keyword
    const competitors = await getCompetitorBids(campaign.keyword);

    // Skip if API error (don't change bid when we can't get competitor data)
    if (competitors === null) {
      logger.warn({ campaignId: campaign.campaignId }, 'Skipping campaign: failed to fetch competitor data');
      continue;
    }

    let decision: BidDecision;

    if (campaign.targetPosition && campaign.targetPosition > 0) {
      // Position-based bidding
      decision = calculateOptimalBid({
        currentPosition: campaign.currentPosition || 0,
        currentBid: campaign.currentBid,
        targetPosition: campaign.targetPosition,
        minBid: params.minBid,
        maxBid: params.maxBid,
        competitors,
      });
    } else if (campaign.targetDrr && campaign.currentDrr !== undefined) {
      // DRR-based bidding
      decision = calculateDrrBasedBid({
        currentBid: campaign.currentBid,
        currentDrr: campaign.currentDrr,
        targetDrr: campaign.targetDrr,
        minBid: params.minBid,
        maxBid: params.maxBid,
      });
    } else {
      // No target specified
      decision = {
        shouldChange: false,
        newBid: campaign.currentBid,
        reason: 'No target position or DRR specified',
        estimatedPosition: campaign.currentPosition || 0,
      };
    }

    results.push({
      campaignId: campaign.campaignId,
      keyword: campaign.keyword,
      decision,
      competitors,
    });

    // Small delay between keyword lookups
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

// Export types
export type { AdvertPlace, BidDecision, BidCalculationInput };
