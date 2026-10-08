import { calculateCallCost, AI_PRICING, type CostAmount } from '../aiPricing.js';

/** A typical decomposition planner call (docs/FRAMEFLOW_COSTING.md): what a reuse avoids, as an estimate only. */
export const TYPICAL_PLANNER_USAGE = { model: 'gpt-5.6-sol', inputTokens: 3376, outputTokens: 4835 } as const;
/** The estimated cost of planner calls not made. Zero avoided calls save exactly zero; it is never a measured amount. */
export function avoidedPlannerCost(calls: number, fx: number = AI_PRICING.budgetUsdInr): CostAmount {
  const each = calculateCallCost({ kind: 'text', model: TYPICAL_PLANNER_USAGE.model, usage: { inputTokens: TYPICAL_PLANNER_USAGE.inputTokens, outputTokens: TYPICAL_PLANNER_USAGE.outputTokens, cachedTokens: 0 } }, 1).usd ?? 0;
  const usd = Math.max(0, calls) * each;
  return { usd, inr: usd * fx, knownUsd: usd, knownInr: usd * fx, confidence: calls ? 'Estimated' : 'Calculated',
    notes: calls ? [`${calls} planner call(s) avoided, priced at typical usage (${TYPICAL_PLANNER_USAGE.inputTokens} in / ${TYPICAL_PLANNER_USAGE.outputTokens} out tokens, ${TYPICAL_PLANNER_USAGE.model}).`] : ['No planner call was avoided.'] };
}
