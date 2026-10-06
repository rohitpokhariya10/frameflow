import { describe, expect, it, vi } from 'vitest';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { PROTECTION_CLAUSE, SEMANTIC_INSTRUCTION, SEMANTIC_SCHEMA, semanticPlan, type SemanticAnalysis, type SemanticElement } from './semanticPlanner.js';
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

/** An analysis with these [id, type] elements back to front, all independent and unattached. */
const analysisOf = (list: [string, string][]): SemanticAnalysis => ({ image_type: 'offer creative', scene_summary: 'A poster.', relationships: [], ambiguities: [], recommended_layer_count: list.length,
  decomposition_strategy: 'Separate the elements.', downstream_decomposition_prompt: `Rebuild as ${list.length} back-to-front layers.`,
  elements: list.map(([id, type], z): SemanticElement => ({ id, type, description: `${id.replace(/_/g, ' ')} as seen`, editable_independently: true, approximate_region: 'see image', z_order: z, confidence: 'high',
    occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } })) });

describe('fewer, meaningful layers: text effects and marks stay with their text', () => {
  // The plan Seedream rejected live (fal 422 "could not be processed for layer decomposition", request 01a11043…): one
  // extrusion behind four headline lines and a lone ™, each planned as its own layer.
  const rejected = analysisOf([['red_canvas', 'background'], ['photo_room_background', 'photographic background'], ['workstation', 'furniture and prop group'], ['drawer_storage_group', 'furniture and prop group'],
    ['floor_lamp', 'lighting fixture'], ['striped_chair', 'furniture'], ['floor_decor_group', 'decorative prop group'], ['woman_child_group', 'human group'], ['headline_extrusion', 'typographic shadow/backing'],
    ['text_this_is', 'headline text'], ['text_how', 'headline text'], ['text_we_work', 'headline text'], ['text_now', 'headline text'], ['trademark', 'legal text']]);

  it('folds a shared headline extrusion into the text lines and the ™ into the word it follows; the prompt says so', () => {
    const plan = semanticPlan(rejected);
    expect(plan.semantic_protection.merged).toEqual([{ id: 'headline_extrusion', parent: 'text_this_is', reason: 'text_effect' }, { id: 'trademark', parent: 'text_now', reason: 'attached_part' }]);
    expect(plan.planned_layers.map(l => l.name)).not.toEqual(expect.arrayContaining(['headline_extrusion', 'trademark']));
    expect(plan.planned_layers).toHaveLength(12);
    expect(plan.prompt).toMatch(/^Create 12 layers back-to-front: /);
    expect(plan.prompt).toContain('text now as seen together with trademark in the same layer');
    expect(plan.prompt).toContain('Each text layer keeps its own part of the headline extrusion.');
    expect(plan.prompt).not.toMatch(/text this is as seen together with headline extrusion/);
    expect(plan.prompt.endsWith(PROTECTION_CLAUSE)).toBe(true);
  });

  it('leaves alone what is not a lone effect or mark: a line ending in ™, a glowing headline typed as text, a legal disclaimer, a product shadow', () => {
    const accepted = analysisOf([['poster_background', 'background'], ['studio_photo_background', 'photographic_environment'], ['adult_and_baby', 'combined_human_subjects'], ['text_this_is', 'display_text'], ['text_now_tm', 'display_text']]);
    expect(semanticPlan(accepted).semantic_protection).toMatchObject({ merged: [], promptRebuilt: false });
    const others = analysisOf([['background', 'background'], ['product_drop_shadow', 'shadow'], ['phone', 'product'], ['neon_glow_headline', 'headline text'], ['price_text', 'text'], ['legal_disclaimer', 'legal text']]);
    expect(semanticPlan(others).semantic_protection.merged).toEqual([]);
    // With no text left to join, an effect stays as planned.
    expect(semanticPlan(analysisOf([['background', 'background'], ['title_outline', 'text outline effect']])).semantic_protection.merged).toEqual([]);
  });

  it('tells the planner to keep a photographic scene as one plate and text effects with their text', () => {
    for (const phrase of ['A photograph used as the scene of a creative is one background plate', 'separate an object from it only when it is an advertised product, a main subject',
      "A text line's own effects (extrusion, offset shadow, outline, glow) stay in that text's layer", 'tiny marks (™, ®, ©) stay with the text they follow']) expect(SEMANTIC_INSTRUCTION).toContain(phrase);
  });
});
