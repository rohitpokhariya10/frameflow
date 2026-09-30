import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { ProviderError } from './providers/adapters.js';
import { createRetryRun, createRun, executeRun, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { applyHeldObjectGrouping, composeSeedreamPrompt, type Planner } from './layerizePlanner.js';
import { createOpenAIFitChecker, fitInstruction, type FitChecker, type FitResult } from './layerizeTemplateFit.js';
import { TEMPLATES } from './layerizeTemplates.js';

const url = (name: string) => `https://v3b.fal.media/files/test/${name}.png`;
const image = () => sharp({ create: { width: 800, height: 600, channels: 3, background: 'white' } }).png().toBuffer();
function fakeTransport() {
  const base = sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  return { upload: vi.fn(async () => url('input')), submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'req-fit' })), status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async () => ({ layers: [{ image: { url: url('base') }, z_index: 0 }] })), cancel: vi.fn(), download: vi.fn(async () => base) } satisfies FalTransport;
}
const A_PROMPT = composeSeedreamPrompt('Keep the main subject whole. Separate each held object into its own layer.');
const plan: Planner = async () => ({ plan: { prompt: A_PROMPT, planned_layers: [], warnings: [] }, model: 'm', raw: {}, request: {} });
/** A fake fit check answering as the real one did for these images (24/24 on the twelve test images, 2026-09-29). */
const answer = (fits: boolean, bestTemplate: string | null, reason: string, plausibleTemplates: string[] = []): FitChecker => vi.fn(async (): Promise<FitResult> => ({ fits, bestTemplate, plausibleTemplates, reason, model: 'fit-model', responseId: 'resp-fit', request: { shown: true }, raw: { ok: true } }));
const PRODUCT = 'The image features a single dominant smartphone staged among decorative spheres, not a subject inside a decorative portrait frame.';

