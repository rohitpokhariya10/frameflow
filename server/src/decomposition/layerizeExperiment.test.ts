import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { ProviderError } from './providers/adapters.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { placeLayers } from './layerizeArtifacts.js';
import { createRetryRun, createRun, executeRun, isSafetyRejection, PlannerNotAllowedError, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { decompositionPlannerModel } from './aiModels.js';
import { createOpenAIPlanner, PlannerError, type Planner } from './layerizePlanner.js';
import { SEMANTIC_SCHEMA, TEMPLATE_CAPTURE_INSTRUCTION, TEMPLATE_CAPTURE_SCHEMA, semanticPlan } from './semanticPlanner.js';
import { productShadowFixture, semanticFixture } from './semanticPlanner.fixture.js';

const png = (width: number, height: number, alpha = 255) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha } } }).png().toBuffer();
const url = (name: string) => `https://v3b.fal.media/files/test/${name}.png`;

function fakeTransport(files: Record<string, Buffer>, raw: unknown) {
  return {
    upload: vi.fn(async () => url('input')), submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'req-123' })),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async () => raw), cancel: vi.fn(),
    download: vi.fn(async (u: string) => files[u]),
  } satisfies FalTransport;
}
const PLAN_PROMPT = 'Separate the woman from the phone she holds.';
const plan: Planner = async () => ({ plan: { prompt: PLAN_PROMPT, planned_layers: [{ name: 'Woman', description: 'left' }], warnings: [] }, model: 'test-model', raw: {}, request: {} });
const answer = (value: unknown) => ({ status: 'completed', output: [], output_text: JSON.stringify(value) });

