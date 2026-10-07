import { describe, expect, it } from 'vitest';
import { AI_PRICING, budgetFx, calculateCallCost, calculateStageCost, sumCosts, type PaidCall } from './aiPricing.js';
const planner: PaidCall = { kind: 'text', model: 'gpt-5.6-sol', usage: { inputTokens: 3376, outputTokens: 4835, cachedTokens: 0, cacheWriteTokens: 3373, reasoningTokens: 1552 } };
const image: PaidCall = { kind: 'image', model: 'gpt-image-2', imageCount: 1, quality: 'medium', usage: { inputTokens: 1867, imageInputTokens: 1178, textInputTokens: 689, outputTokens: 1755 } };
const seed = (rawLayers: number): PaidCall => ({ kind: 'seedream', model: AI_PRICING.seedream.model, rawLayers, baseWidth: 1216, baseHeight: 1520 });
describe('recorded AI costs', () => {
  it('prices planner input, cache writes and output once, including reasoning', () => {
    expect(calculateCallCost(planner).usd).toBeCloseTo(0.113577, 8);
    expect(calculateCallCost({ ...planner, usage: { ...planner.usage!, reasoningTokens: 0 } })).toEqual(calculateCallCost(planner));
  });
  it('prices actual image usage, not a generic quality estimate', () => expect(calculateCallCost(image).usd).toBeCloseTo(0.065519, 8));
  it.each([[8, 24.3], [13, 39.4875]])('prices %i raw layers regardless of curated count', (n, inr) => expect(calculateCallCost(seed(n)).inr).toBeCloseTo(inr, 8));
  it('adds a residual Seedream call with its own native output size', () => expect(calculateStageCost([seed(13), { ...seed(3), baseWidth: 2048, baseHeight: 2048 }], 90).inr).toBeCloseTo(57.7125, 8));
  it.each(['no residual', 'skipped background', 'local curation'])('%s costs zero', () => expect(calculateStageCost([], 90)).toMatchObject({ inr: 0, confidence: 'Calculated' }));
  it('used background edit costs more than zero', () => expect(calculateCallCost({ ...image, quality: 'low', usage: { inputTokens: 1146, imageInputTokens: 1024, textInputTokens: 122, outputTokens: 196 } }).inr).toBeCloseTo(1.32138));
  it('uses one configurable INR budget rate', () => { expect(budgetFx('85')).toBe(85); expect(calculateCallCost(seed(8), 85).inr).toBeCloseTo(22.95); expect(budgetFx('bad')).toBe(90); });
  it('total equals unrounded stage sum', () => {
    const costs = [planner, image, seed(13)].map(c => calculateCallCost(c));
    expect(sumCosts(costs, 90).inr).toBeCloseTo(costs.reduce((n, c) => n + c.inr!, 0));
  });
  it('unknown usage preserves a known subtotal, never a fake complete total', () => {
    const total = calculateStageCost([planner, { kind: 'seedream', model: AI_PRICING.seedream.model }], 90);
    expect(total).toMatchObject({ inr: null, confidence: 'Unknown' }); expect(total.knownInr).toBeGreaterThan(10);
  });
  it('different images produce different totals', () => expect(calculateCallCost(seed(8)).inr).not.toEqual(calculateCallCost(seed(13)).inr));
  it('unknown models stay unknown, even with usage', () => expect(calculateCallCost({ ...planner, model: 'unpriced-model' }).confidence).toBe('Unknown'));
  it('missing text cache detail is explicitly estimated', () => expect(calculateCallCost({ ...planner, usage: { inputTokens: 10, outputTokens: 10 } }).confidence).toBe('Estimated'));
  it('prices recorded cache hits at their own rate and dated models', () => expect(calculateCallCost({ kind: 'text', model: 'gpt-5-mini-2025-08-07', usage: { inputTokens: 1000, cachedTokens: 600, outputTokens: 100 } }).usd).toBeCloseTo(0.000315, 8));
  it('never assumes image/text proportions or native Seedream dimensions', () => {
    expect(calculateCallCost({ ...image, usage: { inputTokens: 100, outputTokens: 100 } }).confidence).toBe('Unknown');
    expect(calculateCallCost({ ...seed(8), baseWidth: undefined }).confidence).toBe('Unknown');
  });
  it('marks the undocumented exact Seedream boundary as an assumption', () => expect(calculateCallCost({ ...seed(8), baseWidth: 1536, baseHeight: 1536 }).confidence).toBe('Estimated'));
  it('only explicit zero billable units prove a failed call was free', () => expect(calculateCallCost({ kind: 'seedream', noCharge: true }).inr).toBe(0));
  it('rejects inconsistent cache accounting', () => expect(calculateCallCost({ ...planner, usage: { inputTokens: 100, outputTokens: 1, cachedTokens: 200 } }).confidence).toBe('Unknown'));
});
