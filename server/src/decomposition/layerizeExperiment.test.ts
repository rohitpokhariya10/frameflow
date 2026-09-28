import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { ProviderError } from './providers/adapters.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { backgroundRole, placeLayers, renderLayerizeOutputs } from './layerizeArtifacts.js';
import { backgroundResidualPercent } from './outerBackground.js';
import { createRun, executeRun, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { getTemplatePrompt, listTemplates, saveTemplatePrompt, targetLayerRange } from './layerizeTemplates.js';
import { applyHeldObjectGrouping, PROVIDER_LAYER_RULES, composeSeedreamPrompt, createOpenAIPlanner, HELD_OBJECT_COMBINED, HELD_OBJECT_SEPARATE, MAX_PLANNER_PROMPT, PLANNER_INSTRUCTION, PlannerError, RUN_LEVEL_RESERVE, separatesHeldObject, type Planner } from './layerizePlanner.js';
import { groupLayers, normalizeLayerCount } from './layerCount.js';

const png = (width: number, height: number, alpha = 255) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha } } }).png().toBuffer();
const url = (name: string) => `https://v3b.fal.media/files/test/${name}.png`;

function fakeTransport(files: Record<string, Buffer>, raw: unknown) {
  return {
    upload: vi.fn(async () => url('input')), submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'req-123' })),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async () => raw), cancel: vi.fn(),
    download: vi.fn(async (u: string) => files[u]),
  } satisfies FalTransport;
}
const PLAN_PROMPT = composeSeedreamPrompt('Separate the woman from the phone she holds.');
const plan: Planner = async () => ({ plan: { prompt: PLAN_PROMPT, planned_layers: [{ name: 'Woman', description: 'left' }], warnings: [] }, model: 'test-model', raw: {}, request: {} });