describe('OpenAI → Seedream decomposition runs', () => {
  it('repairs an old truncated prompt only on explicit retry, keeps the inventory, and calls no planner again', async () => {
    const correct = semanticPlan(productShadowFixture);
    const damaged = { ...correct, prompt: correct.prompt.replace('Do not split the attached lid or surface markings into separate layers', 'Do not split the attached…') };
    const planner = vi.fn<Planner>(async () => ({ plan: damaged, model: 'offline', raw: {}, request: {} }));
    const transport = fakeTransport({}, {});
    transport.result.mockRejectedValue(new ProviderError('PROVIDER_REJECTED', 'The image could not be decomposed.', false, 422));
    const deps = { planner, transport: () => transport, sleep: async () => undefined };
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const original = await createRun(runsDir, await png(800, 600), { mode: 'generated' }, { refinement: true });
    await executeRun(original.dir, deps);
    const saved = readFileSync(join(original.dir, 'run.json'), 'utf8');
    const retry = await createRetryRun(runsDir, original.dir);
    expect(transport.submit).toHaveBeenCalledTimes(1); // Creating a retry itself makes no provider call.
    expect(retry.run.promptSource).toMatchObject({ mode: 'retry', prompt: correct.prompt, planned_layers: correct.planned_layers });
    expect(retry.run.warnings).toEqual([expect.stringContaining('PROMPT_REPAIRED_LOCALLY')]);
    const result = await executeRun(retry.dir, deps);
    expect(result.calls).toMatchObject({ planner: 0, seedreamInitial: 1 });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(transport.submit).toHaveBeenCalledTimes(2);
    expect(transport.submit.mock.calls[1][1].prompt).toBe(correct.prompt);
    expect(readFileSync(join(original.dir, 'run.json'), 'utf8')).toBe(saved);
  });
  it('a planner refusal, incomplete or invalid output makes zero fal calls', async () => {
    const outputs = [
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      { status: 'completed', output: [], output_text: '{"prompt": ' },
      answer({ ...semanticFixture, downstream_decomposition_prompt: 'x'.repeat(2001) }),
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

  it('persists a sanitized planner failure once, keeps the source image, and never reaches fal', async () => {
    const create = vi.fn(async () => { throw new OpenAI.APIConnectionError({ cause: Object.assign(new Error('private credential and image body'), { code: 'ECONNRESET' }) }); });
    const planner = createOpenAIPlanner({ client: { baseURL: 'https://user:password@api.openai.com/v1?secret=private', responses: { create } } as never });
    const image = await png(800, 600), { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), image, undefined, { refinement: true });
    const transport = fakeTransport({}, {}), log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = await executeRun(dir, { planner, transport: () => transport });
      expect(run).toMatchObject({ stage: 'failed', error: { code: 'PLANNER_API_ERROR', stage: 'planning', message: expect.stringContaining('ECONNRESET') }, calls: { planner: 1, seedreamInitial: 0 } });
      expect(run.timings.plannerMs).toBeGreaterThanOrEqual(0);
      const recorded = readFileSync(join(dir, 'openai-error.json'), 'utf8');
      expect(JSON.parse(recorded)).toMatchObject({ endpointHost: 'api.openai.com', timeoutMs: 180000, maxRetries: 0, imageBytes: image.length, error: { type: 'APIConnectionError', cause: { code: 'ECONNRESET' } } });
      expect(recorded + JSON.stringify(log.mock.calls) + JSON.stringify(run.error)).not.toMatch(/private|password|base64|credential/i);
      expect(readFileSync(join(dir, run.input.file))).toEqual(image);
      expect(create).toHaveBeenCalledTimes(1);
      expect(transport.upload).not.toHaveBeenCalled();
      expect(transport.submit).not.toHaveBeenCalled();
      expect(existsSync(join(dir, 'plan.json'))).toBe(false);
      expect(existsSync(join(dir, 'openai-response.json'))).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('plans with GPT-5.6 Sol unless OPENAI_DECOMPOSITION_MODEL names another model; only the model changes', async () => {
    const create = vi.fn(async (request: { model: string }) => { void request; return answer(semanticFixture); });
    const client = { responses: { create } } as never;
    const byDefault = await createOpenAIPlanner({ client })(Buffer.from('x'), 'image/png');
    const configured = await createOpenAIPlanner({ client, model: decompositionPlannerModel({ OPENAI_DECOMPOSITION_MODEL: 'gpt-5.4-mini' }) })(Buffer.from('x'), 'image/png');
    expect([byDefault.model, configured.model]).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini']);
    expect(create.mock.calls.map(([request]) => request.model)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini']);
    // Same request either way: instructions, image input and the strict plan schema.
    const [first, second] = create.mock.calls.map(([request]) => ({ ...request, model: '' }));
    expect(second).toEqual(first);
    expect(byDefault.plan).toEqual(configured.plan);
  });

  it('a template-creating run asks the SAME planner call for the template capture, and nothing else does', async () => {
    const roles = Object.fromEntries(semanticFixture.elements.map(e => [e.id, e.id === 'person' ? 'primary_subject' : 'held_object']));
    const captured = { ...semanticFixture, elements: semanticFixture.elements.map(e => ({ ...e, template_role: roles[e.id] })), reusable_template: { name: 'Subject Holding Product', description: 'A primary subject holding an object.' } };
    const create = vi.fn(async (request: { text: { format: { schema: unknown } } }) => answer(request.text.format.schema === TEMPLATE_CAPTURE_SCHEMA ? captured : semanticFixture));
    const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
    const plain = await planner(Buffer.from('x'), 'image/png'), capturing = await planner(Buffer.from('x'), 'image/png', { templateCapture: true });
    expect(plain.capture).toBeUndefined();
    expect(capturing.capture).toEqual({ roles, name: 'Subject Holding Product', description: 'A primary subject holding an object.' });
    // The capture is stripped before the plan is validated: the plan is the same either way.
    expect(capturing.plan).toEqual(plain.plan);
    const requests = create.mock.calls.map(([request]) => request as unknown as { instructions: string; text: { format: { schema: unknown } } });
    expect(requests.map(r => r.text.format.schema)).toEqual([SEMANTIC_SCHEMA, TEMPLATE_CAPTURE_SCHEMA]);
    expect(requests[0].instructions).not.toContain(TEMPLATE_CAPTURE_INSTRUCTION);
    expect(requests[1].instructions).toContain(TEMPLATE_CAPTURE_INSTRUCTION);
    // A capture without a role for every element is refused, not half-saved.
    const missing = createOpenAIPlanner({ client: { responses: { create: async () => answer({ ...captured, elements: captured.elements.map(({ template_role: _role, ...e }) => { void _role; return e; }) }) } } as never });
    await expect(missing(Buffer.from('x'), 'image/png', { templateCapture: true })).rejects.toMatchObject({ code: 'PLANNER_INVALID_JSON' });
  });

  it('a reuse execution\'s run can never reach the planner: refused at creation, and again at execution', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-')), image = await png(800, 600);
    for (const mode of ['REUSE_TEMPLATE_ORIGINAL', 'REUSE_TEMPLATE_WITH_EDIT'] as const)
      await expect(createRun(runsDir, image, { mode: 'generated' }, { templateExecution: { executionId: 'x', mode } })).rejects.toBeInstanceOf(PlannerNotAllowedError);
    await expect(createRun(runsDir, image, { mode: 'generated' }, { templateCapture: true })).rejects.toMatchObject({ code: 'INVALID_TEMPLATE_CAPTURE' });
    // A run record altered after creation still cannot plan: executeRun checks the mode again before any call.
    const { dir, run } = await createRun(runsDir, image, { mode: 'retry', fromRunId: 'saved', prompt: PLAN_PROMPT, planned_layers: [], warnings: [] }, { templateExecution: { executionId: 'x', mode: 'REUSE_TEMPLATE_ORIGINAL' } });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, promptSource: { mode: 'generated' } }));
    const planner = vi.fn<Planner>(), transport = fakeTransport({}, {});
    const refused = await executeRun(dir, { planner, transport: () => transport, sleep: async () => undefined });
    expect(refused).toMatchObject({ stage: 'failed', error: { code: 'PLANNER_NOT_ALLOWED' } });
    expect(planner).not.toHaveBeenCalled();
    expect(transport.upload).not.toHaveBeenCalled();
    // A creating run may plan.
    const creating = await createRun(runsDir, image, { mode: 'generated' }, { templateExecution: { executionId: 'y', mode: 'CREATE_TEMPLATE' }, templateCapture: true });
    expect(creating.run).toMatchObject({ templateCapture: true, templateExecution: { mode: 'CREATE_TEMPLATE' } });
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
    // Without fal's response date nothing says when it refused: no claim of intake, and none of a completed inference.
    expect(run.error!.message).toMatch(/^fal HTTP 422: The provided image could not be processed.*Seedream did not produce a valid decomposition for this image\/prompt combination\. fal billed 0 units for it\..*This is a layer-extraction failure, not an image-generation failure: any generated creative is kept\. This stored result is final for request req-123, so Resume returns the same error\. The output layer count is never sent to Seedream/);
    expect(run.error!.message).not.toMatch(/completed inference|at intake/);
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

  it('a 422 dated in the submission second, after the queue reported IN_PROGRESS, is never called an intake refusal (live 2026-10-08)', async () => {
    // Every live 422 so far: the queue said IN_PROGRESS for 52–132 s, yet fal's error Date header read the submission
    // second. The header is not when fal decided; inferring "refused at intake, nothing attempted" from it was wrong.
    const transport = fakeTransport({}, {});
    const statuses = ['IN_QUEUE', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] as const;
    transport.status.mockImplementation((async () => statuses[Math.min(transport.status.mock.calls.length - 1, statuses.length - 1)]) as never);
    transport.result.mockImplementation(async () => {
      const error = Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request. Check the saved input and provider account.', false, 422), {
        providerDetail: { status: 422, billableUnits: '0', requestId: 'req-422', messages: [{ msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request', loc: 'body.image_url' }] } });
      Object.defineProperty(error, 'providerBody', { value: { status: 422, headers: { date: new Date().toUTCString(), 'x-fal-billable-units': '0' }, body: { detail: [] } }, enumerable: false });
      throw error;
    });
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const run = await executeRun((await createRun(runsDir, await png(800, 600))).dir, { planner: plan, transport: () => transport, sleep: async () => undefined });
    expect(run.error).toMatchObject({ code: 'PROVIDER_DECOMPOSITION_REJECTED', provider: { billableUnits: '0', bodyFile: 'provider-error.json' } });
    expect(run.error!.message).not.toMatch(/at intake|no decomposition was attempted|answer is dated/);
    expect(run.error!.message).toContain('Seedream did not produce a valid decomposition for this image/prompt combination. fal billed 0 units for it.');
    expect(run.error!.message).toContain('layer-extraction failure, not an image-generation failure');
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('saves fal\'s complete error response to provider-error.json and links it from run.json', async () => {
    const transport = fakeTransport({}, {});
    const body = { detail: [{ loc: ['body', 'image'], msg: 'flagged', type: 'content_policy_violation', ctx: { extra_info: { reason: 'partner_validation_failed' } }, input: { prompt: 'p', image_url: 'https://v3b.fal.media/files/x.png' } }] };
    const rejected = Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), {
      providerDetail: { status: 422, billableUnits: '0', requestId: 'req-123', messages: [{ msg: 'flagged', type: 'content_policy_violation', loc: 'body.image', reason: 'partner_validation_failed' }] } });
    Object.defineProperty(rejected, 'providerBody', { value: { status: 422, headers: { 'x-fal-request-id': 'req-123' }, body }, enumerable: false });
    transport.result.mockRejectedValue(rejected);
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const { dir, run: created } = await createRun(runsDir, await png(800, 600));
    const run = await executeRun(dir, { planner: plan, transport: () => transport, sleep: async () => undefined });
    expect(run.error!.provider).toMatchObject({ bodyFile: 'provider-error.json', messages: [{ reason: 'partner_validation_failed' }] });
    expect(JSON.parse(readFileSync(join(dir, 'provider-error.json'), 'utf8'))).toMatchObject({ stage: 'queued', requestId: 'req-123', status: 422, headers: { 'x-fal-request-id': 'req-123' }, body });
    // run.json carries only the sanitized summary and the file name, never the echoed input.
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).not.toMatch(/v3b\.fal\.media\/files\/x\.png/);
    const server = express().use('/x', createLayerizeRouter({ runsDir })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo;
      expect((await (await fetch(`http://127.0.0.1:${port}/x/runs/${created.id}/files/provider-error.json`)).json()).body).toEqual(body);
    } finally { server.close(); }
    // An error without a captured body writes no file.
    const plain = fakeTransport({}, {});
    plain.result.mockRejectedValue(Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, messages: [] } }));
    const other = await createRun(runsDir, await png(800, 600));
    expect((await executeRun(other.dir, { planner: plan, transport: () => plain, sleep: async () => undefined })).error!.provider).not.toHaveProperty('bodyFile');
    expect(existsSync(join(other.dir, 'provider-error.json'))).toBe(false);
  });

  it('treats partner_validation_failed as a retryable decomposition rejection, not a safety rejection', async () => {
    // Shape of the real 422 (e.g. request 01a0ebf6-a725-7ae0-a231-96138ad0fc9d), whose identical request passed minutes earlier.
    const partner = () => Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, billableUnits: '0', requestId: 'req-123',
      messages: [{ msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation', loc: 'body.image', reason: 'partner_validation_failed' }] } });
    const transport = fakeTransport({}, {});
    transport.result.mockRejectedValue(partner());
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const { dir } = await createRun(runsDir, await png(800, 600));
    const run = await executeRun(dir, { planner: plan, transport: () => transport, sleep: async () => undefined });
    expect(run.error).toMatchObject({ code: 'PROVIDER_DECOMPOSITION_REJECTED', provider: { messages: [{ type: 'content_policy_violation', reason: 'partner_validation_failed' }] } });
    expect(run.error!.message).toMatch(/its reason is partner_validation_failed: the provider's own validation rejected the decomposition after inference\. It is not a safety flag on the image/);
    expect(run.error!.message).not.toMatch(/try a different image\.$/);
    expect(readRun(dir).error!.code).toBe('PROVIDER_DECOMPOSITION_REJECTED');
    // An explicit retry is allowed (a new run; the retry itself submits nothing).
    expect((await createRetryRun(runsDir, dir)).run).toMatchObject({ stage: 'uploaded', promptSource: { mode: 'retry', fromRunId: run.id } });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    // Without that reason, a content_policy_violation is still the safety checker.
    expect(isSafetyRejection({ status: 422, messages: [{ msg: 'flagged by a content checker', type: 'content_policy_violation', loc: 'body.image' }] })).toBe(true);
    expect(isSafetyRejection(partner().providerDetail)).toBe(false);
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
