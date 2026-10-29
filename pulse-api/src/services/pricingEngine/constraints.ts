import { db } from '../../db/client.js';
import { agentSettings, wbCogs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface PriceConstraints {
  maxChangePct: number;
  minMarginPct: number | null;
  minPriceKop: number;
  maxPriceKop: number;
  cogsKop: number | null;
}

export interface ConstraintResult {
  allowed: boolean;
  constrainedPriceKop: number;
  violations: string[];
}

export async function loadConstraints(wsId: number, nmId: number): Promise<PriceConstraints> {
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);

  // Load COGS for this specific product
  const [cogs] = await db.select({ cogsKopecks: wbCogs.cogsKopecks })
    .from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, wsId), eq(wbCogs.nmId, nmId)))
    .limit(1);

  return {
    maxChangePct: Math.max(0, Math.min(100, Number(settings?.maxPriceChangePct) || 10)),
    minMarginPct: settings?.minMarginPct ?? null,
    minPriceKop: Math.max(1, Number((settings as any)?.minPriceKop) || 100_00),
    maxPriceKop: Math.max(1, Number((settings as any)?.maxPriceKop) || 999_999_00),
    cogsKop: cogs?.cogsKopecks ?? null,
  };
}

export function applyConstraints(
  currentPriceKop: number,
  proposedPriceKop: number,
  constraints: PriceConstraints,
): ConstraintResult {
  const violations: string[] = [];
  let price = proposedPriceKop;

  // Max change % constraint
  const changePct = Math.abs((price - currentPriceKop) / currentPriceKop) * 100;
  if (changePct > constraints.maxChangePct) {
    violations.push(`Change ${changePct.toFixed(1)}% exceeds max ${constraints.maxChangePct}%`);
    const direction = price > currentPriceKop ? 1 : -1;
    price = Math.round(currentPriceKop * (1 + direction * constraints.maxChangePct / 100));
  }

  // Min price
  if (price < constraints.minPriceKop) {
    violations.push(`Price below minimum ${constraints.minPriceKop / 100} RUB`);
    price = constraints.minPriceKop;
  }

  // Max price
  if (price > constraints.maxPriceKop) {
    violations.push(`Price above maximum ${constraints.maxPriceKop / 100} RUB`);
    price = constraints.maxPriceKop;
  }

  // Margin check
  if (constraints.minMarginPct !== null && constraints.cogsKop !== null && constraints.cogsKop > 0) {
    const margin = ((price - constraints.cogsKop) / price) * 100;
    if (margin < constraints.minMarginPct) {
      violations.push(`Margin ${margin.toFixed(1)}% below min ${constraints.minMarginPct}%`);
      price = Math.round(constraints.cogsKop / (1 - constraints.minMarginPct / 100));
    }
  }

  return {
    allowed: violations.length === 0,
    constrainedPriceKop: price,
    violations,
  };
}
