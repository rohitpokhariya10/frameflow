import type { TemplateReuseRecord } from './templateFamilies/types.js';
/** Diagnostic budgeting only. Standard, synchronous API rates; never provider invoice totals.
 * Sources checked 2026-10-07. See docs/AI_COST_TELEMETRY.md for attribution and missing-data rules.
 */
export const AI_PRICING = {
  version: '2026-10-07', budgetUsdInr: 90, targetInr: { min: 30, max: 33 },
  text: {
    'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2, write: undefined },
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20, write: 5 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2, write: undefined },
    'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5, write: 0.125 },
  },
  image: { model: 'gpt-image-2', textInput: 5, imageInput: 8, textCached: 1.25, imageCached: 2, output: 30 },
  seedream: { model: 'bytedance/seedream/v5/pro/layerize', low: 0.03375, high: 0.0675, thresholdPixels: 1536 * 1536 },
  sources: [
    'https://developers.openai.com/api/docs/pricing',
    'https://developers.openai.com/api/docs/models/gpt-5-mini',
    'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    'https://developers.openai.com/api/docs/models/gpt-6-luna',
    'https://fal.ai/models/bytedance/seedream/v5/pro/layerize',
  ],
} as const;
export type CostConfidence = 'Calculated' | 'Estimated' | 'Unknown';
export type StageId = 'reference' | 'generation' | 'fit' | 'planner' | 'seedream' | 'residual' | 'background' | 'curation' | 'editor';
export type StageStatus = 'Complete' | 'Running' | 'Skipped' | 'Failed' | 'Warning' | 'Pending';
export interface UsageFacts {
  inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
  imageInputTokens?: number; textInputTokens?: number; imageCachedTokens?: number; textCachedTokens?: number;
  imageOutputTokens?: number; textOutputTokens?: number;
}
export interface PaidCall {
  kind: 'text' | 'image' | 'seedream'; model?: string; requestId?: string; usage?: UsageFacts;
  rawLayers?: number; baseWidth?: number; baseHeight?: number; imageCount?: number; quality?: string;
  /** Explicit provider evidence of no charge, never inferred from a failure. */
  noCharge?: boolean; estimated?: boolean; note?: string;
}
export interface CostAmount { usd: number | null; inr: number | null; knownUsd: number; knownInr: number; confidence: CostConfidence; notes: string[] }
export interface DiagnosticStage { id: StageId; label: string; status: StageStatus; result: string; calls: PaidCall[]; callsMeasured: boolean; cost: CostAmount }
export interface DiagnosticPrompt { label: string; text: string; model?: string; inputTokens?: number }
export interface RawLayerDiagnostic { file: string; name: string; disposition: string; reasons: string[]; pass: number }
export interface RunDiagnostics {
  reuse?: TemplateReuseRecord; reuseSaving?: CostAmount;
  runId: string; updatedAt: string; fx: number; pricingVersion: string; sources: readonly string[]; stages: DiagnosticStage[];
  total: CostAmount; calls: number; callsMeasured: boolean; rawLayers: number | null; editorLayers: number;
  elapsedMs: number | null; prompts: DiagnosticPrompt[]; raw: RawLayerDiagnostic[]; notes: string[];
}
export function budgetFx(value?: string | number): number {
  const parsed = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AI_PRICING.budgetUsdInr;
}
const valid = (n: number | undefined): n is number => n !== undefined && Number.isSafeInteger(n) && n >= 0;
function amount(usd: number | null, fx: number, confidence: CostConfidence, notes: string[] = []): CostAmount {
  return { usd, inr: usd === null ? null : usd * fx, knownUsd: usd ?? 0, knownInr: (usd ?? 0) * fx, confidence, notes };
}
/** Only explicit dated snapshots inherit an alias's rate. Unknown models never use the configured default. */
const alias = (model = '') => model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
export function calculateCallCost(call: PaidCall, fx = AI_PRICING.budgetUsdInr as number): CostAmount {
  const unknown = (why: string) => amount(null, fx, 'Unknown', [why]);
  if (call.noCharge) return amount(0, fx, 'Calculated', ['Provider recorded zero billable units.']);
  const notes = call.note ? [call.note] : [];
  let estimated = call.estimated === true;
  if (call.kind === 'seedream') {
    if (call.model !== AI_PRICING.seedream.model) return unknown('No configured rate for the recorded provider endpoint.');
    if (!valid(call.rawLayers) || !valid(call.baseWidth) || !valid(call.baseHeight) || !call.baseWidth || !call.baseHeight) return unknown('Raw output count or native output base size is missing.');
    const pixels = call.baseWidth * call.baseHeight;
    // fal documents below/above, but not equality. Use the upper tier conservatively and disclose that assumption.
    if (pixels === AI_PRICING.seedream.thresholdPixels) { estimated = true; notes.push('At the 1536² boundary: upper tier assumed; verify provider billing.'); }
    const rate = pixels < AI_PRICING.seedream.thresholdPixels ? AI_PRICING.seedream.low : AI_PRICING.seedream.high;
    notes.push(`${call.rawLayers} raw layers × $${rate}; output base ${call.baseWidth}×${call.baseHeight}.`);
    return amount(call.rawLayers * rate, fx, estimated ? 'Estimated' : 'Calculated', notes);
  }
  const u = call.usage;
  if (!u || !valid(u.inputTokens) || !valid(u.outputTokens)) return unknown('Token usage was not saved; check provider billing.');
  for (const n of Object.values(u)) if (n !== undefined && !valid(n)) return unknown('Recorded token usage is invalid.');
  const cached = u.cachedTokens ?? 0, written = u.cacheWriteTokens ?? 0;
  if (cached + written > u.inputTokens) return unknown('Cache usage exceeds recorded input tokens.');
  let usd: number;
  if (call.kind === 'text') {
    const model = alias(call.model), rate = AI_PRICING.text[model as keyof typeof AI_PRICING.text];
    if (!rate) return unknown('No configured price for the recorded model.');
    if (written && rate.write === undefined) return unknown('No configured cache-write price for this model.');
    if (u.cachedTokens === undefined) { estimated = true; notes.push('Cache detail missing; input assumed uncached.'); }
    const long = model === 'gpt-5.6-sol' && u.inputTokens > 272_000;
    usd = ((u.inputTokens - cached - written) * rate.input + cached * rate.cached + written * (rate.write ?? 0)) * (long ? 2 : 1) + u.outputTokens * rate.output * (long ? 1.5 : 1);
    // Reasoning is already included in output_tokens; never bill it twice.
  } else {
    if (alias(call.model) !== AI_PRICING.image.model) return unknown('No configured image price for the recorded model.');
    if (!valid(u.imageInputTokens) || !valid(u.textInputTokens) || u.imageInputTokens + u.textInputTokens !== u.inputTokens) return unknown('Image/text input token split is missing or inconsistent.');
    if (written) return unknown('Image cache-write billing is not configured.');
    if (cached && (!valid(u.imageCachedTokens) || !valid(u.textCachedTokens) || u.imageCachedTokens + u.textCachedTokens !== cached)) return unknown('Cached image/text split is missing.');
    const imageCached = u.imageCachedTokens ?? 0, textCached = u.textCachedTokens ?? 0;
    if (imageCached > u.imageInputTokens || textCached > u.textInputTokens) return unknown('Cached modality usage exceeds input.');
    if (u.textOutputTokens || (u.imageOutputTokens !== undefined && u.imageOutputTokens !== u.outputTokens)) return unknown('Image output includes unsupported text billing.');
    const r = AI_PRICING.image;
    usd = (u.imageInputTokens - imageCached) * r.imageInput + (u.textInputTokens - textCached) * r.textInput + imageCached * r.imageCached + textCached * r.textCached + u.outputTokens * r.output;
  }
  return amount(usd / 1_000_000, fx, estimated ? 'Estimated' : 'Calculated', notes);
}
export function sumCosts(costs: CostAmount[], fx: number): CostAmount {
  const knownUsd = costs.reduce((sum, cost) => sum + cost.knownUsd, 0);
  const confidence = costs.some(c => c.confidence === 'Unknown') ? 'Unknown' : costs.some(c => c.confidence === 'Estimated') ? 'Estimated' : 'Calculated';
  return { ...amount(confidence === 'Unknown' ? null : knownUsd, fx, confidence), knownUsd, knownInr: knownUsd * fx, notes: costs.flatMap(c => c.notes) };
}
export const calculateStageCost = (calls: PaidCall[], fx: number) => sumCosts(calls.map(c => calculateCallCost(c, fx)), fx);
