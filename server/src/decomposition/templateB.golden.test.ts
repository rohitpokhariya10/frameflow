import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECOMPOSITION_PLANNER_MODEL } from './aiModels.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { PLAN_SCHEMA_B, PLANNER_INSTRUCTION_B, TEMPLATE_B_OPTIONS, touchingGroupPrompt } from './layerizeTemplateB.js';
import { listTemplates } from './layerizeTemplates.js';

/**
 * Template B is frozen, like Template A (templateA.golden.test.ts): these fingerprints were taken from the committed
 * Template B (c4efce5) before any Template C work. A failure here means Template B's rules, schema, OpenAI request,
 * prompt pattern or template definition changed. Investigate; never update a fingerprint to make another change pass.
 */
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('Template B frozen behavior (golden)', () => {
  it('keeps its instruction, schema, option, prompt pattern and definition byte-identical; Template A\'s definition too', () => {
    const templates = listTemplates('/nonexistent');
    expect({
      PLANNER_INSTRUCTION_B: fingerprint(PLANNER_INSTRUCTION_B), PLAN_SCHEMA_B: fingerprint(JSON.stringify(PLAN_SCHEMA_B)), options: fingerprint(JSON.stringify(TEMPLATE_B_OPTIONS)),
      pattern: fingerprint(touchingGroupPrompt({ hero: 'white ceramic mug', hero_short: 'mug', hero_parts: 'its handle', object: 'cube', objects: 'cubes', other_layers: ['pale pedestal'] })),
      definitionB: fingerprint(JSON.stringify(templates.find(t => t.key === 'template-b'))), definitionA: fingerprint(JSON.stringify(templates.find(t => t.key === 'template-a'))),
    }).toEqual({ PLANNER_INSTRUCTION_B: '2444d641e6c25f5f', PLAN_SCHEMA_B: '01f79935f4d75d62', options: 'a99837a3e6b59bdd', pattern: '171c116abadb44ad', definitionB: '18eaf97532468b3f', definitionA: '969800774c728a31' });
  });

  it('sends OpenAI the same Template B request, touching on and off', async () => {
    const shapes: string[] = [], models: string[] = [];
    for (const touching of [true, false]) {
      const create = async (r: { instructions: string; model: string; text: unknown; input: { content: { text?: string }[] }[] }) => {
        // The planner model is configuration (aiModels.ts), not a Template B rule: the fingerprints are the original ones,
        // taken when the model was gpt-6-astra, so the request is compared with that name in place of the configured model.
        shapes.push(fingerprint(JSON.stringify({ i: r.instructions, t: r.input[0].content[0].text, m: 'gpt-6-astra', f: r.text })));
        models.push(r.model);
        return { status: 'completed', output: [], output_text: JSON.stringify({ prompt: 'Extract the lamp as one layer.', planned_layers: [], warnings: [], touching_group: null }) };
      };
      await createOpenAIPlanner({ client: { responses: { create } } as never })(Buffer.from('x'), 'image/png', { separateHeldObject: true, templateKey: 'template-b', templateOptions: { separateTouchingIndependentObjects: touching } });
    }
    expect(shapes).toEqual(['7dd81d87b5befdba', '4d6d7105ece0e57d']);
    expect(models).toEqual([DEFAULT_DECOMPOSITION_PLANNER_MODEL, DEFAULT_DECOMPOSITION_PLANNER_MODEL]);
  });
});
