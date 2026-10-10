import { describe, expect, it } from 'vitest';
import type { TemplateStructure, TemplateVersion } from '@frameflow/shared';
import { compileSimpleTemplatePlan, compileTemplatePlan, templatePlanPrompt, templatePlanStrategy, withoutSlots } from './compile.js';

// A three-product offer's structure (as a saved template has it): text and logos over a scene, two supporting products
// partly behind the main one, decorations, and an effect kept with the background.
const structure: TemplateStructure = {
  layers: [
    { id: 'background', role: 'background', order: 0, independent: true, required: true, zone: 'full-canvas' },
    { id: 'effect', role: 'effect', order: 1, independent: false, required: false, attachment: { relation: 'part_of_object', parent: 'background', keepWithParent: true, separationRisk: 'low' } },
    { id: 'decoration', role: 'decoration', order: 2, independent: true, required: false },
    { id: 'logo', role: 'logo', order: 3, independent: true, required: false, zone: 'top-left' },
    { id: 'headline', role: 'headline', order: 4, independent: true, required: true, zone: 'top-center' },
    { id: 'price', role: 'price', order: 5, independent: true, required: false, zone: 'top-center' },
    { id: 'supporting_product', role: 'supporting_product', order: 6, independent: true, required: false, zone: 'middle-left', occlusion: { occludedBy: ['main_product'], requiresReconstruction: true } },
    { id: 'supporting_product_2', role: 'supporting_product', order: 7, independent: true, required: false, zone: 'middle-right', occlusion: { occludedBy: ['main_product'], requiresReconstruction: true } },
    { id: 'main_product', role: 'main_product', order: 8, independent: true, required: true, zone: 'center' },
    { id: 'body_text', role: 'body_text', order: 9, independent: true, required: false, zone: 'bottom-center', occlusion: { occludedBy: ['price'], requiresReconstruction: false } },
  ],
  relationships: [{ source: 'headline', relation: 'above', target: 'main_product' }],
} as TemplateStructure;
const version: TemplateVersion = { templateId: 'tpl-test', version: 1, createdAt: '2026-10-10T00:00:00.000Z', name: 'Three Product Offer', description: 'Three products under an offer.', structure,
  plan: { strategy: templatePlanStrategy(structure), prompt: templatePlanPrompt(structure, true), recommendedLayers: 9, occlusionWording: true }, generationPrompt: { text: 'edit' },
  decomposition: { refinement: false, expectedEditorLayers: { min: 1, max: 16 } }, source: { executionId: 'none', runId: 'none', plannerModel: 'offline' } } as TemplateVersion;
const asked = (prompt: string) => Number(/^Create (\d+) layers?/.exec(prompt)?.[1]);

describe('a saved plan sent to Seedream asks for the layers the image has', () => {
  it('a simpler grouping is a simpler request: its prompt asks for exactly its own layers, not the saved plan\'s', () => {
    const saved = compileTemplatePlan(version, 'x'), simple = compileSimpleTemplatePlan(version, 'x');
    expect(asked(saved.prompt)).toBe(9);
    // Decorations go with the background and supporting products with the main one: fewer layers, and the provider is told so.
    expect(simple.planned_layers.map(l => l.name)).toEqual(['background', 'logo', 'headline', 'price', 'main_product', 'body_text']);
    expect(asked(simple.prompt)).toBe(simple.planned_layers.length);
    expect(simple.prompt).not.toBe(saved.prompt);
    expect(simple.prompt).not.toContain('a smaller product shown with the main one');
  });

  it('leaves out the layers of objects an edit removed, and what is kept with them, and keeps every other layer as saved', () => {
    const pruned = withoutSlots(version, ['logo', 'headline', 'price', 'body_text']), plan = compileTemplatePlan(pruned, 'x');
    expect(plan.planned_layers.map(l => l.name)).toEqual(['background', 'decoration', 'supporting_product', 'supporting_product_2', 'main_product']);
    expect(asked(plan.prompt)).toBe(5);
    expect(plan.prompt).not.toMatch(/logo|headline|price|caption/i);
    expect(plan.prompt).toContain('the full scene or surface behind every other element');
    expect(pruned.plan.recommendedLayers).toBe(5);
    // Nothing removed, an unknown slot, or the background: the saved version itself.
    expect(withoutSlots(version, [])).toBe(version);
    expect(withoutSlots(version, ['not_a_slot', 'background'])).toBe(version);
    // A removed parent takes what is kept with it; an occlusion by a removed layer is no longer described.
    const noScene = withoutSlots(version, ['main_product']);
    expect(noScene.structure.layers.map(l => l.id)).not.toContain('main_product');
    expect(noScene.structure.layers.find(l => l.id === 'supporting_product')!.occlusion!.occludedBy).toEqual([]);
    expect(() => compileTemplatePlan(noScene, 'x')).not.toThrow();
    expect(noScene.structure.relationships).toEqual([]);
    const marked = { ...version, structure: { ...structure, layers: [...structure.layers, { id: 'price_mark', role: 'badge', order: 5, independent: false, required: false, attachment: { relation: 'part_of_object', parent: 'price', keepWithParent: true, separationRisk: 'low' } }] } } as TemplateVersion;
    expect(withoutSlots(marked, ['price']).structure.layers.map(l => l.id)).not.toContain('price_mark');
  });
});
