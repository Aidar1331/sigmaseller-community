import { db } from '../../db/client.js';
import { pricingStrategies, pricingDecisions } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { evaluateStrategy, type StrategyType } from './strategies.js';
import { loadConstraints, applyConstraints } from './constraints.js';

export interface PricingEvaluation {
  nmId: number;
  strategyType: StrategyType;
  currentPriceKop: number;
  proposedPriceKop: number;
  constrainedPriceKop: number;
  reason: string;
  confidence: number;
  violations: string[];
  decisionId: number;
}

export async function evaluateProductPricing(
  wsId: number,
  nmId: number,
  currentPriceKop: number
): Promise<PricingEvaluation[]> {
  // Load active strategies for this product
  const activeStrategies = await db.select()
    .from(pricingStrategies)
    .where(and(
      eq(pricingStrategies.workspaceId, wsId),
      eq(pricingStrategies.nmId, nmId),
      eq(pricingStrategies.isActive, true),
    ));

  if (activeStrategies.length === 0) return [];

  const constraints = await loadConstraints(wsId, nmId);

  // Wrap all strategy evaluations + decision inserts in a transaction
  const results = await db.transaction(async (tx) => {
    const txResults: PricingEvaluation[] = [];

    for (const strat of activeStrategies) {
      const stratResult = await evaluateStrategy(strat.strategyType as StrategyType, {
        wsId,
        nmId,
        currentPriceKop,
        config: (strat.config as Record<string, unknown>) ?? {},
      });

      const constrained = applyConstraints(currentPriceKop, stratResult.proposedPriceKop, constraints);

      // Save decision inside transaction
      const [decision] = await tx.insert(pricingDecisions).values({
        workspaceId: wsId,
        nmId,
        strategyType: strat.strategyType,
        oldPriceKop: currentPriceKop,
        newPriceKop: constrained.constrainedPriceKop,
        reason: stratResult.reason,
        constraintsApplied: { violations: constrained.violations },
        status: 'proposed',
      }).returning();

      txResults.push({
        nmId,
        strategyType: strat.strategyType as StrategyType,
        currentPriceKop,
        proposedPriceKop: stratResult.proposedPriceKop,
        constrainedPriceKop: constrained.constrainedPriceKop,
        reason: stratResult.reason,
        confidence: stratResult.confidence,
        violations: constrained.violations,
        decisionId: decision.decisionId,
      });
    }

    return txResults;
  });

  return results;
}
