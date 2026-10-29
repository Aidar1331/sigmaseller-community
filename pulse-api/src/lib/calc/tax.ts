/**
 * Tax calculation utilities.
 * 
 * For simplified taxation system (УСН) common among WB sellers:
 * - УСН "Доходы": 6% of revenue
 * - УСН "Доходы минус расходы": 15% of profit
 * 
 * Default rate is 15% (income minus expenses).
 */

/**
 * Calculate tax amount.
 * Formula: taxableBase × taxRate
 * 
 * @param taxableBaseKopecks - Taxable amount in kopecks
 * @param taxRate - Tax rate as decimal (e.g., 0.15 for 15%)
 * @returns Tax amount in kopecks
 * 
 * @example
 * calcTax(1000000, 0.15) // 150000 (15% of 10000₽)
 * calcTax(1000000, 0.06) // 60000 (6% for УСН Доходы)
 */
export function calcTax(taxableBaseKopecks: number, taxRate: number): number {
  if (!taxableBaseKopecks || taxableBaseKopecks <= 0) return 0;
  if (!taxRate || taxRate <= 0) return 0;
  return Math.round((taxableBaseKopecks * taxRate));
}

/**
 * Calculate tax for УСН "Доходы минус расходы" (15%).
 * Taxable base = payout - marketplace costs - COGS
 * 
 * @param payoutKopecks - Income from WB
 * @param marketplaceCostsKopecks - WB deductions
 * @param cogsKopecks - Cost of goods sold
 * @param taxRate - Tax rate (default 0.15)
 * @returns Tax amount in kopecks
 * 
 * @example
 * calcTaxUSN({
 *   payoutKopecks: 1000000,
 *   marketplaceCostsKopecks: 300000,
 *   cogsKopecks: 400000,
 *   taxRate: 0.15
 * }) // 45000 (15% of 300000 profit)
 */
export function calcTaxUSN(input: {
  payoutKopecks: number;
  marketplaceCostsKopecks: number;
  cogsKopecks: number;
  taxRate?: number;
}): number {
  const taxRate = input.taxRate ?? 0.15;
  const taxableBase = 
    (input.payoutKopecks || 0) - 
    (input.marketplaceCostsKopecks || 0) - 
    (input.cogsKopecks || 0);
  
  // Tax is only on profit, not losses
  if (taxableBase <= 0) return 0;
  
  return calcTax(taxableBase, taxRate);
}

/**
 * Calculate tax for УСН "Доходы" (6%).
 * Taxable base = total revenue (payout)
 * 
 * @param payoutKopecks - Income from WB
 * @param taxRate - Tax rate (default 0.06)
 * @returns Tax amount in kopecks
 */
export function calcTaxUSNIncome(payoutKopecks: number, taxRate = 0.06): number {
  return calcTax(payoutKopecks, taxRate);
}

/**
 * Normalize tax rate to decimal.
 * Handles both decimal (0.15) and percentage (15) inputs.
 * 
 * @param rate - Tax rate (decimal or percentage)
 * @returns Tax rate as decimal
 * 
 * @example
 * normalizeTaxRate(0.15) // 0.15
 * normalizeTaxRate(15) // 0.15
 * normalizeTaxRate(6) // 0.06
 */
export function normalizeTaxRate(rate: number): number {
  if (!rate || rate <= 0) return 0;
  // If rate > 1, assume it's a percentage
  return rate > 1 ? rate / 100 : rate;
}

/**
 * Compare tax burden between УСН systems.
 */
export interface TaxComparison {
  usnIncomeKopecks: number;
  usnExpensesKopecks: number;
  recommendation: 'income' | 'expenses' | 'equal';
  savingsKopecks: number;
}

/**
 * Compare УСН "Доходы" vs "Доходы минус расходы".
 * 
 * @param payoutKopecks - Income
 * @param marketplaceCostsKopecks - WB costs
 * @param cogsKopecks - COGS
 * @returns Tax comparison
 */
export function compareTaxSystems(
  payoutKopecks: number,
  marketplaceCostsKopecks: number,
  cogsKopecks: number
): TaxComparison {
  const usnIncome = calcTaxUSNIncome(payoutKopecks);
  const usnExpenses = calcTaxUSN({
    payoutKopecks,
    marketplaceCostsKopecks,
    cogsKopecks,
  });
  
  const diff = usnIncome - usnExpenses;
  
  return {
    usnIncomeKopecks: usnIncome,
    usnExpensesKopecks: usnExpenses,
    recommendation: diff > 0 ? 'expenses' : diff < 0 ? 'income' : 'equal',
    savingsKopecks: Math.abs(diff),
  };
}

/**
 * Calculate VAT (НДС).
 * Standard rate in Russia: 20%
 * 
 * @param baseKopecks - Tax base (added value or full price depending on method)
 * @param vatRate - VAT rate (default 0.20 = 20%)
 * @returns VAT amount in kopecks
 */
