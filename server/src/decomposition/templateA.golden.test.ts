import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { DEFAULT_DECOMPOSITION_PLANNER_MODEL } from './aiModels.js';
import { createRun, executeRun } from './layerizeExperiment.js';
import { applyHeldObjectGrouping, composeSeedreamPrompt, createOpenAIPlanner, HELD_OBJECT_COMBINED, HELD_OBJECT_SEPARATE, PLANNER_INSTRUCTION, promptProfile, PROVIDER_LAYER_RULES,
  PROVIDER_LAYER_RULES_COMBINED, type Planner } from './layerizePlanner.js';

/**
 * Template A is frozen: these fingerprints were taken from the working Template A (59/59 tests, the unticked-checkbox
 * fix included) before any Template B work. A failure here means Template A's prompts, planner request, run metadata or
 * Seedream payload changed. Investigate the change; never update a fingerprint to make a Template B change pass.
 */
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const FINGERPRINTED_WITH_MODEL = 'gpt-6-astra';
const LAYOUT = 'Keep the main subject as one layer, including body, hair or fur, clothing, accessories, and every hand, finger or paw. Separate each clearly separable held or foreground object into its own layer, keeping its attached components together. Include only visible foreground content, without completing hidden anatomy or object parts.';
/** A prompt saved with the earlier V2 fixed rules, as older saved Template A prompts are. */
const V2_SAVED = 'Keep the subject whole. Separate each held object into its own layer.\n\nLayers: a base image of the clean scene without the subject or held objects; the outer background outside the frame.\n\nAvoid: objects duplicated into the background or inside the subject layer.';

describe('Template A frozen behavior (golden)', () => {
  it('keeps every Template A rule text byte-identical', () => {
    expect({
      PLANNER_INSTRUCTION: fingerprint(PLANNER_INSTRUCTION), PROVIDER_LAYER_RULES: fingerprint(PROVIDER_LAYER_RULES), PROVIDER_LAYER_RULES_COMBINED: fingerprint(PROVIDER_LAYER_RULES_COMBINED),
      HELD_OBJECT_SEPARATE: fingerprint(HELD_OBJECT_SEPARATE), HELD_OBJECT_COMBINED: fingerprint(HELD_OBJECT_COMBINED),
    }).toEqual({ PLANNER_INSTRUCTION: 'fba6bf33d062d693', PROVIDER_LAYER_RULES: '499b468b959434c1', PROVIDER_LAYER_RULES_COMBINED: 'cdbb8f4e5d5dc263', HELD_OBJECT_SEPARATE: 'ddc83385a36b5afa', HELD_OBJECT_COMBINED: '2f8f47f397cef083' });
  });

  it('builds the same final Seedream prompt, ticked and unticked, for current and older saved prompts', () => {
    const saved = composeSeedreamPrompt(LAYOUT);
    expect({
      savedChecked: fingerprint(applyHeldObjectGrouping(saved, true)), savedUnchecked: fingerprint(applyHeldObjectGrouping(saved, false)),
      v2Checked: fingerprint(applyHeldObjectGrouping(V2_SAVED, true)), v2Unchecked: fingerprint(applyHeldObjectGrouping(V2_SAVED, false)),
    }).toEqual({ savedChecked: 'e1bfa04e65296858', savedUnchecked: '1dbaa02a5e5bb431', v2Checked: '75747be238bf033b', v2Unchecked: '95aabbcea82621a6' });
    // The profile the runner uses for Template A is exactly these functions.
    expect(promptProfile('template-a').adapt).toBe(applyHeldObjectGrouping);
    expect(promptProfile('template-a').compose).toBe(composeSeedreamPrompt);
  });

  it('sends OpenAI the same Template A request, ticked and unticked', async () => {
    const requests: { instructions: string; model: string; text: unknown; input: { content: { text?: string }[] }[] }[] = [];
    for (const separateHeldObject of [true, false]) {
      const create = async (request: typeof requests[number]) => { requests.push(request); return { status: 'completed', output: [], output_text: JSON.stringify({ prompt: 'Separate each held object.', planned_layers: [], warnings: [] }) }; };
      await createOpenAIPlanner({ client: { responses: { create } } as never })(Buffer.from('x'), 'image/png', { separateHeldObject });
    }
    // The planner model is configuration (aiModels.ts), not a Template A rule. The fingerprints are the original ones,
    // taken when the model was gpt-6-astra: with that name in place of the configured model the request is
    // byte-identical to then, so a model change moves nothing but `model`.
    const shape = (r: typeof requests[number]) => fingerprint(JSON.stringify({ i: r.instructions, t: r.input[0].content[0].text, m: FINGERPRINTED_WITH_MODEL, f: r.text }));
    expect(requests.map(shape)).toEqual(['cd4ac35296fb3724', '920079a2184ce71b']);
    expect(requests.map(r => r.model)).toEqual([DEFAULT_DECOMPOSITION_PLANNER_MODEL, DEFAULT_DECOMPOSITION_PLANNER_MODEL]);
    const a = promptProfile('template-a');
    expect({ maxPlannerPrompt: a.maxPlannerPrompt, lengthNote: a.lengthNote, inputText: fingerprint(a.inputText), checked: fingerprint(a.contextText(true)), unchecked: fingerprint(a.contextText(false)) })
      .toEqual({ maxPlannerPrompt: 1058, lengthNote: 'Keep "prompt" under 908 characters.', inputText: 'a751789867f7b22e', checked: '1071f3ebaee88499', unchecked: '80b27fa8f26a6c6e' });
  });

  it('writes the same run.json fields and Seedream payload fields, and tells the planner only the held-object setting', async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: 'white' } }).png().toBuffer();
    const base = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    const plannerPrompt = composeSeedreamPrompt('Keep the main subject whole. Separate each held object into its own layer.');
    for (const separateHeldObject of [true, false]) {
      const contexts: unknown[] = [];
      const planner: Planner = async (_image, _mime, context) => { contexts.push(context); return { plan: { prompt: plannerPrompt, planned_layers: [], warnings: [] }, model: 'm', raw: {}, request: {} }; };
      const submitted: Record<string, unknown>[] = [];
      const transport: FalTransport = { upload: async () => 'https://v3b.fal.media/files/t/in.png', submit: async (_endpoint, input) => { submitted.push(input); return { requestId: 'r' }; },
        status: async () => 'COMPLETED', result: async () => ({ layers: [{ image: { url: 'https://v3b.fal.media/files/t/b.png' }, z_index: 0 }] }), cancel: async () => undefined, download: async () => base };
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), image, { mode: 'generated' }, { separateHeldObject, templateKey: 'template-a', layerTarget: { templateKey: 'template-a', suggestedLayers: separateHeldObject ? 6 : 5 } });
      const run = await executeRun(dir, { planner, transport: () => transport, sleep: async () => undefined });
      expect(run.stage).toBe('done');
      expect(contexts).toEqual([{ separateHeldObject }]);
      expect(Object.keys(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')))).toEqual(['id', 'createdAt', 'updatedAt', 'stage', 'promptSource', 'templateKey', 'separateHeldObject', 'layerTarget', 'original', 'input',
        'seedream', 'timings', 'warnings', 'planner', 'finalPrompt', 'canvas', 'layers', 'outputLayers', 'layerCount']);
      expect(Object.keys(submitted[0])).toEqual(['image_url', 'prompt', 'image_size', 'enhance_prompt_mode', 'enable_safety_checker', 'sync_mode']);
      expect(submitted[0].prompt).toBe(applyHeldObjectGrouping(plannerPrompt, separateHeldObject));
    }
  });
});