describe('OpenAI → Seedream layerize experiment', () => {
  it('a planner refusal, incomplete or invalid output makes zero fal calls', async () => {
    const outputs = [
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      { status: 'completed', output: [], output_text: '{"prompt": ' },
      { status: 'completed', output: [], output_text: JSON.stringify({ prompt: 'x'.repeat(2001), planned_layers: [], warnings: [] }) },
    ];
    const codes = [];
    for (const response of outputs) {
      const planner = createOpenAIPlanner({ client: { responses: { create: async () => response } } as never });
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(800, 600));
      const transport = fakeTransport({}, {});
      const run = await executeRun(dir, { planner, transport: () => transport, sleep: async () => undefined });
      expect(run.stage).toBe('failed');
      codes.push(run.error!.code);
      for (const call of [transport.upload, transport.submit, transport.status, transport.result]) expect(call).not.toHaveBeenCalled();
    }
    expect(codes).toEqual(['PLANNER_REFUSED', 'PLANNER_INCOMPLETE', 'PLANNER_INVALID_JSON', 'PLANNER_PROMPT_TOO_LONG']);
    await expect(createOpenAIPlanner({})(Buffer.from(''), 'image/png')).rejects.toBeInstanceOf(PlannerError);
  });

  it('sends OpenAI\'s layout prompt plus the provider layer rules, within the local limit', async () => {
    const reply = (prompt: string) => ({ responses: { create: async () => ({ status: 'completed', output: [], output_text: JSON.stringify({ prompt, planned_layers: [], warnings: [] }) }) } }) as never;
    const { plan } = await createOpenAIPlanner({ client: reply('  Separate the main subject and each held object.  ') })(Buffer.from('x'), 'image/png');
    expect(plan.prompt).toBe(`Separate the main subject and each held object.\n\n${PROVIDER_LAYER_RULES}`);
    expect(plan.prompt).toMatch(/\n\nSemantic layers: the background, the outer background region/);
    expect(plan.prompt).toMatch(/\n\nAvoid: foreground pieces left in background layers/);
    // OpenAI's cap leaves RUN_LEVEL_RESERVE characters for the per-run grouping text.
    expect((await createOpenAIPlanner({ client: reply('x'.repeat(MAX_PLANNER_PROMPT)) })(Buffer.from('x'), 'image/png')).plan.prompt.length).toBe(2000 - RUN_LEVEL_RESERVE);
    await expect(createOpenAIPlanner({ client: reply('x'.repeat(MAX_PLANNER_PROMPT + 1)) })(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ code: 'PLANNER_PROMPT_TOO_LONG' });
    // Template-compatible wording: nothing from one example image, and no rule forbidding background reconstruction.
    for (const text of [PLANNER_INSTRUCTION, PROVIDER_LAYER_RULES]) expect(text).not.toMatch(/woman|dumbbells? (beside|across)|pink|turquoise|backdrop details/i);
    expect(PROVIDER_LAYER_RULES).not.toMatch(/\b(woman|man|boy|girl|baby|dog|dumbbells?|phones?|clipboard|board|ball|toy|pink|turquoise|green|blue|gold(en)?|purple)\b/i);
    expect(`${PLANNER_INSTRUCTION}\n${PROVIDER_LAYER_RULES}`).not.toMatch(/(do not|don't|never|no) (invent|reconstruct|inpaint)[^.;:]*(backdrop|background)/i);
  });

  it('tells OpenAI the grouping choice, while asking for a reusable, count-free, separate-object prompt', async () => {
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify({ prompt: 'Separate each held object.', planned_layers: [], warnings: [] }) }));
    await createOpenAIPlanner({ client: { responses: { create } } as never })(Buffer.from('x'), 'image/png', { separateHeldObject: false });
    const text = (create.mock.calls[0] as unknown as [{ input: { content: { type: string; text?: string }[] }[] }])[0].input[0].content[0].text;
    expect(text).toContain('Run settings, applied to the final prompt by the system: held object separate from subject: no. Keep your prompt reusable: do not mention layer counts or this grouping choice, and describe held objects as separate layers.');
    expect(text).not.toMatch(/layer target|suggested|min |max /i);
  });

  it('provider rules ask only for semantic decomposition: no hidden-background reconstruction, no layer count', () => {
    // Semantic background separation, a whole subject, visible-content and held-object fidelity.
    expect(PROVIDER_LAYER_RULES).toMatch(/^Semantic layers: the background, the outer background region, the inner framed backdrop, the decorative border or frame, and the main subject, each as its own layer\./);
    expect(PROVIDER_LAYER_RULES).toMatch(/Keep the subject whole with its hands, fingers or paws, hair or fur, clothing and accessories\./);
    expect(PROVIDER_LAYER_RULES).toMatch(/Preserve visible content and boundaries, faces, text, logos, colors and each held object's original look; do not invent hidden anatomy or object parts\./);
    expect(PROVIDER_LAYER_RULES).toMatch(/\n\nAvoid: foreground pieces left in background layers; objects duplicated into the background or inside the subject layer; merging the subject into the background; fragmenting the subject; re-rendering or relighting held objects\.$/);
    // What the local steps now do is not asked of the provider: no full-canvas/hidden-background reconstruction or inpainting,
    // no holes/exclusions, no layer count. The planner is told not to ask for it either.
    expect(PROVIDER_LAYER_RULES).not.toMatch(/full-canvas|continued underneath|no hole|reconstruct|inpaint|texture, color, grain|layer target|\d+\s*layers/i);
    expect(PLANNER_INSTRUCTION).toMatch(/Do not ask for background reconstruction or inpainting: clean backgrounds are produced after decomposition\./);
    expect(PLANNER_INSTRUCTION).not.toMatch(/areas the subject and objects covered are to be reconstructed/);
    expect(PROVIDER_LAYER_RULES.length).toBeLessThan(700);
    // Room for OpenAI's part: the saved Template A layout part is 490 characters.
    expect(MAX_PLANNER_PROMPT).toBeGreaterThanOrEqual(490);
    // Not a grouping instruction: nothing in the fixed rules reads as "separate the held object".
    expect((PROVIDER_LAYER_RULES.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).filter(separatesHeldObject)).toEqual([]);
  });

  it('stores fal\'s own error detail in run.json and returns it from the API', async () => {
    const transport = fakeTransport({}, {});
    const rejected = Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request. Check the saved input and provider account.', false, 422), {
      providerDetail: { status: 422, billableUnits: '0', requestId: 'req-123', messages: [{ msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request', loc: 'body.image_url' }] } });
    transport.result.mockRejectedValue(rejected);
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const { dir, run: created } = await createRun(runsDir, await png(800, 600));
    const run = await executeRun(dir, { planner: plan, transport: () => transport, sleep: async () => undefined });
    expect(run.error).toMatchObject({ code: 'PROVIDER_DECOMPOSITION_REJECTED', stage: 'queued', provider: { code: 'PROVIDER_REJECTED', status: 422, billableUnits: '0', requestId: 'req-123', messages: [{ msg: expect.stringMatching(/could not be processed/), type: 'invalid_request', loc: 'body.image_url' }] } });
    expect(run.error!.message).toMatch(/^fal HTTP 422: The provided image could not be processed.*rejected the decomposition; this stored result is final for request req-123, so Resume returns the same error\. The output layer count is never sent to Seedream/);
    expect(readRun(dir).error).toEqual(run.error);
    // No automatic paid retry: one submission, one result read.
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.result).toHaveBeenCalledTimes(1);
    // Resume only re-reads the stored result (no submission) and keeps the same classification.
    const resumed = await resumeRun(dir, { planner: plan, transport: () => transport, sleep: async () => undefined });
    expect(resumed.error).toMatchObject({ code: 'PROVIDER_DECOMPOSITION_REJECTED', provider: { status: 422 } });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.result).toHaveBeenCalledTimes(2);
    const server = express().use('/x', createLayerizeRouter({ runsDir })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await (await fetch(`http://127.0.0.1:${port}/x/runs/${created.id}`)).json();
      expect(body.error.provider).toEqual(run.error!.provider);
    } finally { server.close(); }
  });

  it('submits once, and recovery uses the saved request ID without resubmitting', async () => {
    const raw = { layers: [{ image: { url: url('base') }, z_index: 0 }, { image: { url: url('phone') }, z_index: 1, name: 'Phone', bounding_box: { absolute: [100, 50, 300, 250] } }] };
    const files = { [url('base')]: await png(800, 600), [url('phone')]: await png(200, 200) };
    const transport = fakeTransport(files, raw);
    transport.result.mockRejectedValueOnce(new Error('network down'));
    const deps: RunnerDeps = { planner: plan, transport: () => transport, sleep: async () => undefined };
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(800, 600));
    const failed = await executeRun(dir, deps);
    expect(failed).toMatchObject({ stage: 'failed', error: { code: 'FAL_RESULT_FAILED' }, seedream: { requestId: 'req-123' } });
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe(PLAN_PROMPT);
    await expect(executeRun(dir, deps)).rejects.toThrow(/never submitted twice/);
    const done = await resumeRun(dir, deps);
    expect(done.stage).toBe('done');
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.result).toHaveBeenCalledTimes(2);
    expect(transport.result).toHaveBeenLastCalledWith('bytedance/seedream/v5/pro/layerize', 'req-123');
    expect(transport.submit.mock.calls[0][1]).toEqual({ image_url: url('input'), prompt: PLAN_PROMPT, image_size: 'auto', enhance_prompt_mode: 'standard', enable_safety_checker: true, sync_mode: false });
    // Re-render from the saved response and files: no lookups, no downloads.
    await resumeRun(dir, deps);
    expect(transport.result).toHaveBeenCalledTimes(2);
    expect(transport.download).toHaveBeenCalledTimes(2);
    for (const f of ['seedream-response.json', 'layer-00.png', 'layer-01.png', 'contact-sheet.png', 'reconstructed.png', 'layers.json']) expect(existsSync(join(dir, f))).toBe(true);
    expect(readRun(dir).layers!.map(l => l.placement.kind)).toEqual(['base', 'bbox-crop']);
  });

  it('saves a generated prompt as Template A and reuses it verbatim without calling OpenAI', async () => {
    const raw = { layers: [{ image: { url: url('base') }, z_index: 0 }, { image: { url: url('phone') }, z_index: 1, bounding_box: { absolute: [100, 50, 300, 250] } }] };
    const files = { [url('base')]: await png(800, 600), [url('phone')]: await png(200, 200) };
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    expect(() => getTemplatePrompt(runsDir, 'template-a')).toThrow(/no saved prompt/);
    const first = await createRun(runsDir, await png(800, 600));
    await executeRun(first.dir, { planner: plan, transport: () => fakeTransport(files, raw), sleep: async () => undefined });
    const saved = saveTemplatePrompt(runsDir, 'template-a', first.run.id, 'woman + dumbbells');
    expect(saved).toMatchObject({ templateKey: 'template-a', templateName: 'Template A', prompt: PLAN_PROMPT, sourceRunId: first.run.id, plannerModel: 'test-model', notes: 'woman + dumbbells' });
    expect(listTemplates(runsDir)[0].saved?.sourceRunId).toBe(first.run.id);

    const planner = vi.fn<Planner>(), transport = fakeTransport(files, raw);
    const second = await createRun(runsDir, await png(900, 700), { mode: 'template', ...getTemplatePrompt(runsDir, 'template-a') });
    const run = await executeRun(second.dir, { planner, transport: () => transport, sleep: async () => undefined });
    expect(run.stage).toBe('done');
    expect(planner).not.toHaveBeenCalled();
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.submit.mock.calls[0][1].prompt).toBe(saved.prompt);
    expect(run.promptSource).toMatchObject({ mode: 'template', templateKey: 'template-a', sourceRunId: first.run.id });
    expect(run.planner).toBeUndefined();
    expect(readFileSync(join(second.dir, 'prompt.txt'), 'utf8')).toBe(saved.prompt);
    // Only prompts OpenAI generated for a run can become a template prompt.
    expect(() => saveTemplatePrompt(runsDir, 'template-a', second.run.id)).toThrow(/reused Template A/);
    expect(() => saveTemplatePrompt(runsDir, 'template-z', first.run.id)).toThrow(/Unknown template/);
  });

  describe('held-object grouping ("Separate held object from subject")', () => {
    // Shaped like the saved Template A prompt: generic layout part (with one separation sentence) + the fixed rules.
    const layout = 'Keep the main subject as one layer, including body, hair or fur, clothing, accessories, and every hand, finger or paw. Separate each clearly separable held or foreground object into its own layer, keeping its attached components together. Include only visible foreground content, without completing hidden anatomy or object parts.';
    const saved = composeSeedreamPrompt(layout);
    const [layersRule, avoidRule] = PROVIDER_LAYER_RULES.split('\n\n');
    const outside = (text: string) => text.split(HELD_OBJECT_COMBINED).join('').match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];

    it('checked (default) sends today\'s prompt unchanged, with separation and background rules intact', () => {
      expect(applyHeldObjectGrouping(saved, true)).toBe(saved);
      expect(saved).toContain('Separate each clearly separable held or foreground object into its own layer');
      expect(saved).toContain(PROVIDER_LAYER_RULES);
      // A prompt without any separation sentence gets the fixed one, placed before the background rules.
      expect(applyHeldObjectGrouping(composeSeedreamPrompt('Keep the main subject as one layer.'), true)).toBe(`Keep the main subject as one layer.\n\n${HELD_OBJECT_SEPARATE}\n\n${PROVIDER_LAYER_RULES}`);
    });

    it('unchecked keeps subject and object together, with no conflicting instruction and unchanged background rules', () => {
      const combined = applyHeldObjectGrouping(saved, false);
      expect(combined).toBe(`Keep the main subject as one layer, including body, hair or fur, clothing, accessories, and every hand, finger or paw. Include only visible foreground content, without completing hidden anatomy or object parts.\n\n${HELD_OBJECT_COMBINED}\n\n${layersRule}\n\n${avoidRule.replace(' or inside the subject layer', '')}`);
      expect(outside(combined).filter(separatesHeldObject)).toEqual([]);
      expect(combined).not.toMatch(/inside the subject layer|held-object layer/);
      // The semantic layer list and the background part of "Avoid:" are byte-identical.
      expect(combined).toContain(layersRule);
      expect(combined).toContain('Avoid: foreground pieces left in background layers; objects duplicated into the background; merging the subject into the background;');
      expect(combined).toContain('re-rendering or relighting held objects');
      expect(combined.length).toBeLessThanOrEqual(2000);
    });

    it('sends the current fixed rules for prompts saved with earlier ones, and refuses over-long or contradictory results before Seedream', () => {
      const combinedRules = PROVIDER_LAYER_RULES.replace(' or inside the subject layer', '');
      for (const earlierRules of ['Background layers, including the base image and every background, backdrop and frame layer, must be clean.\n\nAvoid: the held object duplicated inside the subject layer.',
        'Layers: a base image of the clean scene without the subject or held objects; the outer background outside the frame.\n\nAvoid: objects duplicated into the background or inside the subject layer.',
        // V3, the rules in the currently saved Template A: replaced by the stable provider rules at send time.
        'Background layers are independent reusable assets, never duplicated or mixed: the outer background is one full-canvas layer.\n\nForeground layers keep only real visible content.\n\nAvoid: objects duplicated into the background or inside the subject layer.']) {
        const earlier = `Keep the subject whole. Separate each held object into its own layer.\n\n${earlierRules}`;
        expect(applyHeldObjectGrouping(earlier, true)).toBe(`Keep the subject whole. Separate each held object into its own layer.\n\n${PROVIDER_LAYER_RULES}`);
        expect(applyHeldObjectGrouping(earlier, false)).toBe(`Keep the subject whole.\n\n${HELD_OBJECT_COMBINED}\n\n${combinedRules}`);
      }
      // A prompt saved without any fixed rules gets the current ones.
      expect(applyHeldObjectGrouping('Separate each held object.', true)).toBe(`Separate each held object.\n\n${PROVIDER_LAYER_RULES}`);
      const longest = composeSeedreamPrompt(`Separate each held object. ${'x'.repeat(2000 - PROVIDER_LAYER_RULES.length - 2 - 27)}`);
      expect(longest.length).toBe(2000);
      expect(applyHeldObjectGrouping(longest, true)).toBe(longest);
      expect(() => applyHeldObjectGrouping(longest, false)).toThrow(expect.objectContaining({ code: 'PLANNER_PROMPT_TOO_LONG' }));
      expect(() => applyHeldObjectGrouping(composeSeedreamPrompt('Keep the subject. Do not include subject pixels in the held-object layer.'), false)).toThrow(expect.objectContaining({ code: 'GROUPING_CONFLICT' }));
      expect(separatesHeldObject('Do not extract the held object separately.')).toBe(false);
      for (const text of [HELD_OBJECT_SEPARATE, HELD_OBJECT_COMBINED]) expect(text).not.toMatch(/\b(woman|man|boy|girl|baby|dog|dumbbells?|phones?|clipboard|board|ball|toy|pink|turquoise|green|blue|gold(en)?|purple)\b/i);
    });

    it('never puts a layer count in the Seedream prompt: the count is applied locally after Seedream', () => {
      for (const separate of [true, false]) expect(applyHeldObjectGrouping(saved, separate)).not.toMatch(/layer target|layers including the base|\b\d+\s*-\s*\d+ layers\b/i);
      expect(applyHeldObjectGrouping.length).toBe(2);
    });

    it('fits the saved Template A shape within 2,000 characters in both modes', () => {
      // The saved Template A layout part is 490 characters; use the planner's full allowance to be stricter.
      const full = composeSeedreamPrompt(`Separate each clearly separable held or foreground object into its own layer, keeping its attached components together. ${'x'.repeat(MAX_PLANNER_PROMPT - 121)}`);
      for (const separate of [true, false]) expect(applyHeldObjectGrouping(full, separate).length).toBeLessThanOrEqual(2000);
    });

    it('applies per run in generate and reuse mode; reuse still skips OpenAI and templates keep the separate-object prompt', async () => {
      const raw = { layers: [{ image: { url: url('base') }, z_index: 0 }] };
      const files = { [url('base')]: await png(800, 600) };
      const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
      const planner = vi.fn<Planner>(async () => ({ plan: { prompt: saved, planned_layers: [], warnings: [] }, model: 'test-model', raw: {}, request: {} }));
      const sent = async (source: Parameters<typeof createRun>[2], separateHeldObject?: boolean) => {
        const transport = fakeTransport(files, raw);
        const { dir } = await createRun(runsDir, await png(800, 600), source, separateHeldObject === undefined ? {} : { separateHeldObject });
        const run = await executeRun(dir, { planner, transport: () => transport, sleep: async () => undefined });
        expect(run.stage).toBe('done');
        expect(transport.submit).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe(run.finalPrompt);
        return { run, prompt: transport.submit.mock.calls[0][1].prompt };
      };
      const generatedDefault = await sent({ mode: 'generated' });
      expect(generatedDefault.run.separateHeldObject).toBe(true);
      expect(generatedDefault.prompt).toBe(saved);
      expect(planner.mock.calls[0][2]).toEqual({ separateHeldObject: true });
      const generatedCombined = await sent({ mode: 'generated' }, false);
      expect(generatedCombined.run).toMatchObject({ separateHeldObject: false, finalPrompt: applyHeldObjectGrouping(saved, false), planner: { prompt: saved } });
      expect(generatedCombined.prompt).toBe(applyHeldObjectGrouping(saved, false));
      expect(planner).toHaveBeenCalledTimes(2);
      // One Template A prompt for both modes: saving from a combined run stores the separate-object form.
      expect(saveTemplatePrompt(runsDir, 'template-a', generatedCombined.run.id).prompt).toBe(saved);
      const template = { mode: 'template' as const, ...getTemplatePrompt(runsDir, 'template-a') };
      expect((await sent(template, true)).prompt).toBe(saved);
      const reuseCombined = await sent(template, false);
      expect(reuseCombined.prompt).toBe(applyHeldObjectGrouping(saved, false));
      expect(reuseCombined.prompt).toContain(HELD_OBJECT_COMBINED);
      expect(planner).toHaveBeenCalledTimes(2);
      // Target layers: stored in run.json, never told to the planner nor put in the prompt, in both prompt modes.
      const layerTarget = { templateKey: 'template-a', suggestedLayers: 6, targetLayers: 4 };
      const transport = fakeTransport(files, raw);
      const generatedTarget = await createRun(runsDir, await png(800, 600), { mode: 'generated' }, { layerTarget });
      const generated = await executeRun(generatedTarget.dir, { planner, transport: () => transport, sleep: async () => undefined });
      expect(planner.mock.calls[2][2]).toEqual({ separateHeldObject: true });
      expect(generated.finalPrompt).toBe(saved);
      expect(readRun(generatedTarget.dir).layerTarget).toEqual(layerTarget);
      const reuseTarget = await createRun(runsDir, await png(800, 600), template, { separateHeldObject: false, layerTarget: { ...layerTarget, suggestedLayers: 5, targetLayers: 2 } });
      const reused = await executeRun(reuseTarget.dir, { planner, transport: () => transport, sleep: async () => undefined });
      expect(planner).toHaveBeenCalledTimes(3);
      expect(reused.finalPrompt).toBe(applyHeldObjectGrouping(saved, false));
      expect(transport.submit.mock.calls[1][1].prompt).toBe(reused.finalPrompt);
    });

    it('takes separateHeldObject from the upload form (default true) and rejects other values', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
      const server = express().use('/x', createLayerizeRouter({ runsDir, deps: () => ({ planner: plan, transport: () => fakeTransport({}, {}), sleep: async () => undefined }) })).listen(0, '127.0.0.1');
      await new Promise(done => server.once('listening', done));
      try {
        const { port } = server.address() as AddressInfo;
        const image = new Blob([new Uint8Array(await png(800, 600))], { type: 'image/png' });
        const post = async (value?: string, extra: Record<string, string> = {}) => {
          const form = new FormData();
          if (value !== undefined) form.append('separateHeldObject', value);
          for (const [key, field] of Object.entries(extra)) form.append(key, field);
          form.append('image', image, 'x.png');
          const response = await fetch(`http://127.0.0.1:${port}/x/runs`, { method: 'POST', body: form });
          const body = await response.json();
          if (response.ok) for (let i = 0; i < 50 && (await (await fetch(`http://127.0.0.1:${port}/x/runs`)).json()).active; i++) await new Promise(done => setTimeout(done, 20));
          return { status: response.status, body };
        };
        expect((await post()).body.separateHeldObject).toBe(true);
        expect((await post('false')).body.separateHeldObject).toBe(false);
        expect(await post('maybe')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_GROUPING' } } });
        // Layer count: suggested from Template A and the checkbox; the exact target is stored as sent.
        expect((await post()).body.layerTarget).toEqual({ templateKey: 'template-a', suggestedLayers: 6 });
        const created = await post('false', { targetLayers: '3' });
        expect(created.body.layerTarget).toEqual({ templateKey: 'template-a', suggestedLayers: 5, targetLayers: 3 });
        expect((await (await fetch(`http://127.0.0.1:${port}/x/runs/${created.body.id}`)).json()).layerTarget).toEqual(created.body.layerTarget);
        // The earlier min/max range is no longer accepted for new runs.
        expect(await post('true', { minLayers: '4', maxLayers: '6' })).toMatchObject({ status: 400, body: { error: { code: 'LEGACY_LAYER_RANGE' } } });
        expect(await post('true', { templateKey: 'template-z' })).toMatchObject({ status: 400, body: { error: { code: 'UNKNOWN_TEMPLATE' } } });
      } finally { server.close(); }
    });
  });

  it('validates the exact target layer count before any OpenAI or fal call: 1..suggested combined, 3..suggested separate', async () => {
    expect(targetLayerRange('template-a', false)).toEqual({ min: 1, max: 5 });
    expect(targetLayerRange('template-a', true)).toEqual({ min: 3, max: 6 });
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const planner = vi.fn(plan), transports = vi.fn(() => fakeTransport({}, {}));
    await expect(createRun(runsDir, await png(800, 600), { mode: 'generated' }, { separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 6 } }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET_LAYERS', details: { suggestedLayers: 5, minTargetLayers: 1, maxTargetLayers: 5 } });
    expect(readdirSync(runsDir)).toEqual([]);
    const server = express().use('/x', createLayerizeRouter({ runsDir, deps: () => ({ planner, transport: transports, sleep: async () => undefined }) })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo;
      const image = new Blob([new Uint8Array(await png(800, 600))], { type: 'image/png' });
      const post = async (fields: Record<string, string>) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('image', image, 'x.png');
        const response = await fetch(`http://127.0.0.1:${port}/x/runs`, { method: 'POST', body: form });
        const body = await response.json();
        if (response.ok) for (let i = 0; i < 50 && (await (await fetch(`http://127.0.0.1:${port}/x/runs`)).json()).active; i++) await new Promise(done => setTimeout(done, 20));
        return { status: response.status, body };
      };
      const combined = { separateHeldObject: 'false' }, separate = { separateHeldObject: 'true' };
      expect(await post({ ...combined, targetLayers: '6' })).toEqual({ status: 400, body: { error: { code: 'INVALID_TARGET_LAYERS', suggestedLayers: 5, minTargetLayers: 1, maxTargetLayers: 5,
        message: 'Target layers must be a whole number from 1 to 5 for Template A in combined mode (5 is the natural semantic layer count).' } } });
      for (const target of ['2', '1']) expect(await post({ ...separate, targetLayers: target })).toEqual({ status: 400, body: { error: { code: 'INVALID_TARGET_LAYERS', suggestedLayers: 6, minTargetLayers: 3, maxTargetLayers: 6,
        message: `Target layers ${target} is too low for separate mode: background, subject and held object need at least 3 layers. Choose 3–6, or uncheck "Separate held object from subject" to allow fewer.` } } });
      for (const target of ['7', '0', '4.5', 'abc']) expect(await post({ ...separate, targetLayers: target })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TARGET_LAYERS' } } });
      // Rejected requests created no run and made no OpenAI or fal call.
      expect(readdirSync(runsDir)).toEqual([]);
      expect(planner).not.toHaveBeenCalled();
      expect(transports).not.toHaveBeenCalled();
      // Every allowed value is accepted and stored exactly as sent.
      for (const [mode, targets, suggestedLayers] of [[combined, [1, 2, 3, 4, 5], 5], [separate, [3, 4, 5, 6], 6]] as const) {
        for (const target of targets) {
          const accepted = await post({ ...mode, targetLayers: String(target) });
          expect(accepted.status).toBe(202);
          expect(accepted.body.layerTarget).toEqual({ templateKey: 'template-a', suggestedLayers, targetLayers: target });
        }
      }
    } finally { server.close(); }
  });

  describe('clean full-canvas outer background (rebuilt locally from the base)', () => {
    const W = 300, H = 450, GREEN = [60, 100, 40];
    // Textured green background with a blue oval backdrop and a gold border, like Template A.
    const green = () => { const buf = Buffer.alloc(W * H * 3); let seed = 7; for (let i = 0; i < W * H; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const d = (seed % 13) - 6; for (let c = 0; c < 3; c++) buf[i * 3 + c] = GREEN[c] + d; } return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).ensureAlpha().png().toBuffer(); };
    const svg = (w: number, h: number, body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
    const oval = svg(180, 240, '<ellipse cx="90" cy="120" rx="90" ry="120" fill="rgb(40,90,150)"/>');
    const ring = svg(194, 254, '<ellipse cx="97" cy="127" rx="94" ry="124" fill="none" stroke="rgb(200,170,80)" stroke-width="3"/>');
    const grey = svg(180, 240, '<ellipse cx="90" cy="120" rx="90" ry="120" fill="rgb(128,128,128)"/>');
    const subject = svg(60, 100, '<rect width="60" height="100" fill="rgb(220,30,30)"/>');
    const layer = (z: number, name: string | undefined, box?: readonly number[]) => ({ image: { url: url(`l${z}`) }, z_index: z, ...(name ? { name } : {}), ...(box ? { bounding_box: { absolute: box } } : {}) });

    it('replaces the provider placeholder with a full-canvas background: no backdrop, border or hole; raw layer kept', async () => {
      const base = await sharp(await green()).composite([{ input: oval, left: 60, top: 80 }, { input: ring, left: 53, top: 73 }]).png().toBuffer();
      const files = { [url('l0')]: base, [url('l1')]: await sharp(grey).png().toBuffer(), [url('l2')]: await sharp(oval).png().toBuffer(), [url('l3')]: await sharp(ring).png().toBuffer(), [url('l4')]: await sharp(subject).png().toBuffer() };
      const raw = { layers: [layer(0, undefined), layer(1, 'Outer green background outside frame', [60, 80, 240, 320]), layer(2, 'Inner blue backdrop inside oval frame', [60, 80, 240, 320]),
        layer(3, 'Golden oval decorative border', [53, 73, 247, 327]), layer(4, 'Main subject', [120, 150, 180, 250])] };
      const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
      const { layers } = await renderLayerizeOutputs(dir, raw, async u => files[u]);
      expect(layers[1]).toMatchObject({ zIndex: 1, name: 'Outer green background outside frame', file: 'outer-background.png', rawFile: 'layer-01.png', opaquePercent: 100,
        placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H }, rebuilt: { method: 'local-background-fill', from: ['layer-00.png', 'layer-02.png', 'layer-03.png'] } });
      // Every other layer is exactly as before; the provider's placeholder file is untouched.
      expect(layers.map(l => l.file)).toEqual(['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png', 'layer-04.png']);
      expect(readFileSync(join(dir, 'layer-01.png')).equals(files[url('l1')])).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'layers.json'), 'utf8')).layers[1].file).toBe('outer-background.png');
      const outer = await sharp(join(dir, 'outer-background.png')).raw().toBuffer({ resolveWithObject: true });
      expect(outer.info).toMatchObject({ width: W, height: H, channels: 4 });
      const px = (x: number, y: number) => [0, 1, 2, 3].map(c => outer.data[(y * W + x) * 4 + c]);
      let blueish = 0, n = 0; const sum = [0, 0, 0];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [r, g, b, a] = px(x, y);
        expect(a).toBe(255);
        if (b > g) blueish++;
        if (((x - 150) / 90) ** 2 + ((y - 200) / 120) ** 2 < 1) { n++; sum[0] += r; sum[1] += g; sum[2] += b; }
      }
      expect(blueish).toBe(0);
      sum.forEach((v, c) => expect(Math.abs(v / n - GREEN[c])).toBeLessThan(6));
      // Far from the frame, the base's own pixels are kept exactly.
      const baseRaw = await sharp(base).raw().toBuffer();
      for (const [x, y] of [[5, 5], [290, 440], [20, 200], [150, 20]]) expect(px(x, y)).toEqual([...baseRaw.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]);
      // The reconstruction still shows the backdrop and subject on top of the rebuilt background.
      const recon = await sharp(join(dir, 'reconstructed.png')).raw().toBuffer();
      expect([...recon.subarray((200 * W + 100) * 4, (200 * W + 100) * 4 + 3)]).toEqual([40, 90, 150]);
      expect([...recon.subarray((200 * W + 150) * 4, (200 * W + 150) * 4 + 3)]).toEqual([220, 30, 30]);
    });

    it('removes foreground left in the base (past the frame, or covered by no layer) with no smear, deterministically on re-render', async () => {
      // Seedream's base sometimes still holds the subject; here its sleeve crosses the frame into the outer background,
      // plus one smear next to the frame and one far away that no layer covers.
      const sleeve = svg(90, 60, '<rect width="90" height="60" fill="rgb(235,235,225)"/>');
      const base = await sharp(await green()).composite([{ input: oval, left: 60, top: 80 }, { input: ring, left: 53, top: 73 },
        { input: subject, left: 120, top: 150 }, { input: sleeve, left: 200, top: 250 }, { input: svg(14, 14, '<circle cx="7" cy="7" r="7" fill="rgb(250,245,200)"/>'), left: 250, top: 120 },
        { input: svg(10, 10, '<rect width="10" height="10" fill="rgb(240,240,240)"/>'), left: 20, top: 400 }]).png().toBuffer();
      const files = { [url('l0')]: base, [url('l1')]: await sharp(grey).png().toBuffer(), [url('l2')]: await sharp(oval).png().toBuffer(), [url('l3')]: await sharp(ring).png().toBuffer(),
        [url('l4')]: await sharp({ create: { width: 170, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: subject, left: 0, top: 0 }, { input: sleeve, left: 80, top: 100 }]).png().toBuffer() };
      const raw = { layers: [layer(0, undefined), layer(1, 'Outer background', [60, 80, 240, 320]), layer(2, 'Inner backdrop', [60, 80, 240, 320]),
        layer(3, 'Decorative border', [53, 73, 247, 327]), layer(4, 'Main subject', [120, 150, 290, 310])] };
      const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
      const first = await renderLayerizeOutputs(dir, raw, async u => files[u]);
      expect(first.layers[1].rebuilt).toMatchObject({ foreground: ['layer-04.png'], residualPercent: 0 });
      expect(first.layers[1].rebuilt!.contaminationPercent).toBeGreaterThan(0);
      const outer = await sharp(join(dir, 'outer-background.png')).removeAlpha().raw().toBuffer();
      // Every pixel is background: within the texture noise (±6) of the green, so no sleeve, smear, backdrop or border.
      let worst = 0;
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(outer[i * 3 + c] - GREEN[c]));
      expect(worst).toBeLessThanOrEqual(12);
      expect(backgroundResidualPercent(outer, W, H)).toBe(0);
      // The subject layer and raw files are untouched; the reconstruction still shows the sleeve from the subject layer.
      expect(first.layers.map(l => l.file)).toEqual(['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png', 'layer-04.png']);
      expect(readFileSync(join(dir, 'layer-00.png')).equals(base)).toBe(true);
      const recon = await sharp(join(dir, 'reconstructed.png')).raw().toBuffer();
      expect([...recon.subarray((280 * W + 240) * 4, (280 * W + 240) * 4 + 3)]).toEqual([235, 235, 225]);
      // Re-render from saved results: no downloads, identical output.
      const again = await renderLayerizeOutputs(dir, raw, async () => { throw new Error('re-render must not download'); });
      expect(again.layers).toEqual(first.layers);
      expect((await sharp(join(dir, 'outer-background.png')).removeAlpha().raw().toBuffer()).equals(outer)).toBe(true);
    });

    describe('robust across Template A edge cases', () => {
      /** Every pixel within texture noise of the green background, opaque, full canvas: no backdrop, border, subject, object, white, grey or hole. */
      const expectCleanGreen = async (file: string) => {
        const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ width: W, height: H, channels: 4 });
        let worst = 0, transparent = 0;
        for (let i = 0; i < W * H; i++) {
          if (data[i * 4 + 3] !== 255) transparent++;
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(data[i * 4 + c] - GREEN[c]));
        }
        expect(transparent).toBe(0);
        expect(worst).toBeLessThanOrEqual(12);
        const rgb = await sharp(file).removeAlpha().raw().toBuffer();
        expect(backgroundResidualPercent(rgb, W, H)).toBe(0);
      };
      const white = () => sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
      // Provider "outer background" layers seen in real runs: grey oval placeholder, thin ring, green with a hole, contaminated with the backdrop.
      const providerOuter = {
        grey: { png: () => sharp(grey).png().toBuffer(), box: [60, 80, 240, 320] },
        ring: { png: () => sharp(svg(200, 260, '<ellipse cx="100" cy="130" rx="97" ry="127" fill="none" stroke="rgb(60,100,40)" stroke-width="3"/>')).png().toBuffer(), box: [50, 70, 250, 330] },
        holed: { png: async () => sharp(await green()).composite([{ input: svg(W, H, '<ellipse cx="150" cy="200" rx="95" ry="125" fill="black"/>'), blend: 'dest-out' }]).png().toBuffer(), box: undefined },
        withBackdrop: { png: async () => sharp(await green()).composite([{ input: oval, left: 60, top: 80 }]).png().toBuffer(), box: undefined },
      } as const;
      const variants = [
        { name: 'boy + ball', subject: [120, 150, 60, 110], object: [100, 160, 40, 40], color: [230, 230, 220] },
        { name: 'girl + clipboard', subject: [130, 140, 70, 130], object: [95, 170, 50, 70], color: [240, 240, 240] },
        { name: 'girl + phone', subject: [125, 150, 60, 120], object: [110, 150, 20, 40], color: [180, 150, 210] },
        // Subject crosses the frame at the bottom right, like the tight crops seen in real runs.
        { name: 'baby + toy', subject: [150, 200, 110, 140], object: [120, 180, 20, 45], color: [240, 190, 200] },
      ];
      const rect = (w: number, h: number, [r, g, b]: number[]) => svg(w, h, `<rect width="${w}" height="${h}" fill="rgb(${r},${g},${b})"/>`);
      /** One synthetic Template A run: returns the rendered result and its folder. */
      const scenario = async (v: typeof variants[number], separate: boolean, outer: keyof typeof providerOuter, opts: { base?: 'scene' | 'white'; innerRingOnly?: boolean; source?: 'original' | 'none' } = {}) => {
        const [sx, sy, sw, sh] = v.subject, [ox, oy, ow, oh] = v.object;
        const subjectPng = rect(sw, sh, v.color), objectPng = rect(ow, oh, [250, 200, 30]);
        const original = await sharp(await green()).composite([{ input: oval, left: 60, top: 80 }, { input: svg(194, 254, '<ellipse cx="97" cy="127" rx="94" ry="124" fill="none" stroke="rgb(200,170,80)" stroke-width="1"/>'), left: 53, top: 73 },
          { input: subjectPng, left: sx, top: sy }, { input: objectPng, left: ox, top: oy }]).png().toBuffer();
        // The provider base: the full scene (subject included), or a re-rendered white background.
        const base = opts.base === 'white' ? await sharp(await white()).composite([{ input: oval, left: 60, top: 80 }]).png().toBuffer() : original;
        const inner = opts.innerRingOnly ? svg(180, 240, '<ellipse cx="90" cy="120" rx="80" ry="110" fill="none" stroke="rgb(40,90,150)" stroke-width="20"/>') : oval;
        const o = providerOuter[outer];
        const files: Record<string, Buffer> = { [url('l0')]: base, [url('l1')]: await o.png(), [url('l2')]: await sharp(inner).png().toBuffer(),
          [url('l3')]: await sharp(svg(194, 254, '<ellipse cx="97" cy="127" rx="94" ry="124" fill="none" stroke="rgb(200,170,80)" stroke-width="1"/>')).png().toBuffer(),
          [url('l4')]: await sharp(separate ? subjectPng : await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: subjectPng, left: sx, top: sy }, { input: objectPng, left: ox, top: oy }]).png().toBuffer()).png().toBuffer(),
          [url('l5')]: await sharp(objectPng).png().toBuffer() };
        const raw = { layers: [layer(0, undefined), layer(1, 'Outer green background', o.box), layer(2, 'Inner blue backdrop', [60, 80, 240, 320]), layer(3, 'Golden oval decorative border', [53, 73, 247, 327]),
          separate ? layer(4, 'Main subject', [sx, sy, sx + sw, sy + sh]) : layer(4, 'Main subject with held object', undefined), ...(separate ? [layer(5, 'Held object', [ox, oy, ox + ow, oy + oh])] : [])] };
        const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
        const rendered = await renderLayerizeOutputs(dir, raw, async u => files[u], { sourceImage: opts.source === 'none' ? undefined : original });
        return { dir, rendered, files };
      };

      for (const v of variants) for (const separate of [true, false]) {
        it(`${v.name}, ${separate ? 'separate' : 'combined'}: full-canvas clean outer background from a bad provider layer, used by the final output layers`, async () => {
          const outer = (['grey', 'ring', 'holed', 'withBackdrop'] as const)[variants.indexOf(v)];
          const { dir, rendered, files } = await scenario(v, separate, outer, { base: 'white' });
          const layer1 = rendered.layers[1];
          expect(layer1).toMatchObject({ file: 'outer-background.png', rawFile: 'layer-01.png', placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H }, rebuilt: { source: 'original' } });
          await expectCleanGreen(join(dir, 'outer-background.png'));
          // Raw provider layers are untouched; the white base did not leak in.
          expect(readFileSync(join(dir, 'layer-01.png')).equals(files[url('l1')])).toBe(true);
          expect(readFileSync(join(dir, 'layer-00.png')).equals(files[url('l0')])).toBe(true);
          // Final output layers at the smallest allowed target still carry the rebuilt background, not the raw layer.
          const target = separate ? 3 : 2;
          const { outputLayers } = await normalizeLayerCount(dir, rendered.canvas, rendered.layers, { suggestedLayers: separate ? 6 : 5, targetLayers: target });
          expect(outputLayers).toHaveLength(target);
          expect(outputLayers[0].sources).toContain('outer-background.png');
          expect(outputLayers.flatMap(l => l.sources)).not.toContain('layer-01.png');
        });
      }

      it('fills what the backdrop and a hairline border enclose, even when the backdrop alpha is only a ring', async () => {
        const { dir, rendered } = await scenario(variants[0], true, 'grey', { innerRingOnly: true });
        expect(rendered.layers[1].rebuilt!.enclosedPercent).toBeGreaterThan(5);
        await expectCleanGreen(join(dir, 'outer-background.png'));
      });

      it('falls back to the provider base when no usable uploaded image is given, and keeps the provider layer when nothing is visible', async () => {
        const fromBase = await scenario(variants[1], true, 'ring', { source: 'none' });
        expect(fromBase.rendered.layers[1].rebuilt).toMatchObject({ source: 'base', from: ['layer-00.png', 'layer-02.png', 'layer-03.png'] });
        await expectCleanGreen(join(fromBase.dir, 'outer-background.png'));
        // A source with another aspect ratio is not stretched onto the canvas: the base is used instead.
        const wide = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
        const { layers: wideLayers } = await renderLayerizeOutputs(fromBase.dir, { layers: [layer(0, undefined), layer(1, 'Outer background', [60, 80, 240, 320]), layer(2, 'Inner backdrop', [60, 80, 240, 320])] },
          async () => { throw new Error('files are on disk'); }, { sourceImage: wide });
        expect(wideLayers.find(l => l.rebuilt)!.rebuilt!.source).toBe('base');
        // The backdrop covers the whole canvas: no visible outer background, so nothing is invented.
        const full = svg(W, H, `<rect width="${W}" height="${H}" fill="rgb(40,90,150)"/>`);
        const files = { [url('l0')]: await green(), [url('l1')]: await sharp(grey).png().toBuffer(), [url('l2')]: await sharp(full).png().toBuffer() };
        const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
        const none = await renderLayerizeOutputs(dir, { layers: [layer(0, undefined), layer(1, 'Outer background', [60, 80, 240, 320]), layer(2, 'Inner backdrop', undefined)] }, async u => files[u]);
        expect(none.layers[1]).toMatchObject({ file: 'layer-01.png' });
        expect(none.layers[1].rebuilt).toBeUndefined();
        expect(none.warnings.join()).toMatch(/OUTER_BACKGROUND_NOT_REBUILT/);
        expect(existsSync(join(dir, 'outer-background.png'))).toBe(false);
      });

      it('uses the uploaded image in a real run and on re-render of an old run, with no provider call', async () => {
        // 600×900 so the upload passes the input checks and matches the canvas aspect.
        const big = async (png: Buffer | Promise<Buffer>, w = 600, h = 900) => sharp(await png).resize(w, h, { fit: 'fill' }).png().toBuffer();
        const original = await big(sharp(await green()).composite([{ input: oval, left: 60, top: 80 }, { input: ring, left: 53, top: 73 }, { input: subject, left: 120, top: 150 }]).png().toBuffer());
        const files = { [url('l0')]: await big(sharp(await white()).composite([{ input: oval, left: 60, top: 80 }]).png().toBuffer()), [url('l1')]: await sharp(grey).resize(360, 480).png().toBuffer(),
          [url('l2')]: await sharp(oval).resize(360, 480).png().toBuffer(), [url('l3')]: await sharp(ring).resize(388, 508).png().toBuffer(), [url('l4')]: await sharp(subject).resize(120, 200).png().toBuffer() };
        const raw = { layers: [layer(0, undefined), layer(1, 'Outer background', [120, 160, 480, 640]), layer(2, 'Inner backdrop', [120, 160, 480, 640]), layer(3, 'Decorative border', [106, 146, 494, 654]), layer(4, 'Main subject', [240, 300, 360, 500])] };
        const transport = fakeTransport(files, raw);
        const deps: RunnerDeps = { planner: plan, transport: () => transport, sleep: async () => undefined };
        const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), original, { mode: 'generated' }, { separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 3 } });
        const run = await executeRun(dir, deps);
        expect(run.layers![1].rebuilt).toMatchObject({ source: 'original' });
        const px = await sharp(join(dir, 'outer-background.png')).removeAlpha().raw().toBuffer();
        let whiteish = 0; for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) whiteish++;
        expect(whiteish).toBe(0);
        // An old run saved with the earlier rebuild re-renders with the improved one, without any provider call.
        const calls = () => [transport.upload, transport.submit, transport.status, transport.result, transport.download].map(f => f.mock.calls.length);
        const before = calls();
        writeFileSync(join(dir, 'outer-background.png'), await big(white()));
        await resumeRun(dir, deps);
        expect(calls()).toEqual(before);
        const again = await sharp(join(dir, 'outer-background.png')).removeAlpha().raw().toBuffer();
        expect(again.equals(px)).toBe(true);
        expect(readRun(dir).outputLayers!.flatMap(l => l.sources)).toContain('outer-background.png');
        expect(readRun(dir).outputLayers!.flatMap(l => l.sources)).not.toContain('layer-01.png');
      });
    });

    it('measures leftover contamination in a background', async () => {
      const clean = await sharp(await green()).removeAlpha().raw().toBuffer();
      expect(backgroundResidualPercent(clean, W, H)).toBe(0);
      const smeared = await sharp(await green()).composite([{ input: svg(40, 60, '<ellipse cx="20" cy="30" rx="20" ry="30" fill="rgb(230,240,200)"/>'), left: 200, top: 200 }]).removeAlpha().raw().toBuffer();
      expect(backgroundResidualPercent(smeared, W, H)).toBeGreaterThan(0.5);
    });

    it('leaves layers untouched when there is no inner backdrop to rebuild under', async () => {
      const files = { [url('l0')]: await green(), [url('l1')]: await sharp(subject).png().toBuffer() };
      const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
      const { layers } = await renderLayerizeOutputs(dir, { layers: [layer(0, undefined), layer(1, 'Main subject', [120, 150, 180, 250])] }, async u => files[u]);
      expect(layers.map(l => [l.file, l.rebuilt])).toEqual([['layer-00.png', undefined], ['layer-01.png', undefined]]);
      expect(existsSync(join(dir, 'outer-background.png'))).toBe(false);
    });

    describe('exact output layer count (local, after Seedream)', () => {
      const held = svg(30, 30, '<rect width="30" height="30" fill="rgb(250,210,40)"/>');
      /** Renders a synthetic Template A result: base, outer placeholder, inner backdrop, border, subject (+ held object). */
      const semantic = async (separate: boolean) => {
        const base = await sharp(await green()).composite([{ input: oval, left: 60, top: 80 }, { input: ring, left: 53, top: 73 }]).png().toBuffer();
        const files = { [url('l0')]: base, [url('l1')]: await sharp(grey).png().toBuffer(), [url('l2')]: await sharp(oval).png().toBuffer(), [url('l3')]: await sharp(ring).png().toBuffer(),
          [url('l4')]: await sharp(subject).png().toBuffer(), [url('l5')]: await sharp(held).png().toBuffer() };
        const raw = { layers: [layer(0, undefined), layer(1, 'Outer background', [60, 80, 240, 320]), layer(2, 'Inner backdrop', [60, 80, 240, 320]), layer(3, 'Decorative border', [53, 73, 247, 327]),
          layer(4, separate ? 'Main subject' : 'Main subject with held object', [120, 150, 180, 250]), ...(separate ? [layer(5, 'Held object', [100, 170, 130, 200])] : [])] };
        const dir = mkdtempSync(join(tmpdir(), 'layerize-'));
        const rendered = await renderLayerizeOutputs(dir, raw, async u => files[u]);
        return { dir, ...rendered, raw, files };
      };
      const names = (layers: { name?: string; placement: { kind: string } }[]) => layers.map(l => l.placement.kind === 'base' ? 'base' : l.name);

      it('combined (suggested 5): targets 5..1 give exactly that many layers, merging backgrounds first', async () => {
        const { dir, canvas, layers } = await semantic(false);
        const at = (targetLayers: number) => normalizeLayerCount(dir, canvas, layers, { suggestedLayers: 5, targetLayers });
        const five = await at(5);
        expect(five.outputLayers.map(l => l.file)).toEqual(['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png', 'layer-04.png']);
        expect(five.layerCount).toMatchObject({ suggestedLayers: 5, targetLayers: 5, providerReturnedLayers: 5, semanticLayers: 5, finalOutputLayers: 5, normalized: true, warnings: [] });
        const groups = async (t: number) => (await at(t)).layerCount.groups.map(g => [g.name, g.sourceLayers]);
        expect(await groups(4)).toEqual([['Base', ['layer-00.png']], ['Outer background', ['outer-background.png']], ['Inner backdrop + Border', ['layer-02.png', 'layer-03.png']], ['Main subject with held object', ['layer-04.png']]]);
        expect(await groups(3)).toEqual([['Base', ['layer-00.png']], ['Outer background + Inner backdrop + Border', ['outer-background.png', 'layer-02.png', 'layer-03.png']], ['Main subject with held object', ['layer-04.png']]]);
        expect(await groups(2)).toEqual([['Base + Outer background + Inner backdrop + Border', ['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png']], ['Main subject with held object', ['layer-04.png']]]);
        const one = await at(1);
        expect(one.layerCount.groups).toEqual([{ name: 'Composite (all layers)', file: 'output-01.png', sourceLayers: ['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png', 'layer-04.png'] }]);
        // Target 1 is the full composite: identical to the reconstruction.
        expect((await sharp(join(dir, 'output-01.png')).raw().toBuffer()).equals(await sharp(join(dir, 'reconstructed.png')).raw().toBuffer())).toBe(true);
        for (const t of [5, 4, 3, 2, 1]) expect((await at(t)).outputLayers).toHaveLength(t);
      });

      it('separate (suggested 6): targets 6..3 keep subject and held object as their own untouched layers', async () => {
        const { dir, canvas, layers } = await semantic(true);
        const at = (targetLayers: number) => normalizeLayerCount(dir, canvas, layers, { suggestedLayers: 6, targetLayers });
        for (const t of [6, 5, 4, 3]) {
          const { outputLayers } = await at(t);
          expect(outputLayers).toHaveLength(t);
          // The two foreground layers are the semantic layers themselves: same file, same placement.
          expect(outputLayers.slice(-2).map(l => [l.file, l.placement.kind, l.sources])).toEqual([['layer-04.png', 'bbox-crop', ['layer-04.png']], ['layer-05.png', 'bbox-crop', ['layer-05.png']]]);
        }
        expect(names((await at(5)).outputLayers)).toEqual(['base', 'Outer background', 'Inner backdrop + Border', 'Main subject', 'Held object']);
        expect(names((await at(4)).outputLayers)).toEqual(['base', 'Outer background + Inner backdrop + Border', 'Main subject', 'Held object']);
        const three = await at(3);
        expect(names(three.outputLayers)).toEqual(['Base + Outer background + Inner backdrop + Border', 'Main subject', 'Held object']);
        // Merged background: full canvas, the rebuilt outer background (not the grey placeholder) with the backdrop and border on top.
        const bg = await sharp(join(dir, three.outputLayers[0].file)).raw().toBuffer();
        const px = (x: number, y: number) => [...bg.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
        expect(px(5, 5)[3]).toBe(255);
        GREEN.forEach((v, c) => expect(Math.abs(px(5, 5)[c] - v)).toBeLessThanOrEqual(8));
        expect(px(150, 200)).toEqual([40, 90, 150, 255]);
        expect(three.layerCount.groups[0].sourceLayers).toEqual(['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png']);
        // Inner backdrop + border stays transparent outside the frame.
        const fiveMerged = (await at(5)).outputLayers[2];
        expect(fiveMerged).toMatchObject({ file: 'output-01.png', placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H } });
        expect((await sharp(join(dir, 'output-01.png')).raw().toBuffer())[(5 * W + 5) * 4 + 3]).toBe(0);
      });

      it('keeps the semantic layers without a target, reports fewer layers honestly, and merges extra foreground smallest-first', async () => {
        const { dir, canvas, layers } = await semantic(true);
        const none = await normalizeLayerCount(dir, canvas, layers, { suggestedLayers: 6 });
        expect(none.outputLayers.map(l => l.file)).toEqual(layers.map(l => l.file));
        expect(none.layerCount).toMatchObject({ normalized: false, finalOutputLayers: 6, providerReturnedLayers: 6 });
        const fewer = await normalizeLayerCount(dir, canvas, layers.slice(0, 2), { suggestedLayers: 6, targetLayers: 4 });
        expect(fewer.outputLayers).toHaveLength(2);
        expect(fewer.layerCount.warnings[0]).toMatch(/^FEWER_LAYERS_THAN_TARGET: Seedream returned 2 placeable layers, so 2 are output instead of 4/);
        // A third, smaller foreground piece merges into the largest foreground layer (the subject), keeping the held object apart.
        const extra = { ...layers[5], file: 'layer-06.png', name: 'Stray fragment', zIndex: 6, opaquePercent: 100, placement: { kind: 'bbox-crop' as const, x: 10, y: 10, width: 5, height: 5 } };
        expect(groupLayers([...layers, extra], 3).map(g => g.map(l => l.file))).toEqual([['layer-00.png', 'outer-background.png', 'layer-02.png', 'layer-03.png'], ['layer-04.png', 'layer-06.png'], ['layer-05.png']]);
      });

      it('applies the target in the run, and re-renders at another target from saved results with no provider call', async () => {
        const { raw, files } = await semantic(false);
        const transport = fakeTransport(files, raw);
        const deps: RunnerDeps = { planner: plan, transport: () => transport, sleep: async () => undefined };
        // The uploaded image only has to pass the input checks; the layers come from the synthetic Seedream result.
        const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(800, 600), { mode: 'generated' }, { separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 3 } });
        const run = await executeRun(dir, deps);
        expect(run.outputLayers).toHaveLength(3);
        expect(run.layers).toHaveLength(5);
        expect(run.layerCount).toMatchObject({ suggestedLayers: 5, targetLayers: 3, providerReturnedLayers: 5, finalOutputLayers: 3, normalized: true });
        expect(readRun(dir).layerCount).toEqual(run.layerCount);
        const calls = () => [transport.upload, transport.submit, transport.status, transport.result, transport.download].map(f => f.mock.calls.length);
        const before = calls();
        const again = await resumeRun(dir, deps, undefined, { targetLayers: 2 });
        expect(again.outputLayers).toHaveLength(2);
        expect(again.layerTarget).toEqual({ templateKey: 'template-a', suggestedLayers: 5, targetLayers: 2 });
        expect(calls()).toEqual(before);
        // Raw provider layers and the semantic layers are unchanged by re-rendering.
        expect(readFileSync(join(dir, 'layer-01.png')).equals(files[url('l1')])).toBe(true);
        expect(again.layers).toEqual(run.layers);
        await expect(resumeRun(dir, deps, undefined, { targetLayers: 6 })).rejects.toMatchObject({ code: 'INVALID_TARGET_LAYERS' });
        // A run saved with the earlier min/max range still loads and re-renders; a new target replaces the range.
        const legacy = readRun(dir);
        legacy.layerTarget = { templateKey: 'template-a', suggestedLayers: 5, minLayers: 4, maxLayers: 6 };
        writeFileSync(join(dir, 'run.json'), JSON.stringify(legacy));
        expect((await resumeRun(dir, deps)).layerCount).toMatchObject({ normalized: false, finalOutputLayers: 5 });
        expect((await resumeRun(dir, deps, undefined, { targetLayers: 4 })).layerTarget).toEqual({ templateKey: 'template-a', suggestedLayers: 5, targetLayers: 4 });
      });
    });

    it('recognizes background roles from the names Seedream returned in Template A runs', () => {
      for (const name of ['Outer green background outside oval frame', 'Outer full-canvas green background', 'Outer background', 'Outer green base background']) expect(backgroundRole(name)).toBe('outer');
      for (const name of ['Inner blue backdrop inside oval frame', 'Inner framed blue backdrop', 'Mottled blue inner backdrop', 'Inner oval blue backdrop']) expect(backgroundRole(name)).toBe('inner');
      for (const name of ['Golden oval decorative border', 'Gold oval frame', 'Thin gold oval decorative border', 'Decorative golden oval border']) expect(backgroundRole(name)).toBe('border');
      for (const name of ['Main subject (boy)', 'Held soccer ball', 'Foreground subject with held clipboard', 'Woman portrait', undefined]) expect(backgroundRole(name)).toBeUndefined();
    });
  });

  it('places full-canvas, cropped and uniformly scaled layers on the base and flags the rest', () => {
    const { canvas, placements, warnings } = placeLayers([
      { width: 1000, height: 1500, meta: { zIndex: 0 } },
      { width: 1000, height: 1500, meta: { zIndex: 1, bboxAbsolute: [10, 10, 400, 400] } },
      { width: 300, height: 200, meta: { zIndex: 2, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 600, height: 400, meta: { zIndex: 3, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 600, height: 100, meta: { zIndex: 4, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 50, height: 50, meta: { zIndex: 5 } },
    ]);
    expect(canvas).toEqual({ width: 1000, height: 1500 });
    expect(placements.map(p => p.kind)).toEqual(['base', 'full-canvas', 'bbox-crop', 'bbox-scaled', 'unresolved', 'unresolved']);
    expect(placements[2]).toMatchObject({ x: 100, y: 200, width: 300, height: 200 });
    expect(placements[3]).toMatchObject({ x: 100, y: 200, width: 300, height: 200 });
    // Unresolved layers keep their natural size and are never stretched into the box.
    expect(placements[4]).toMatchObject({ width: 600, height: 100 });
    expect(warnings.join()).toMatch(/UNRESOLVED_PLACEMENT: 2/);
  });
});