export function calcVat(baseKopecks: number, vatRate = 0.20): number {
  if (!baseKopecks || baseKopecks <= 0) return 0;
  return Math.round(baseKopecks * vatRate);
}

/**
 * Extract VAT from price that already includes VAT.
 * Formula: price × vatRate / (1 + vatRate)
 * 
 * @param priceWithVatKopecks - Price including VAT
 * @param vatRate - VAT rate (default 0.20)
 * @returns VAT amount in kopecks
 * 
 * @example
 * extractVat(120000, 0.20) // 20000 (VAT in 1200₽ price)
 */
export function extractVat(priceWithVatKopecks: number, vatRate = 0.20): number {
  if (!priceWithVatKopecks || priceWithVatKopecks <= 0) return 0;
  return Math.round(priceWithVatKopecks * vatRate / (1 + vatRate));
}

/**
 * Calculate net VAT payable (output VAT - input VAT).
 * 
 * @param outputVatKopecks - VAT charged on sales
 * @param inputVatKopecks - VAT paid on purchases (deductible)
 * @returns Net VAT to pay (can be negative = refund)
 */
export function calcNetVat(outputVatKopecks: number, inputVatKopecks: number): number {
  return (outputVatKopecks || 0) - (inputVatKopecks || 0);
}

/**
 * Tax system types supported.
 */
export type TaxSystem = 'usn_income' | 'usn_expenses' | 'osno' | 'patent';

/**
 * Full tax calculation input.
 */
export interface FullTaxInput {
  system: TaxSystem;
  revenueKopecks: number;
  expensesKopecks: number;
  cogsKopecks: number;
  /** For OSNO: input VAT to deduct */
  inputVatKopecks?: number;
  /** Custom tax rate (overrides default) */
  taxRate?: number;
}

/**
 * Full tax calculation result.
 */
export interface FullTaxResult {
  system: TaxSystem;
  incomeTaxKopecks: number;
  vatKopecks: number;
  totalTaxKopecks: number;
}

/**
 * Calculate all taxes based on tax system.
 * 
 * @param input - Tax calculation parameters
 * @returns Tax breakdown
 * 
 * @example
 * // УСН Д-Р
 * calcFullTax({
 *   system: 'usn_expenses',
 *   revenueKopecks: 1000000,
 *   expensesKopecks: 300000,
 *   cogsKopecks: 400000
 * }) // { incomeTaxKopecks: 45000, vatKopecks: 0, totalTaxKopecks: 45000 }
 * 
 * // ОСНО
 * calcFullTax({
 *   system: 'osno',
 *   revenueKopecks: 1000000,
 *   expensesKopecks: 300000,
 *   cogsKopecks: 400000,
 *   inputVatKopecks: 80000
 * }) // { incomeTaxKopecks: 60000, vatKopecks: 86667, totalTaxKopecks: 146667 }
 */
export function calcFullTax(input: FullTaxInput): FullTaxResult {
  const { system, revenueKopecks, expensesKopecks, cogsKopecks, inputVatKopecks = 0 } = input;
  
  let incomeTaxKopecks = 0;
  let vatKopecks = 0;
  
  switch (system) {
    case 'usn_income': {
      // УСН Доходы: 6% от выручки
      const rate = input.taxRate ?? 0.06;
      incomeTaxKopecks = calcTax(revenueKopecks, rate);
      vatKopecks = 0; // Без НДС
      break;
    }
    
    case 'usn_expenses': {
      // УСН Д-Р: 15% от прибыли
      const rate = input.taxRate ?? 0.15;
      const profit = revenueKopecks - expensesKopecks - cogsKopecks;
      incomeTaxKopecks = profit > 0 ? calcTax(profit, rate) : 0;
      vatKopecks = 0; // Без НДС
      break;
    }
    
    case 'osno': {
      // ОСНО: 20% налог на прибыль + НДС 20%
      const profitRate = input.taxRate ?? 0.20;
      const profit = revenueKopecks - expensesKopecks - cogsKopecks;
      incomeTaxKopecks = profit > 0 ? calcTax(profit, profitRate) : 0;
      
      // НДС: исходящий (от выручки) - входящий (от закупок)
      const outputVat = extractVat(revenueKopecks, 0.20);
      vatKopecks = calcNetVat(outputVat, inputVatKopecks);
      break;
    }
    
    case 'patent': {
      // Патент: фиксированная сумма, задаётся через taxRate как абсолютное значение
      incomeTaxKopecks = input.taxRate ?? 0;
      vatKopecks = 0;
      break;
    }
  }
  
  return {
    system,
    incomeTaxKopecks,
    vatKopecks: Math.max(0, vatKopecks), // VAT refund handled separately
    totalTaxKopecks: incomeTaxKopecks + Math.max(0, vatKopecks),
  };
}
