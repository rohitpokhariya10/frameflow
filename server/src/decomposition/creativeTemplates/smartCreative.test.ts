import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { compileResolvedEdit, compileTemplateEdit, parseSceneDescription, TEXT_FREE_RULE, type ResolverProposal, type SemanticCheck, type TemplateExecution, type TemplateStructure, type TemplateVersion, type VariantSet } from '@frameflow/shared';
import type { FalTransport } from '../providers/falClient.js';
import { readRun } from '../layerizeExperiment.js';
import { createOpenAIPlanner } from '../layerizePlanner.js';
import { templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './compile.js';
import { fileExecutionStore } from './executions.js';
import { createTemplateExecutions } from './service.js';
import { fileTemplateStore } from './store.js';
import { createSmartCreative, readSmartFeatures } from './smartCreative.js';
import { fileSceneStore, fileVariantStore } from './smartStores.js';
import { phoneOfferAnalysis } from './scene.fixture.js';
import { SEMANTIC_SCHEMA } from '../semanticPlanner.js';
import { readRunDiagnostics } from '../runDiagnostics.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const W = 800, H = 1000;
const px = (b: { x: number; y: number; w: number; h: number }) => ({ left: Math.round(b.x * W), top: Math.round(b.y * H), width: Math.round(b.w * W), height: Math.round(b.h * H) });
const rect = (b: { x: number; y: number; w: number; h: number }, color: string) => { const p = px(b); return { input: { create: { width: p.width, height: p.height, channels: 3 as const, background: color } }, left: p.left, top: p.top }; };
const PHONE = { x: 0.36, y: 0.2, w: 0.28, h: 0.52 }, BUDS = { x: 0.7, y: 0.62, w: 0.18, h: 0.16 }, HEADLINE = { x: 0.1, y: 0.06, w: 0.8, h: 0.1 };
/** The phone offer creative: a lavender field, a gold phone with a textured back, white earbuds and a dark headline bar. */
async function creative(background = '#dcd0f0') {
  const phone = px(PHONE), texture = Buffer.alloc(phone.width * phone.height * 3);
  for (let i = 0; i < phone.width * phone.height; i++) { texture[i * 3] = 200 + (i % 37); texture[i * 3 + 1] = 160 + (i % 23); texture[i * 3 + 2] = 60 + (i % 11); }
  return sharp({ create: { width: W, height: H, channels: 3, background } }).composite([{ input: texture, raw: { width: phone.width, height: phone.height, channels: 3 }, left: phone.left, top: phone.top }, rect(BUDS, '#fafafa'), rect(HEADLINE, '#222244')]).png().toBuffer();
}
const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
/** A saved template of the phone offer's structure (a main product, a supporting product, a headline, a background). */
function saveTemplate(templates: ReturnType<typeof fileTemplateStore>, thumbnail: Buffer): TemplateVersion {
  const structure: TemplateStructure = { layers: [{ id: 'background', role: 'background', order: 0, independent: true, required: false, zone: 'full-canvas' }, { id: 'headline', role: 'headline', order: 1, independent: true, required: true, zone: 'top-center' },
    { id: 'main_product', role: 'main_product', order: 2, independent: true, required: true, zone: 'center' }, { id: 'supporting_product', role: 'supporting_product', order: 3, independent: true, required: false, zone: 'bottom-right' }], relationships: [] };
  return templates.create(templateId => ({ templateId, version: 1, createdAt: new Date().toISOString(), name: 'Product Offer', description: 'A main product with a supporting product under a headline.', structure,
    plan: { strategy: templatePlanStrategy(structure), prompt: templatePlanPrompt(structure, true), recommendedLayers: 4, occlusionWording: true }, generationPrompt: { text: templateEditPrompt(structure) },
    decomposition: { refinement: false, expectedEditorLayers: { min: 1, max: 12 } }, source: { executionId: 'none', runId: 'none', plannerModel: 'offline' } }), { bytes: thumbnail, ext: 'png' }).version;
}
const emptyProposal = (): ResolverProposal => ({ understanding: [], inferred: [], conflicts: [], productPhoto: { present: false, category: '', brand: '', evidence: '', matchesRequest: 'unclear', description: '' } });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'smart-creative-'));
  const templates = fileTemplateStore(join(root, 'templates')), executions = fileExecutionStore(join(root, 'executions')), runsDir = join(root, 'runs');
  const scenes = fileSceneStore(join(root, 'analyses')), variants = fileVariantStore(join(root, 'variants'));
  // Seedream: every image comes back as its base plus one named layer (enough for a finished run).
  const decomposed: Buffer[] = [], files = new Map<string, Buffer>(), fal = { resultFailures: 0, baseScale: 1 };
  const transport: FalTransport = {
    upload: async image => { decomposed.push(image as Buffer); return `https://v3b.fal.media/files/t/in-${decomposed.length}.png`; },
    submit: async () => ({ requestId: `r${decomposed.length}` }), status: async () => 'COMPLETED',
    result: async (_e, id) => {
      if (fal.resultFailures > 0) { fal.resultFailures--; throw new Error('fal result temporarily unavailable'); }
      // Seedream may answer at another size than it was given (image_size auto).
      const input = decomposed[Number(id.slice(1)) - 1], meta = await sharp(input).metadata(), width = Math.round(meta.width! * fal.baseScale), height = Math.round(meta.height! * fal.baseScale);
      files.set(`base-${id}`, await sharp(input).resize(width, height, { fit: 'fill' }).png().toBuffer());
      files.set(`${id}-0`, await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await png(120, 120, '#ff8800'), left: 40, top: 40 }]).png().toBuffer());
      return { layers: [{ image: { url: `https://v3b.fal.media/files/t/base-${id}.png` }, z_index: 0 }, { image: { url: `https://v3b.fal.media/files/t/${id}-0.png` }, z_index: 1, name: 'Decorative shape' }] };
    },
    cancel: async () => undefined, download: async url => files.get(/files\/t\/(.+)\.png$/.exec(url)![1])!,
  };
  const plannerCalls = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify({ image_type: 'scenery', scene_summary: 'Scenery.', elements: [
    { id: 'scene', type: 'background', description: 'Scenery background', editable_independently: true, approximate_region: 'full canvas', z_order: 0, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } },
    { id: 'shape', type: 'decoration', description: 'Decorative shape', editable_independently: true, approximate_region: 'top left', z_order: 1, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } }],
    relationships: [], ambiguities: [], recommended_layer_count: 2, decomposition_strategy: 'Split the scenery.', downstream_decomposition_prompt: 'Create 2 layers: the scenery; the decorative shape.' }) }));
  const planner = createOpenAIPlanner({ client: { responses: { create: plannerCalls } } as never });
  void SEMANTIC_SCHEMA;
  /** The image model: a smart edit returns a recolored creative; a variant (with a mask) returns new teal scenery with a drifted copy of the phone. */
  const imageEdits = vi.fn(async (request: { size: string; prompt: string; mask?: unknown }) => {
    const [width, height] = request.size.split('x').map(Number);
    if (request.prompt.includes('Variant failure test')) throw Object.assign(new Error('Fixture image failure.'), { status: 500 });
    const bytes = request.mask ? await sharp({ create: { width, height, channels: 3, background: '#2a8c8c' } }).composite([{ input: await png(Math.round(width * 0.28), Math.round(height * 0.5), '#c0a050'), left: Math.round(width * 0.4), top: Math.round(height * 0.22) }]).png().toBuffer()
      : await sharp(await creative('#f0d0d0')).resize(width, height, { fit: 'fill' }).png().toBuffer();
    return { data: [{ b64_json: bytes.toString('base64') }], usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { image_tokens: 800, text_tokens: 200, cached_tokens: 0 } } };
  });
  let sceneAnswer: unknown = phoneOfferAnalysis();
  const analyze = vi.fn(async (_image: Buffer, _mime: string, save: (file: string, value: object) => void) => { save('scene.openai-request.json', { model: 'fake-scene' }); save('scene.openai-response.json', { model: 'fake-scene', usage: { input_tokens: 1500, output_tokens: 900 } }); return parseSceneDescription(sceneAnswer); });
  let proposal: ResolverProposal | Error = emptyProposal();
  const resolve = vi.fn(async (_input: unknown, save: (file: string, value: object) => void) => { save('resolution.openai-request.json', {}); if (proposal instanceof Error) throw proposal; save('resolution.openai-response.json', {}); return proposal; });
  let verdict: ((asked: { id: string }[]) => SemanticCheck[]) | Error = asked => asked.map(a => ({ id: a.id as SemanticCheck['id'], status: 'pass' as const, message: 'Looks right.' }));
  const verify = vi.fn(async (input: { expectations: { id: string }[] }) => { if (verdict instanceof Error) throw verdict; return verdict(input.expectations); });
  let concepts = (count: number) => Array.from({ length: count }, (_, i) => ({ title: `Concept ${i + 1}`, scene: ['marble plinth under soft window light', 'neon city rooftop at dusk with glossy puddles', 'pastel paper shapes floating in a calm studio', 'desert dunes at golden hour with long shadows'][i] }));
  const write = vi.fn(async (input: { count: number }) => concepts(input.count));
  /** SAM-3, faked: a mask exactly where the phone is (or nothing, to test an unreliable cutout). */
  let maskBoxes: { x: number; y: number; w: number; h: number }[] = [PHONE];
  const segment = vi.fn(async (input: { width: number; height: number }) => {
    const mask = sharp({ create: { width: input.width, height: input.height, channels: 3, background: '#000000' } });
    return { mask: await (maskBoxes.length ? mask.composite(maskBoxes.map(b => rect(b, '#ffffff'))) : mask).png().toBuffer(), requestIds: ['sam-1'] };
  });
  const generation = () => ({ model: 'gpt-image-2', client: () => ({ images: { edit: imageEdits, generate: vi.fn() } }) as never });
  const features = () => readSmartFeatures({}, { openai: true, fal: true, cutout: 'fake', models: { analysis: 'fake-scene', resolver: 'fake-resolver', verifier: 'fake-verifier' } });
  let line: Promise<unknown> = Promise.resolve();
  const smart = createSmartCreative({ scenes, variants, executions, templates, generation, features, log: () => undefined,
    providers: { analyzer: () => ({ model: 'fake-scene', analyze }), resolver: () => ({ model: 'fake-resolver', resolve }), verifier: () => ({ model: 'fake-verifier', verify }), concepts: () => ({ model: 'fake-concepts', write }), segmenter: () => ({ provider: 'sam3', segment }) } });
  const service = createTemplateExecutions({ templates, executions, runsDir, smart, log: () => undefined, deps: () => ({ planner, transport: () => transport, sleep: async () => undefined }), generation,
    inTurn: (_id, work) => { line = line.then(work).catch(() => undefined); } });
  const source = await creative(), version = saveTemplate(templates, source);
  const upload = (bytes: Buffer = source) => ({ bytes, fileName: 'creative.png', mimeType: 'image/png' });
  const analyzed = async (bytes = source) => {
    const { analysis } = await smart.analyze({ upload: upload(bytes), templateId: version.templateId, templateVersion: version.version, idempotencyKey: randomUUID() });
    await vi.waitFor(() => expect(smart.analysis(analysis.id).state).not.toBe('analyzing'));
    return smart.analysis(analysis.id);
  };
  const generate = async (analysisId: string, resolutionId: string, draft: unknown, extra: { bytes?: Buffer; key?: string; productReference?: { bytes: Buffer } } = {}) => {
    const { execution, created } = await service.start({ mode: 'REUSE_TEMPLATE_WITH_EDIT', templateId: version.templateId, templateVersion: version.version, reviewBeforeDecompose: true, analysisId, resolutionId, draft,
      idempotencyKey: extra.key ?? randomUUID(), upload: upload(extra.bytes), ...(extra.productReference ? { productReference: { ...extra.productReference, fileName: 'photo.png', mimeType: 'image/png' } } : {}) });
    if (created) await vi.waitFor(() => expect(['generated', 'failed']).toContain(executions.get(execution.id).state));
    return { execution: executions.get(execution.id), created };
  };
  const settledSet = async (id: string): Promise<VariantSet> => { await vi.waitFor(() => expect(['ready', 'needs-cutout', 'failed']).toContain(smart.set(id).state), { timeout: 20_000 }); return smart.set(id); };
  const settled = async (id: string): Promise<TemplateExecution> => { await vi.waitFor(() => expect(['done', 'failed']).toContain(executions.get(id).state), { timeout: 20_000 }); return executions.get(id); };
  return { root, templates, executions, scenes, variants, smart, service, source, version, upload, analyzed, generate, settledSet, settled, imageEdits, analyze, resolve, verify, write, segment, decomposed, plannerCalls, fal,
    setScene: (value: unknown) => { sceneAnswer = value; }, setProposal: (value: ResolverProposal | Error) => { proposal = value; }, setVerdict: (value: typeof verdict) => { verdict = value; },
    setConcepts: (make: typeof concepts) => { concepts = make; }, setMask: (value: typeof maskBoxes) => { maskBoxes = value; } };
}
const replacePhone = { edits: { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }, corrections: {} };
const xiaomi = (): ResolverProposal => ({ ...emptyProposal(), understanding: [{ targetId: 'smartphone_1', brand: 'Xiaomi', brandSource: 'inferred', identity: 'a Xiaomi smartphone', specificity: 'brand_and_category' }] });

