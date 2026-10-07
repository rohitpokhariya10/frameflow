/**
 * What reuse saves: only calls that were NOT made, priced at what this family's own novel-path calls cost when they
 * were made (observed), or at a documented default usage when the family has no such record (estimated). A call that
 * was made is never counted as saved; this is an estimate of a counterfactual and is always labelled Estimated.
 */
import { AI_PRICING, calculateCallCost, type CostAmount } from '../aiPricing.js';
import type { FamilyStats } from './types.js';

/** Typical usage of the two calls reuse avoids: one structural analysis, one full decomposition plan (docs/FRAMEFLOW_COSTING.md). */
export const DEFAULT_REUSE_USAGE = {
  analysis: { model: 'gpt-5.6-luna', inputTokens: 1800, outputTokens: 700 },
  planner: { model: 'gpt-5.6-sol', inputTokens: 3376, outputTokens: 4835 },
} as const;

export interface ReuseBaseline { analysisUsd: number; plannerUsd: number; source: 'family-observed' | 'default-estimate' | 'mixed'; notes: string[] }
const usd = (model: string, inputTokens: number, outputTokens: number) =>
  calculateCallCost({ kind: 'text', model, usage: { inputTokens, outputTokens, cachedTokens: 0 } }, 1).usd ?? 0;

/** Per-call saving baseline: the family's observed average when it has one, else the default usage at configured rates. */
export function reuseBaseline(stats?: Pick<FamilyStats, 'observed'>, models: { analysis?: string; planner?: string } = {}): ReuseBaseline {
  const notes: string[] = [];
  const pick = (kind: 'analysis' | 'planner') => {
    const seen = stats?.observed[kind];
    if (seen && seen.calls > 0) { notes.push(`${kind}: average of ${seen.calls} recorded call(s) of this family`); return { value: seen.usd / seen.calls, observed: true }; }
    const d = DEFAULT_REUSE_USAGE[kind], model = models[kind] ?? d.model;
    notes.push(`${kind}: default ${d.inputTokens} in / ${d.outputTokens} out tokens at ${model} rates`);
    return { value: usd(model, d.inputTokens, d.outputTokens), observed: false };
  };
  const a = pick('analysis'), p = pick('planner');
  return { analysisUsd: a.value, plannerUsd: p.value, source: a.observed && p.observed ? 'family-observed' : !a.observed && !p.observed ? 'default-estimate' : 'mixed', notes };
}

/** The estimated saving of avoided calls, as a cost amount (Estimated). Zero avoided calls save exactly zero. */
export function reuseSaving(avoided: { analysis: number; planner: number }, baseline: ReuseBaseline, fx: number = AI_PRICING.budgetUsdInr): CostAmount {
  const value = Math.max(0, avoided.analysis) * baseline.analysisUsd + Math.max(0, avoided.planner) * baseline.plannerUsd;
  const none = !avoided.analysis && !avoided.planner;
  return { usd: value, inr: value * fx, knownUsd: value, knownInr: value * fx, confidence: none ? 'Calculated' : 'Estimated',
    notes: none ? ['No call was avoided.'] : [`Avoided ${avoided.analysis} structural analysis and ${avoided.planner} decomposition planning call(s).`, ...baseline.notes] };
}