describe('template fit check (before planning and before any paid Seedream call)', () => {
  it('stops Template A on a single-product image before OpenAI planning and before fal, and names the template that fits', async () => {
    // The reported case: Template A, "Separate held object from subject" unticked, on the phone-and-spheres image.
    const planner = vi.fn(plan), transport = fakeTransport(), transports = vi.fn(() => transport), fitCheck = answer(false, 'template-b', PRODUCT);
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-a', separateHeldObject: false });
    const run = await executeRun(dir, { planner, fitCheck, transport: transports, sleep: async () => undefined });
    expect(run).toMatchObject({ stage: 'failed', error: { code: 'TEMPLATE_NOT_SUITABLE', stage: 'planning' }, templateFit: { fits: false, bestTemplate: 'template-b', reason: PRODUCT } });
    expect(run.error!.message).toBe(`This image does not fit Template A: ${PRODUCT} It fits Template B: run it with Template B. Template A would ask Seedream for layers this image does not have, which Seedream rejects. Nothing was sent to Seedream (no charge). If the check is wrong, run it anyway.`);
    expect(fitCheck).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'template-a');
    // No planning, no upload, no submission.
    expect(planner).not.toHaveBeenCalled();
    expect(transports).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, 'template-fit.json'), 'utf8'))).toEqual({ request: { shown: true }, response: { ok: true } });
    expect(readRun(dir).templateFit).toEqual(run.templateFit);
  });

  it('stops Template B on a framed portrait the same way, naming Template A', async () => {
    const fitCheck = answer(false, 'template-a', 'The image shows a woman holding a clipboard inside a gold-edged oval frame, a framed portrait rather than a hero-product composition.');
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-b' });
    const run = await executeRun(dir, { planner: plan, fitCheck, transport: () => { throw new Error('no fal call'); }, sleep: async () => undefined });
    expect(run.error).toMatchObject({ code: 'TEMPLATE_NOT_SUITABLE' });
    expect(run.error!.message).toMatch(/^This image does not fit Template B: .* It fits Template A: run it with Template A\./);
    // An image no template fits is stopped too, without a suggestion.
    const none = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-b' });
    const noneRun = await executeRun(none.dir, { planner: plan, fitCheck: answer(false, null, 'A busy street scene with several people'), transport: () => { throw new Error('no fal call'); }, sleep: async () => undefined });
    expect(noneRun.error!.message).toMatch(/^This image does not fit Template B: A busy street scene with several people\. No template fits it clearly\./);
  });

  it('lets a fitting image through unchanged: same Template A planner input, final prompt and Seedream payload as without the check', async () => {
    for (const separateHeldObject of [true, false]) {
      const contexts: unknown[] = [];
      const planner: Planner = async (...args) => { contexts.push(args[2]); return plan(...args); };
      const transport = fakeTransport();
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-a', separateHeldObject });
      const run = await executeRun(dir, { planner, fitCheck: answer(true, 'template-a', 'A framed portrait.'), transport: () => transport, sleep: async () => undefined });
      expect(run).toMatchObject({ stage: 'done', templateFit: { fits: true, bestTemplate: 'template-a' } });
      expect(contexts).toEqual([{ separateHeldObject }]);
      expect(transport.submit.mock.calls[0][1]).toEqual({ image_url: url('input'), prompt: applyHeldObjectGrouping(A_PROMPT, separateHeldObject), image_size: 'auto', enhance_prompt_mode: 'standard', enable_safety_checker: true, sync_mode: false });
    }
    // A contradictory answer ("does not fit", yet the selected template is the best match) never blocks a run.
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-a' });
    expect(await executeRun(dir, { planner: plan, fitCheck: answer(false, 'template-a', 'Unclear.'), transport: () => fakeTransport(), sleep: async () => undefined })).toMatchObject({ stage: 'done', templateFit: { fits: true } });
  });

  it('checks reused saved prompts too, but not retries, automatic retries or runs the user chose to run anyway', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const saved = { templateKey: 'template-a', templateName: 'Template A', prompt: A_PROMPT, planned_layers: [], warnings: [], savedAt: 'now', sourceRunId: 'x', sourceImage: { file: 'original.png', width: 1, height: 1 }, plannerModel: 'm' };
    const reuse = await createRun(runsDir, await image(), { mode: 'template', ...saved }, { templateKey: 'template-a' });
    const reuseCheck = answer(true, 'template-a', 'A framed portrait.');
    await executeRun(reuse.dir, { planner: plan, fitCheck: reuseCheck, transport: () => fakeTransport(), sleep: async () => undefined });
    expect(reuseCheck).toHaveBeenCalledTimes(1);
    // Run anyway: recorded, not checked.
    const anyway = await createRun(runsDir, await image(), { mode: 'generated' }, { templateKey: 'template-a', skipFitCheck: true });
    expect(anyway.run.skipFitCheck).toBe(true);
    const skipped = answer(false, 'template-b', PRODUCT);
    expect(await executeRun(anyway.dir, { planner: plan, fitCheck: skipped, transport: () => fakeTransport(), sleep: async () => undefined })).toMatchObject({ stage: 'done' });
    expect(skipped).not.toHaveBeenCalled();
    expect(readRun(anyway.dir)).not.toHaveProperty('templateFit');
    // Explicit retries of a rejected run are not checked again.
    const failing = fakeTransport();
    failing.result.mockRejectedValue(Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, messages: [{ msg: 'x', type: 'invalid_request' }] } }));
    const b = await createRun(runsDir, await image(), { mode: 'generated' }, { templateKey: 'template-b' });
    await executeRun(b.dir, { planner: plan, fitCheck: answer(true, 'template-b', 'A hero product.'), transport: () => failing, sleep: async () => undefined });
    for (const providerPrompt of ['current', 'auto'] as const) {
      const retry = await createRetryRun(runsDir, b.dir, providerPrompt), check = answer(false, 'template-a', 'x');
      expect(await executeRun(retry.dir, { planner: plan, fitCheck: check, transport: () => fakeTransport(), sleep: async () => undefined })).toMatchObject({ stage: 'done' });
      expect(check).not.toHaveBeenCalled();
    }
  });

  it('fails clearly, before anything is sent, when the check itself fails', async () => {
    const transports = vi.fn(() => fakeTransport());
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await image(), { mode: 'generated' }, { templateKey: 'template-a' });
    const run = await executeRun(dir, { planner: plan, fitCheck: async () => { throw new Error('The template fit check (OpenAI m) failed (HTTP 503): unavailable'); }, transport: transports, sleep: async () => undefined });
    expect(run.error).toMatchObject({ code: 'FIT_CHECK_FAILED', message: 'The template fit check (OpenAI m) failed (HTTP 503): unavailable. Nothing was sent to Seedream.' });
    expect(transports).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'template-fit.json'))).toBe(false);
  });

  it('asks OpenAI with every template\'s own fit description and a strict answer, and rejects anything else', async () => {
    expect(TEMPLATES.every(t => t.fit.length > 40)).toBe(true);
    for (const t of TEMPLATES) expect(fitInstruction()).toContain(`- ${t.key} (${t.name}): ${t.fit}`);
    const reply = (body: unknown, status = 'completed') => vi.fn(async () => ({ id: 'resp-1', status, output_text: JSON.stringify(body) }));
    const create = reply({ fits: false, best_template: 'template-b', reason: 'A hero product.' });
    const result = await createOpenAIFitChecker({ client: { responses: { create } } as never, model: 'fit-model' })(Buffer.from('x'), 'image/png', 'template-a');
    expect(result).toMatchObject({ fits: false, bestTemplate: 'template-b', reason: 'A hero product.', model: 'fit-model', responseId: 'resp-1' });
    const request = (create.mock.calls[0] as unknown as [{ instructions: string; input: { content: { type: string; text?: string }[] }[]; text: { format: { schema: { properties: { best_template: { enum: string[] } } } } } }])[0];
    expect(request.instructions).toBe(fitInstruction());
    expect(request.input[0].content[0].text).toBe('Selected template: template-a (Template A).');
    expect(request.text.format.schema.properties.best_template.enum).toEqual(['template-a', 'template-b', 'template-c', 'none']);
    // The request saved for debugging never embeds the image.
    expect(JSON.stringify(result.request)).not.toMatch(/base64/);
    expect((await createOpenAIFitChecker({ client: { responses: { create: reply({ fits: false, best_template: 'none', reason: 'r' }) } } as never })(Buffer.from('x'), 'image/png', 'template-b')).bestTemplate).toBeNull();
    for (const bad of [reply({ fits: 'yes', best_template: 'template-a', reason: 'r' }), reply({ fits: true, best_template: 'template-z', reason: 'r' }), reply({ fits: true, best_template: 'template-a', reason: 'r' }, 'incomplete'),
      vi.fn(async () => ({ status: 'completed', output_text: '{' })), vi.fn(async () => { throw Object.assign(new Error('down'), { status: 503 }); })]) {
      await expect(createOpenAIFitChecker({ client: { responses: { create: bad } } as never })(Buffer.from('x'), 'image/png', 'template-a')).rejects.toMatchObject({ code: 'FIT_CHECK_FAILED' });
    }
    await expect(createOpenAIFitChecker({})(Buffer.from('x'), 'image/png', 'template-a')).rejects.toMatchObject({ code: 'PLANNER_NOT_CONFIGURED' });
  });

  it('takes "Run anyway" from the upload form as skipFitCheck', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const deps = (): RunnerDeps => ({ planner: plan, fitCheck: answer(false, 'template-b', PRODUCT), transport: () => fakeTransport(), sleep: async () => undefined });
    const server = express().use('/x', createLayerizeRouter({ runsDir, deps })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo;
      const blob = new Blob([new Uint8Array(await image())], { type: 'image/png' });
      const post = async (fields: Record<string, string>) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('image', blob, 'x.png');
        const response = await fetch(`http://127.0.0.1:${port}/x/runs`, { method: 'POST', body: form });
        const body = await response.json();
        if (response.ok) for (let i = 0; i < 100 && (await (await fetch(`http://127.0.0.1:${port}/x/runs`)).json()).active; i++) await new Promise(done => setTimeout(done, 20));
        return { status: response.status, body };
      };
      const blocked = await post({ templateKey: 'template-a', separateHeldObject: 'false' });
      expect((await (await fetch(`http://127.0.0.1:${port}/x/runs/${blocked.body.id}`)).json()).error.code).toBe('TEMPLATE_NOT_SUITABLE');
      const anyway = await post({ templateKey: 'template-a', separateHeldObject: 'false', skipFitCheck: 'true' });
      expect(anyway.body).toMatchObject({ skipFitCheck: true });
      expect((await (await fetch(`http://127.0.0.1:${port}/x/runs/${anyway.body.id}`)).json()).stage).toBe('done');
      expect(await post({ templateKey: 'template-a', skipFitCheck: 'maybe' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIT_CHECK' } } });
    } finally { server.close(); }
  });
});