describe('smart edits: analysis, resolution, binding and generation (offline fakes: control flow, not image quality)', { timeout: 60_000 }, () => {
  it('analyzes once per image, template version and configuration; the same binding is reused with no call, concurrently too', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.smart.analyze({ upload: t.upload(), templateId: t.version.templateId, templateVersion: 1, idempotencyKey: randomUUID() }), t.smart.analyze({ upload: t.upload(), templateId: t.version.templateId, templateVersion: 1, idempotencyKey: randomUUID() })]);
    expect(a.analysis.id).toBe(b.analysis.id);
    const ready = await t.analyzed();
    expect(ready).toMatchObject({ id: a.analysis.id, state: 'ready', calls: 1, binding: { templateVersion: 1, config: 'scene-v1|fake-scene', imageSha256: sha(t.source) } });
    expect(ready.mapping!.slots).toEqual({ background_1: 'background', text_1: 'headline', smartphone_1: 'main_product', earbuds_1: 'supporting_product' });
    expect(t.analyze).toHaveBeenCalledTimes(1);
    expect(t.smart.lookup({ imageSha256: sha(t.source), templateId: t.version.templateId, templateVersion: 1 })?.id).toBe(ready.id);
    // Another image is analyzed on its own; a stale template version is refused before any call.
    expect(t.smart.lookup({ imageSha256: sha(await creative('#ccddee')), templateId: t.version.templateId, templateVersion: 1 })).toBeUndefined();
    expect(() => t.smart.lookup({ imageSha256: '../x', templateId: t.version.templateId, templateVersion: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    t.templates.addVersion(t.version.templateId, n => ({ ...t.version, version: n, createdAt: new Date().toISOString() }));
    await expect(t.smart.analyze({ upload: t.upload(), templateId: t.version.templateId, templateVersion: 1, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'STALE_TEMPLATE_VERSION' });
    await t.smart.analyze({ upload: t.upload(), templateId: t.version.templateId, templateVersion: 2, idempotencyKey: randomUUID() });
    await vi.waitFor(() => expect(t.analyze).toHaveBeenCalledTimes(2));
    await expect(t.smart.analyze({ upload: { bytes: Buffer.from('not an image'), fileName: 'x.png', mimeType: 'image/png' }, templateId: t.version.templateId, templateVersion: 2, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
  });

  it('an invalid analysis is a failure, never a scene; a restart shows unfinished work as interrupted', async () => {
    const t = await setup();
    t.setScene({ objects: [{ id: 'x' }] });
    const failed = await t.analyzed();
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'ANALYSIS_INVALID' } });
    expect(failed.scene).toBeUndefined();
    await expect(t.smart.resolve(failed.id, { draft: replacePhone })).rejects.toMatchObject({ code: 'ANALYSIS_NOT_READY' });
    const record = t.scenes.update(failed.id, r => { r.state = 'analyzing'; delete r.error; });
    expect(t.smart.analysis(record.id)).toMatchObject({ state: 'failed', error: { code: 'INTERRUPTED' } });
  });

  it('resolves explicitly, asks about an accessory, reuses an identical resolution, and generates exactly the persisted prompt', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const asking = (await t.smart.resolve(analysis.id, { draft: { edits: { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }, corrections: {} } })).resolution;
    expect(asking).toMatchObject({ state: 'ready', plan: { status: 'needs-input', conflicts: [{ id: 'rule:accessory:earbuds_1' }] } });
    expect(asking.prompt).toBeUndefined();
    await expect(t.generate(analysis.id, asking.id, { edits: { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }, corrections: {} })).rejects.toMatchObject({ code: 'RESOLUTION_NEEDS_INPUT' });
    const { resolution, created } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    expect(created).toBe(true);
    expect(resolution.plan!.status).toBe('clear');
    expect(resolution.plan!.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Xiaomi', source: 'inferred' });
    expect(resolution.prompt).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    expect(resolution.prompt!.endsWith(TEXT_FREE_RULE)).toBe(true);
    expect((await t.smart.resolve(analysis.id, { draft: replacePhone })).created).toBe(false);
    expect(t.resolve).toHaveBeenCalledTimes(2); // the conflict draft and the answered one; the repeat reused the saved plan
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    expect(execution).toMatchObject({ state: 'generated', resolution: { id: resolution.id, analysisId: analysis.id, inferred: 3 }, usage: { imageGenerationCalls: 1, plannerCalls: 0, analysisCalls: 1, resolutionCalls: 1, verificationCalls: 1, generationPromptSource: 'resolved-plan' },
      compatibility: { status: 'structural-change' } });
    // The preview's compiler, the persisted resolution and the request are one text.
    const scene = parseSceneDescription(phoneOfferAnalysis());
    expect(execution.edit!.prompt).toBe(resolution.prompt);
    expect(compileResolvedEdit(scene, resolution.plan!).text).toBe(resolution.prompt);
    expect((t.imageEdits.mock.calls[0][0] as { prompt: string }).prompt).toBe(resolution.prompt);
    expect(execution.edit!.review).toMatchObject({ requiresAcknowledgement: true, semantic: { status: 'passed', model: 'fake-verifier' } });
    // A double submission (the same key) is one execution and one image call.
    const again = await t.generate(analysis.id, resolution.id, replacePhone, { key: execution.idempotencyKey });
    expect(again).toMatchObject({ created: false, execution: { id: execution.id } });
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
  });

  it('decomposes an approved smart edit, and its dashboard counts analysis, resolution, generation and the AI check apart', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'simple' });
    const done = await t.settled(execution.id);
    expect(done).toMatchObject({ state: 'done', planDecision: { choice: 'simple' }, usage: { plannerCalls: 0 } });
    const d = await readRunDiagnostics(join(t.root, 'runs', done.runId!), { executions: t.executions });
    const stage = (id: string) => d.stages.find(x => x.id === id)!;
    expect(stage('reference')).toMatchObject({ label: 'Image analysis & change resolution', calls: [expect.anything(), expect.anything()] });
    expect([stage('generation').calls.length, stage('verification').calls.length, stage('planner').calls.length, stage('seedream').calls.length]).toEqual([1, 1, 0, 1]);
    expect(d.notes.join(' ')).toMatch(/analysis is shared by every smart edit/);
  });

  it('refuses a stale or tampered resolution before any image call', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const stale = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toMatchObject({ code: 'STALE_RESOLUTION', message: expect.stringMatching(pattern) });
    await stale(t.generate(analysis.id, resolution.id, { ...replacePhone, edits: { ...replacePhone.edits, smartphone_1: { action: 'replace', value: 'Pixel phone' } } }), /changes differ/);
    await stale(t.generate(analysis.id, resolution.id, replacePhone, { bytes: await creative('#c0ffee') }), /image changed/);
    // A resolution made with one product photo is not one for another photo.
    const withPhoto = { ...replacePhone, referenceFor: 'smartphone_1' }, photo = await png(300, 300, '#111111');
    const photoResolution = (await t.smart.resolve(analysis.id, { draft: withPhoto, reference: { bytes: photo, fileName: 'photo.png', mimeType: 'image/png' } })).resolution;
    await stale(t.generate(analysis.id, photoResolution.id, withPhoto, { productReference: { bytes: await png(300, 300, '#222222') } }), /product photo differs/);
    await stale(t.generate(analysis.id, photoResolution.id, replacePhone), /changes differ/);
    await stale(t.generate(analysis.id, 'nonsense', replacePhone), /does not exist/);
    // The client cannot claim a resolution: a plan edited on disk no longer compiles to its persisted prompt.
    const file = join(t.root, 'analyses', analysis.id, 'resolutions', `${resolution.id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.plan.entries[0].to = 'iPhone 16 at ₹1'; writeFileSync(file, JSON.stringify(saved));
    await stale(t.generate(analysis.id, resolution.id, replacePhone), /no longer compiles/);
    t.templates.addVersion(t.version.templateId, n => ({ ...t.version, version: n, createdAt: new Date().toISOString() }));
    await expect(t.generate(analysis.id, resolution.id, replacePhone)).rejects.toMatchObject({ code: 'STALE_TEMPLATE_VERSION' });
    expect(t.imageEdits).not.toHaveBeenCalled();
  });

  it('background-only and clothing-style edits resolve by rule with no resolver call; a resolver failure is reported, and rules-only is an explicit choice', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const background = { edits: { background_1: { action: 'modify', value: 'warm sunset gradient' } }, corrections: {} };
    const { resolution } = await t.smart.resolve(analysis.id, { draft: background });
    expect(resolution).toMatchObject({ state: 'ready', resolver: { called: false }, plan: { status: 'clear' } });
    expect(t.resolve).not.toHaveBeenCalled();
    const { execution } = await t.generate(analysis.id, resolution.id, background);
    expect(execution.usage).toMatchObject({ resolutionCalls: 0, imageGenerationCalls: 1 });
    expect(execution.compatibility!.status).toBe('compatible');
    t.setProposal(new Error('provider timeout'));
    const failed = (await t.smart.resolve(analysis.id, { draft: replacePhone })).resolution;
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'RESOLUTION_FAILED', message: expect.stringMatching(/rules only/) } });
    await expect(t.generate(analysis.id, failed.id, replacePhone)).rejects.toMatchObject({ code: 'STALE_RESOLUTION' });
    t.setProposal({ ...emptyProposal(), inferred: [{ targetId: 'ghost', operation: 'remove', property: '', to: '', reason: '', evidence: '', confidence: 1 }], understanding: [{ targetId: 'x', brand: 'b', brandSource: 'none', identity: '', specificity: 'unclear' }] } as ResolverProposal);
    const rules = (await t.smart.resolve(analysis.id, { draft: replacePhone, rulesOnly: true })).resolution;
    expect(rules).toMatchObject({ state: 'ready', resolver: { called: false }, plan: { status: 'clear', notes: expect.arrayContaining([expect.stringMatching(/rules only/)]) } });
  });

  it('an AI check that finds a contradiction blocks silent approval; a failed checker is unchecked, never a pass', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    t.setVerdict(asked => asked.map(a => ({ id: a.id as SemanticCheck['id'], status: a.id === 'no-added-text' ? 'fail' as const : 'pass' as const, message: a.id === 'no-added-text' ? 'A price sticker was added.' : 'ok' })));
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const bad = (await t.generate(analysis.id, resolution.id, replacePhone)).execution;
    expect(bad.edit!.review).toMatchObject({ requiresAcknowledgement: true, semantic: { status: 'contradiction' } });
    expect(bad.edit!.review!.checks).toContainEqual(expect.objectContaining({ id: 'semantic', severity: 'warning', message: expect.stringMatching(/price sticker/) }));
    expect(() => t.service.decompose(bad.id, { plan: 'simple' })).toThrow(expect.objectContaining({ code: 'REVIEW_REQUIRED' }));
    t.setVerdict(new Error('checker unavailable'));
    const unchecked = (await t.generate(analysis.id, resolution.id, replacePhone)).execution;
    expect(unchecked.edit!.review!.semantic).toMatchObject({ status: 'unchecked', reason: expect.stringMatching(/checker unavailable/) });
    expect(unchecked.usage.verificationCalls).toBe(1);
  });

  it('keeps legacy templates with text roles working: the classic fields still compile their exact text, the smart path stays text-free', async () => {
    const t = await setup(), analysis = await t.analyzed();
    expect(compileTemplateEdit(t.version, { headline: 'Big Sale' }).text).toContain('with exactly "Big Sale"');
    const legacy = await t.service.start({ mode: 'REUSE_TEMPLATE_WITH_EDIT', templateId: t.version.templateId, values: { headline: 'Big Sale' }, reviewBeforeDecompose: true, idempotencyKey: randomUUID(), upload: t.upload() });
    await vi.waitFor(() => expect(t.executions.get(legacy.execution.id).state).toBe('generated'));
    expect(t.executions.get(legacy.execution.id).edit!.prompt).toContain('exactly "Big Sale"');
    const { resolution } = await t.smart.resolve(analysis.id, { draft: { edits: { text_1: { action: 'remove' } }, corrections: {} } });
    expect(resolution.prompt).toContain('Remove the overlaid text block at the top completely');
    expect(resolution.prompt).not.toMatch(/iPhone|79,900|Ignore previous/);
    await expect(t.smart.resolve(analysis.id, { draft: { edits: { text_1: { action: 'modify', value: 'Mega Sale' } }, corrections: {} } })).rejects.toMatchObject({ code: 'INVALID_DRAFT' });
  });
});

describe('Generate creative template: exact subjects, new scenery, per-variant status', { timeout: 90_000 }, () => {
  const start = (t: Awaited<ReturnType<typeof setup>>, analysisId: string, extra: Record<string, unknown> = {}) => t.smart.startVariants({ analysisId, templateId: t.version.templateId, templateVersion: 1, protectedIds: ['smartphone_1'], surprise: true, count: 3, idempotencyKey: randomUUID(), ...extra });

  it('cuts the subject from the source, generates each variant once, keeps successes when one fails, and preserves the subject\'s exact pixels', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setConcepts(count => Array.from({ length: count }, (_, i) => ({ title: `C${i}`, scene: ['marble plinth under soft window light', 'Variant failure test: stage with spotlights', 'pastel paper shapes floating in a calm studio'][i] })));
    const { set: started } = await start(t, analysis.id);
    const set = await t.settledSet(started.id);
    expect(set).toMatchObject({ state: 'ready', cutout: { status: 'ready', provider: 'sam3' }, usage: { segmentationCalls: 1, conceptCalls: 1, imageGenerationCalls: 3, verificationCalls: 2 } });
    expect(set.variants.map(v => v.status)).toEqual(['done', 'failed', 'done']);
    expect(set.variants[1].error).toMatchObject({ code: 'PROVIDER_NETWORK' });
    expect(t.imageEdits).toHaveBeenCalledTimes(3); // never retried
    const sent = t.imageEdits.mock.calls[0][0] as { prompt: string; mask?: unknown; size: string };
    expect(sent.mask).toBeDefined();
    expect(sent.size).toBe('1216x1520');
    expect(sent.prompt).toContain('paint only the masked area with new artwork: marble plinth under soft window light.');
    expect(sent.prompt).toContain(TEXT_FREE_RULE);
    // The subject in the composite is the source's own pixels, measured.
    const v1 = set.variants[0];
    expect(v1.preservation).toMatchObject({ method: 'exact-source-pixels', maxDifference: 0 });
    const composite = await sharp(readFileSync(t.smart.setFilePath(set.id, v1.image!.file))).removeAlpha().raw().toBuffer(), original = await sharp(t.source).removeAlpha().raw().toBuffer();
    const p = px(PHONE); let same = 0, checked = 0;
    for (let y = p.top + 2; y < p.top + p.height - 2; y++) for (let x = p.left + 2; x < p.left + p.width - 2; x++) { const i = (y * W + x) * 3; checked++; if (composite[i] === original[i] && composite[i + 1] === original[i + 1] && composite[i + 2] === original[i + 2]) same++; }
    expect(same).toBe(checked);
    // Outside the subject the scenery is new (the lavender field is gone).
    const corner = (5 * W + 5) * 3;
    expect([composite[corner], composite[corner + 1], composite[corner + 2]]).not.toEqual([original[corner], original[corner + 1], original[corner + 2]]);
    expect(v1.layers!.subject.placement).toEqual({ x: p.left, y: p.top, width: p.width, height: p.height });
  });

  it('regenerates one variant explicitly (one more call, history kept), and a chosen variant continues to review and composed layers with no extraction', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const set = await t.settledSet((await start(t, analysis.id, { count: 2 })).set.id);
    const key = randomUUID(), before = set.variants[1].image!;
    t.smart.regenerate(set.id, 'v2', { scene: 'warm wooden table by a window, morning light', idempotencyKey: key });
    t.smart.regenerate(set.id, 'v2', { scene: 'warm wooden table by a window, morning light', idempotencyKey: key });
    const again = await t.settledSet(set.id);
    expect(t.imageEdits).toHaveBeenCalledTimes(3);
    expect(again.variants[1]).toMatchObject({ status: 'done', attempts: 2, scene: 'warm wooden table by a window, morning light', history: [{ image: before }] });
    expect(() => t.smart.regenerate(set.id, 'v1', { scene: 'a big SALE banner', idempotencyKey: randomUUID() })).toThrow(expect.objectContaining({ code: 'INVALID_SCENE' }));
    const chosen = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() });
    expect(t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution.id).toBe(chosen.execution.id);
    const e = chosen.execution;
    expect(e).toMatchObject({ state: 'generated', mode: 'REUSE_TEMPLATE_WITH_EDIT', reviewBeforeDecompose: true, variant: { setId: set.id, variantId: 'v1' }, compatibility: { status: 'structural-change' },
      usage: { imageGenerationCalls: 1, plannerCalls: 0, generationPromptSource: 'creative-variant' }, edit: { review: { method: 'creative-variant', requiresAcknowledgement: false } } });
    expect(readFileSync(t.executions.path(e.id, e.edit!.image!.file))).toEqual(readFileSync(t.smart.setFilePath(set.id, set.variants[0].image!.file)));
    expect(() => t.service.decompose(e.id, { plan: 'saved' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => t.service.decompose(e.id)).toThrow(expect.objectContaining({ code: 'PLAN_DECISION_REQUIRED' }));
    const uploads = t.decomposed.length;
    t.service.decompose(e.id, { plan: 'composed' });
    const done = await t.settled(e.id);
    expect(done).toMatchObject({ state: 'done', planDecision: { choice: 'composed' }, usage: { plannerCalls: 0 } });
    expect(t.decomposed).toHaveLength(uploads); // nothing sent to Seedream
    const run = readRun(join(t.root, 'runs', done.runId!));
    expect(run).toMatchObject({ stage: 'done', composed: { extraction: 'none', setId: set.id, variantId: 'v1' }, templateExecution: { plan: 'composed', input: { source: 'approved-generated', sha256: e.edit!.image!.sha256 } } });
    expect(run.editorLayerFiles).toEqual(['layer-1-new-scenery.png', 'layer-2-contact-shadow.png', 'layer-3-subject.png']);
    expect(run.outputLayers!.map(l => [l.name, l.placement.kind])).toEqual([['New scenery', 'full-canvas'], ['Contact shadow', 'bbox-crop'], ['Smartphone (exact source pixels)', 'bbox-crop']]);
    const p = px(PHONE), subject = await sharp(join(t.root, 'runs', run.id, 'layer-3-subject.png')).raw().toBuffer(), crop = await sharp(t.source).extract(p).ensureAlpha().raw().toBuffer();
    expect(subject.equals(crop)).toBe(true);
    // The dashboard reads it honestly: the one image call, its AI check, and no planner or Seedream call.
    const d = await readRunDiagnostics(join(t.root, 'runs', run.id), { executions: t.executions });
    const stage = (id: string) => d.stages.find(x => x.id === id)!;
    expect([stage('generation').calls.length, stage('verification').calls.length, stage('planner').calls.length, stage('seedream').calls.length]).toEqual([1, 1, 0, 0]);
    expect(stage('seedream').status).toBe('Skipped');
    expect(d.notes.join(' ')).toMatch(/composed locally from the creative variant: no planner or Seedream call/);
  });

  it('splits only the new scenery when asked, then puts the exact subject back on top', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const set = await t.settledSet((await start(t, analysis.id, { count: 1, surprise: false, direction: 'दीयों के साथ उत्सव का दृश्य' })).set.id);
    expect(set).toMatchObject({ concepts: { status: 'skipped' }, variants: [{ status: 'done', scene: 'दीयों के साथ उत्सव का दृश्य' }] });
    expect(t.write).not.toHaveBeenCalled();
    const e = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution;
    t.service.decompose(e.id, { plan: 'simple' });
    const done = await t.settled(e.id);
    expect(done.state).toBe('done');
    expect(sha(t.decomposed.at(-1)!)).toBe(e.variant!.layers.plate.sha256); // the plate, not the composite
    const run = readRun(join(t.root, 'runs', done.runId!));
    expect(run).toMatchObject({ composed: { extraction: 'scenery' }, templateExecution: { input: { source: 'variant-scenery' } } });
    expect(run.editorLayerFiles!.slice(-2)).toEqual(['layer-2-contact-shadow.png', 'layer-3-subject.png']);
    expect(t.plannerCalls).not.toHaveBeenCalled();
  });

  it('places the exact subject in the provider\'s canvas when Seedream answers at another size, and a resumed scenery run still gets it', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const set = await t.settledSet((await start(t, analysis.id, { count: 1, surprise: false, direction: 'soft studio light on a stone plinth' })).set.id);
    t.fal.baseScale = 0.5; t.fal.resultFailures = 1;
    const e = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution;
    t.service.decompose(e.id, { plan: 'simple' });
    const failed = await t.settled(e.id);
    expect(failed).toMatchObject({ state: 'failed', error: { state: 'decomposing' } });
    const uploads = t.decomposed.length;
    t.service.resume(e.id);
    const done = await t.settled(e.id);
    expect(done.state).toBe('done');
    expect(t.decomposed).toHaveLength(uploads); // resumed from the saved request: nothing re-sent
    const run = readRun(join(t.root, 'runs', done.runId!)), subject = run.outputLayers!.find(l => l.file === 'layer-3-subject.png')!;
    expect(run.canvas).toEqual({ width: W / 2, height: H / 2 });
    const p = px(PHONE);
    expect(subject.placement).toMatchObject({ kind: 'bbox-crop', x: p.left / 2, y: p.top / 2, width: p.width / 2, height: p.height / 2 });
    expect(await sharp(join(t.root, 'runs', run.id, subject.file)).metadata()).toMatchObject({ width: p.width / 2, height: p.height / 2 });
    expect(run.editorLayerFiles!.slice(-2)).toEqual(['layer-2-contact-shadow.png', 'layer-3-subject.png']);
  });

  it('a restart while cutting out leaves the set waiting for a cutout, never stuck; concurrent identical resolutions make one call', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const { set } = await start(t, analysis.id, { count: 1 });
    await t.settledSet(set.id);
    t.variants.update(set.id, s => { s.state = 'cutout'; s.cutout = { status: 'segmenting', checks: [], limitations: [] }; });
    expect(t.smart.set(set.id)).toMatchObject({ state: 'needs-cutout', cutout: { status: 'needs-cutout', error: { code: 'INTERRUPTED' } } });
    t.setProposal(xiaomi());
    const [a, b] = await Promise.all([t.smart.resolve(analysis.id, { draft: replacePhone }), t.smart.resolve(analysis.id, { draft: replacePhone })]);
    expect(a.resolution.id).toBe(b.resolution.id);
    expect(t.resolve).toHaveBeenCalledTimes(1);
  });

  it('stops for a usable cutout instead of redrawing the subject, and accepts only the source\'s own pixels', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setMask([]);
    const set = await t.settledSet((await start(t, analysis.id)).set.id);
    expect(set).toMatchObject({ state: 'needs-cutout', cutout: { status: 'needs-cutout', error: { code: 'CUTOUT_UNRELIABLE' } } });
    expect(t.imageEdits).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
    const alpha = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } }).composite([rect(PHONE, '#ffffff')]).extractChannel(0).raw().toBuffer();
    const cutout = await sharp(await sharp(t.source).removeAlpha().raw().toBuffer(), { raw: { width: W, height: H, channels: 3 } }).joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
    const retouched = await sharp(cutout).modulate({ brightness: 1.3 }).png().toBuffer();
    await expect(t.smart.uploadCutout(set.id, retouched)).rejects.toMatchObject({ code: 'CUTOUT_REJECTED', message: expect.stringMatching(/differ from the reference/) });
    await expect(t.smart.uploadCutout(set.id, await sharp(cutout).resize(400, 500).png().toBuffer())).rejects.toMatchObject({ code: 'CUTOUT_REJECTED' });
    await t.smart.uploadCutout(set.id, cutout);
    const ready = await t.settledSet(set.id);
    expect(ready).toMatchObject({ state: 'ready', cutout: { status: 'ready', provider: 'user' } });
    expect(ready.variants.every(v => v.status === 'done' && v.preservation?.maxDifference === 0)).toBe(true);
  });

  it('flags overlaid text in the cutout as a limitation the reviewer must accept, rejects text-seeking concepts without a call, and needs confirmed subjects', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setMask([PHONE, { x: 0.36, y: 0.06, w: 0.28, h: 0.14 }]); // the mask also takes part of the headline bar above the phone
    t.setConcepts(count => Array.from({ length: count }, (_, i) => ({ title: `C${i}`, scene: i === 0 ? 'a shop window with a big SALE sign' : 'calm studio with soft light' })));
    const set = await t.settledSet((await start(t, analysis.id, { count: 2 })).set.id);
    expect(set.cutout.limitations.join(' ')).toMatch(/Overlaid text .* overlaps the protected subject/);
    expect(set.variants[0]).toMatchObject({ status: 'failed', attempts: 0, error: { code: 'CONCEPT_REJECTED' } });
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
    const e = t.smart.selectVariant(set.id, 'v2', { idempotencyKey: randomUUID() }).execution;
    expect(e.edit!.review).toMatchObject({ requiresAcknowledgement: true, checks: expect.arrayContaining([expect.objectContaining({ id: 'cutout-limitation', severity: 'warning' })]) });
    await expect(start(t, analysis.id, { protectedIds: [] })).rejects.toMatchObject({ code: 'PROTECTED_REQUIRED' });
    await expect(start(t, analysis.id, { protectedIds: ['background_1'] })).rejects.toMatchObject({ code: 'PROTECTED_REQUIRED' });
    await expect(start(t, analysis.id, { direction: 'gold text saying Diwali Offer', surprise: false })).rejects.toMatchObject({ code: 'INVALID_DIRECTION' });
    await expect(start(t, analysis.id, { count: 9 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const key = randomUUID(), first = await start(t, analysis.id, { idempotencyKey: key, count: 1 }), second = await start(t, analysis.id, { idempotencyKey: key, count: 1 });
    expect(second).toMatchObject({ created: false, set: { id: first.set.id } });
    await expect(start(t, analysis.id, { idempotencyKey: key, count: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
