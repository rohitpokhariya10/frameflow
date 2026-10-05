import { describe, expect, it, vi } from 'vitest';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { PROTECTION_CLAUSE, SEMANTIC_SCHEMA, semanticPlan } from './semanticPlanner.js';
import { semanticFixture } from './semanticPlanner.fixture.js';

describe('image-aware decomposition', () => {
  it('uses the actual image and preserves the structured analysis and final prompt without preset rules', async () => {
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(semanticFixture) }));
    const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
    const result = await planner(Buffer.from('actual variant'), 'image/png', { separateHeldObject: true, templateKey: 'template-a', semanticPlanning: true });
    // A person in the image: the model's prompt, plus the code-owned protection clause.
    expect(result.plan).toMatchObject({ prompt: `${semanticFixture.downstream_decomposition_prompt} ${PROTECTION_CLAUSE}`, semantic_analysis: semanticFixture, semantic_protection: { merged: [], promptRebuilt: false, clauseAppended: true } });
    expect(result.plan.planned_layers.map(l => l.name)).toEqual(['phone', 'person']);
    expect(result.request.text).toMatchObject({ format: { schema: SEMANTIC_SCHEMA, strict: true } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ image_url: `data:image/png;base64,${Buffer.from('actual variant').toString('base64')}` })]) })] }));
  });
  it('rejects dangling IDs, duplicate IDs, inconsistent counts and malformed analysis', () => {
    for (const value of [
      { ...semanticFixture, recommended_layer_count: 3 },
      { ...semanticFixture, relationships: [{ source: 'unknown', relationship: 'holding', target: 'phone' }] },
      { ...semanticFixture, elements: [semanticFixture.elements[0], semanticFixture.elements[0]] },
      { ...semanticFixture, elements: [{}] },
    ]) expect(() => semanticPlan(value)).toThrow();
  });
  it('rejects an oversized downstream prompt before returning a provider plan', async () => {
    const planner = createOpenAIPlanner({ client: { responses: { create: async () => ({ status: 'completed', output: [], output_text: JSON.stringify({ ...semanticFixture, downstream_decomposition_prompt: 'x'.repeat(2001) }) }) } } as never });
    await expect(planner(Buffer.from('image'), 'image/png', { separateHeldObject: true, semanticPlanning: true })).rejects.toMatchObject({ code: 'PLANNER_PROMPT_TOO_LONG' });
  });
});
