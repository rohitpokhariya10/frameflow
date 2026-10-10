import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { compileResolvedEdit, compileTemplateEdit, editCanvasSize, describeTemplateSlots, draftFromTemplateFields, parseSceneDescription, PLAN_RULES, TEXT_FREE_RULE, type ResolverProposal, type SemanticCheck, type TemplateExecution, type TemplateStructure, type TemplateVersion, type VariantSet } from '@frameflow/shared';
import type { FalTransport } from '../providers/falClient.js';
import { readRun } from '../layerizeExperiment.js';
import { ProviderError } from '../providers/adapters.js';
import { createOpenAIPlanner } from '../layerizePlanner.js';
import { templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './compile.js';
import { fileExecutionStore } from './executions.js';
import { createTemplateExecutions } from './service.js';
import { fileTemplateStore } from './store.js';
import { createSmartCreative, readSmartFeatures } from './smartCreative.js';
import { regionAlpha } from './smartEditImage.js';
import { fileSceneStore, fileVariantStore } from './smartStores.js';
import { holdingBallAnalysis, phoneOfferAnalysis } from './scene.fixture.js';
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
/** A proposal as the resolver model writes it (snake_case, as parseResolverProposal reads it). */
const rawProposal = (p: ResolverProposal) => ({
  understanding: p.understanding.map(u => ({ target_id: u.targetId, brand: u.brand, brand_source: u.brandSource, identity: u.identity, specificity: u.specificity })),
  inferred_changes: p.inferred.map(i => ({ target_id: i.targetId, operation: i.operation, property: i.property, to: i.to, reason: i.reason, evidence: i.evidence, confidence: i.confidence })),
  conflicts: p.conflicts.map(c => ({ kind: c.kind, target_ids: c.targetIds, question: c.question, options: c.options.map(o => ({ label: o.label, target_id: o.targetId, action: o.action, value: o.value, brand: o.brand })) })),
  product_photo: { present: p.productPhoto.present, category: p.productPhoto.category, brand: p.productPhoto.brand, evidence: p.productPhoto.evidence, matches_request: p.productPhoto.matchesRequest, description: p.productPhoto.description },
});
const emptyProposal = (): ResolverProposal => ({ understanding: [], inferred: [], conflicts: [], productPhoto: { present: false, category: '', brand: '', evidence: '', matchesRequest: 'unclear', description: '' } });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'smart-creative-'));
  const templates = fileTemplateStore(join(root, 'templates')), executions = fileExecutionStore(join(root, 'executions')), runsDir = join(root, 'runs');
  const scenes = fileSceneStore(join(root, 'analyses')), variants = fileVariantStore(join(root, 'variants'));
  // Seedream: every image comes back as its base plus one named layer (enough for a finished run).
  const decomposed: Buffer[] = [], files = new Map<string, Buffer>(), fal = { resultFailures: 0, baseScale: 1, partnerRejections: 0, qwenFailures: 0 }, submitted: string[] = [];
  const transport: FalTransport = {
    upload: async image => { decomposed.push(image as Buffer); return `https://v3b.fal.media/files/t/in-${decomposed.length}.png`; },
    submit: async endpoint => { submitted.push(endpoint); return { requestId: `r${decomposed.length}` }; }, status: async () => 'COMPLETED',
    result: async (endpoint, id) => {
      if (endpoint === 'fal-ai/qwen-image-layered') {
        if (fal.qwenFailures > 0) { fal.qwenFailures--; throw Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, billableUnits: '0', requestId: `req-${id}`, messages: [{ msg: 'Qwen could not process the image.', type: 'invalid_request' }] } }); }
        // Qwen-Image-Layered, faked as it answers: the upload stretched to its working size (about 640², sides of 32), an
        // opaque scene plate without the phone, and the phone as its own transparent layer.
        const input = decomposed[Number(id.slice(1)) - 1], meta = await sharp(input).metadata(), r = meta.width! / meta.height!, qw = Math.sqrt(640 * 640 * r);
        const at = { width: Math.round(qw / 32) * 32, height: Math.round(qw / r / 32) * 32 }, phone = px(PHONE);
        const plate = await sharp(input).composite([{ input: { create: { width: phone.width, height: phone.height, channels: 3, background: '#dcd0f0' } }, left: phone.left, top: phone.top }]).png().toBuffer();
        const cut = await sharp(input).ensureAlpha().composite([{ input: await sharp({ create: { width: meta.width!, height: meta.height!, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite([{ input: { create: { width: phone.width, height: phone.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }, left: phone.left, top: phone.top }]).png().toBuffer(), blend: 'dest-in' }]).png().toBuffer();
        files.set(`qwen-${id}-0`, await sharp(plate).resize(at.width, at.height, { fit: 'fill' }).png().toBuffer());
        files.set(`qwen-${id}-1`, await sharp(cut).resize(at.width, at.height, { fit: 'fill' }).png().toBuffer());
        return { images: [0, 1].map(k => ({ url: `https://v3b.fal.media/files/t/qwen-${id}-${k}.png`, width: at.width, height: at.height, content_type: 'image/png' })), seed: 1, has_nsfw_concepts: [false, false] };
      }
      if (fal.resultFailures > 0) { fal.resultFailures--; throw new Error('fal result temporarily unavailable'); }
      // fal's partner check refusing the image, exactly as live (422, body.image, partner_validation_failed, billed 0).
      if (fal.partnerRejections > 0) { fal.partnerRejections--; throw Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, billableUnits: '0', requestId: `req-${id}`,
        messages: [{ msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation', loc: 'body.image', reason: 'partner_validation_failed' }] } }); }
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
  // The response is saved as a real call saves it: the model's answer as output_text (a resolution can be rebuilt from it).
  const resolve = vi.fn(async (_input: unknown, save: (file: string, value: object) => void) => { save('resolution.openai-request.json', {}); if (proposal instanceof Error) throw proposal; save('resolution.openai-response.json', { output_text: JSON.stringify(rawProposal(proposal)) }); return proposal; });
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
  // Text-to-image (an integrated set whose every product was renamed has no reference to send).
  const imageGenerations = vi.fn(async (request: { size: string }) => { const [width, height] = request.size.split('x').map(Number); return { data: [{ b64_json: (await sharp(await creative('#d0e0f0')).resize(width, height, { fit: 'fill' }).png().toBuffer()).toString('base64') }] }; });
  const generation = () => ({ model: 'gpt-image-2', client: () => ({ images: { edit: imageEdits, generate: imageGenerations } }) as never });
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
    if (created) await vi.waitFor(() => expect(['generated', 'failed']).toContain(executions.get(execution.id).state), { timeout: 20_000 });
    return { execution: executions.get(execution.id), created };
  };
  const settledSet = async (id: string): Promise<VariantSet> => { await vi.waitFor(() => expect(['ready', 'needs-cutout', 'failed']).toContain(smart.set(id).state), { timeout: 20_000 }); return smart.set(id); };
  const settled = async (id: string): Promise<TemplateExecution> => { await vi.waitFor(() => expect(['done', 'failed']).toContain(executions.get(id).state), { timeout: 20_000 }); return executions.get(id); };
  return { root, templates, executions, scenes, variants, smart, service, source, version, upload, analyzed, generate, settledSet, settled, imageEdits, imageGenerations, analyze, resolve, verify, write, segment, decomposed, submitted, plannerCalls, fal,
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

  it('resolves explicitly, decides the accessory itself (no question), reuses an identical resolution, and generates exactly the persisted prompt', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    // The accessory of a phone that changes brand goes with it: decided automatically and recorded, never asked.
    const decided = (await t.smart.resolve(analysis.id, { draft: { edits: { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }, corrections: {} } })).resolution;
    expect(decided).toMatchObject({ state: 'ready', plan: { status: 'clear', conflicts: [] }, auto: { intent: 'replace', decisions: [{ id: 'rule:accessory:earbuds_1', choice: 'Remove Earbuds' }] } });
    expect(decided.plan!.entries.find(e => e.targetId === 'earbuds_1' && e.operation === 'remove')).toMatchObject({ source: 'inferred' });
    expect(decided.prompt).toContain('Remove the earbuds');
    const { resolution, created } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    expect(created).toBe(true);
    expect(resolution.plan!.status).toBe('clear');
    expect(resolution.plan!.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Xiaomi', source: 'inferred' });
    expect(resolution.prompt).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    // B3: the text-free rule is kept, with the one exception that sentence asks for (it once forbade the brand it asked for).
    expect(resolution.prompt).toContain(`${TEXT_FREE_RULE} The only exception is the Xiaomi brand marking on the new smartphone`);
    expect(resolution.rules).toBe(PLAN_RULES);
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

  it('a variant set saved by the previous version (no ratio, concepts or per-product layers) still opens, and its chosen variant still reaches the editor as its own exact layers', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const set = await t.settledSet((await start(t, analysis.id, { protectedIds: ['smartphone_1'], count: 1, surprise: false, direction: 'a plain studio' })).set.id);
    // Rewritten with exactly the fields the previous version saved (e8ac236), nothing newer.
    const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
    const file = join(t.root, 'variants', set.id, 'set.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    const old = { ...pick(saved, ['id', 'createdAt', 'updatedAt', 'idempotencyKey', 'template', 'analysisId', 'source', 'protectedIds', 'protectedLabels', 'direction', 'surprise', 'count', 'state', 'concepts', 'usage', 'verify', 'corrections', 'signature', 'error']),
      cutout: pick(saved.cutout, ['status', 'provider', 'mask', 'subject', 'box', 'coveragePercent', 'checks', 'limitations', 'error', 'requestIds']),
      variants: saved.variants.map((v: Record<string, never>) => ({ ...pick(v, ['id', 'title', 'scene', 'prompt', 'status', 'attempts', 'model', 'size', 'requestFile', 'responseFile', 'durationMs', 'startedAt', 'finishedAt', 'image', 'verification', 'error', 'history', 'executionId']),
        ...(v.layers ? { layers: pick(v.layers, ['scenery', 'plate', 'shadow', 'subject']) } : {}), ...(v.preservation ? { preservation: pick(v.preservation, ['method', 'checkedPixels', 'maxDifference']) } : {}) })) };
    expect(old.variants[0]).not.toHaveProperty('concept');
    writeFileSync(file, JSON.stringify(old, null, 2));
    expect(t.smart.set(set.id)).toMatchObject({ state: 'ready', variants: [{ status: 'done' }] });
    const chosen = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution;
    t.service.decompose(chosen.id, { plan: 'composed' });
    const done = await t.settled(chosen.id);
    expect(done).toMatchObject({ state: 'done', usage: { plannerCalls: 0 } });
    const run = readRun(join(t.root, 'runs', done.runId!));
    expect(run.outputLayers!.map(l => l.placement.kind)).toEqual(['full-canvas', 'bbox-crop', 'bbox-crop']);
    const p = px(PHONE), subject = await sharp(join(t.root, 'runs', run.id, run.editorLayerFiles!.at(-1)!)).raw().toBuffer(), crop = await sharp(t.source).extract(p).ensureAlpha().raw().toBuffer();
    expect(subject.equals(crop)).toBe(true);
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
    // Nothing named: the advertised products are chosen automatically (the phone, and its earbuds shown as a set with it).
    const automatic = await start(t, analysis.id, { protectedIds: [] });
    expect([...automatic.set.protectedIds].sort()).toEqual(['earbuds_1', 'smartphone_1']);
    expect(automatic.set.selection).toMatchObject({ basis: 'rules', reasons: { smartphone_1: 'what the creative is about', earbuds_1: 'an accessory of Smartphone' } });
    await expect(start(t, analysis.id, { protectedIds: ['background_1'] })).rejects.toMatchObject({ code: 'PROTECTED_REQUIRED' });
    await expect(start(t, analysis.id, { direction: 'gold text saying Diwali Offer', surprise: false })).rejects.toMatchObject({ code: 'INVALID_DIRECTION' });
    await expect(start(t, analysis.id, { count: 9 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const key = randomUUID(), first = await start(t, analysis.id, { idempotencyKey: key, count: 1 }), second = await start(t, analysis.id, { idempotencyKey: key, count: 1 });
    expect(second).toMatchObject({ created: false, set: { id: first.set.id } });
    await expect(start(t, analysis.id, { idempotencyKey: key, count: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('Generate creative template: each product its own, and scene ideas written again without a new mask', { timeout: 90_000 }, () => {
  const start = (t: Awaited<ReturnType<typeof setup>>, analysisId: string, extra: Record<string, unknown> = {}) => t.smart.startVariants({ analysisId, templateId: t.version.templateId, templateVersion: 1, protectedIds: ['smartphone_1'], surprise: true, count: 3, idempotencyKey: randomUUID(), ...extra });
  const exactCrop = async (t: Awaited<ReturnType<typeof setup>>, runId: string, file: string, box: { x: number; y: number; w: number; h: number }) => {
    const layer = await sharp(join(t.root, 'runs', runId, file)).ensureAlpha().raw().toBuffer(), crop = await sharp(t.source).extract(px(box)).ensureAlpha().raw().toBuffer();
    return layer.equals(crop);
  };

  it('two products: each its own exact layer and its own shadow, through review to the editor run', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setMask([PHONE, BUDS]);
    const set = await t.settledSet((await start(t, analysis.id, { protectedIds: ['smartphone_1', 'earbuds_1'], count: 1, surprise: false, direction: 'soft studio light on a stone plinth' })).set.id);
    expect(set.cutout.masks!.map(m => [m.subjectId, m.file])).toEqual([['smartphone_1', 'mask-1.png'], ['earbuds_1', 'mask-2.png']]);
    const v = set.variants[0];
    expect(v).toMatchObject({ status: 'done', preservation: { method: 'exact-source-pixels', maxDifference: 0, outsideAlphaPixels: 0 } });
    // Back to front by where they stand: the phone stands higher in the frame than the earbuds, so it is behind them.
    expect(v.layers!.subjects!.map(l => [l.subjectId, l.label])).toEqual([['smartphone_1', 'Smartphone'], ['earbuds_1', 'Earbuds']]);
    expect(v.layers!.shadows!.map(l => l.subjectId)).toEqual(['smartphone_1', 'earbuds_1']);
    const e = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution;
    expect(e.variant!.layers.subjects).toHaveLength(2);
    expect(e.edit!.review!.note).toMatch(/products are the reference's own pixels .* soft edge pixels blended as expected, none outside the cutout/);
    t.service.decompose(e.id, { plan: 'composed' });
    const done = await t.settled(e.id), run = readRun(join(t.root, 'runs', done.runId!));
    expect(run.editorLayerFiles).toEqual(['layer-1-new-scenery.png', 'layer-2-shadow-1.png', 'layer-2-shadow-2.png', 'layer-3-subject-1.png', 'layer-3-subject-2.png']);
    expect(run.outputLayers!.map(l => l.name)).toEqual(['New scenery', 'Contact shadow · Smartphone', 'Contact shadow · Earbuds', 'Smartphone (exact source pixels)', 'Earbuds (exact source pixels)']);
    expect(await exactCrop(t, run.id, 'layer-3-subject-1.png', PHONE)).toBe(true);
    expect(await exactCrop(t, run.id, 'layer-3-subject-2.png', BUDS)).toBe(true);
  });

  it('a person holding the product: the product in front of the hand, and no floor shadow for a held product or a figure the frame cuts off', async () => {
    const t = await setup();
    t.setScene(holdingBallAnalysis());
    const analysis = await t.analyzed();
    t.setMask([{ x: 0.25, y: 0.1, w: 0.5, h: 0.9 }, { x: 0.55, y: 0.45, w: 0.16, h: 0.14 }]);
    const set = await t.settledSet((await start(t, analysis.id, { protectedIds: ['football_1'], count: 1, surprise: false, direction: 'sunny beach at noon' })).set.id);
    expect([...set.protectedIds].sort()).toEqual(['football_1', 'man_1']);
    expect(set.variants[0].status).toBe('done');
    expect(set.variants[0].layers!.subjects!.map(l => l.subjectId)).toEqual(['man_1', 'football_1']);
    expect(set.variants[0].layers!.shadows).toEqual([]);
  });

  it('scene ideas that failed or came back short are written again on request: one more concept call each, never a new mask request', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setConcepts(() => { throw new Error('Fixture concept failure.'); });
    const set = await t.settledSet((await start(t, analysis.id, { count: 2 })).set.id);
    expect(set).toMatchObject({ state: 'failed', cutout: { status: 'ready' }, usage: { segmentationCalls: 1, conceptCalls: 1, imageGenerationCalls: 0 } });
    expect(set.variants.map(v => [v.status, v.error?.code])).toEqual([['failed', 'CONCEPTS_FAILED'], ['failed', 'CONCEPTS_FAILED']]);
    // A short answer: one concept for the two variants without one. A repeated click with the same key starts nothing more.
    t.setConcepts(() => [{ title: 'Marble', scene: 'marble plinth under soft window light' }]);
    const key = randomUUID();
    t.smart.rewriteConcepts(set.id, { idempotencyKey: key });
    t.smart.rewriteConcepts(set.id, { idempotencyKey: key });
    const partly = await t.settledSet(set.id);
    expect(partly.usage).toMatchObject({ segmentationCalls: 1, conceptCalls: 2, imageGenerationCalls: 1 });
    expect(partly.variants.map(v => [v.status, v.error?.code ?? null])).toEqual([['done', null], ['failed', 'CONCEPT_MISSING']]);
    t.setConcepts(() => [{ title: 'Rooftop', scene: 'neon city rooftop at dusk with glossy puddles' }]);
    t.smart.rewriteConcepts(set.id, { idempotencyKey: randomUUID() });
    const done = await t.settledSet(set.id);
    // One variant still needed: two more concepts than that are asked for, so the most different one can be chosen.
    expect(t.write).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }), expect.anything());
    expect(done).toMatchObject({ state: 'ready', usage: { segmentationCalls: 1, conceptCalls: 3, imageGenerationCalls: 2 } });
    expect(done.variants.map(v => [v.status, v.title])).toEqual([['done', 'Marble'], ['done', 'Rooftop']]);
    expect(t.segment).toHaveBeenCalledTimes(1);
    expect(() => t.smart.rewriteConcepts(set.id, { idempotencyKey: randomUUID() })).toThrow(expect.objectContaining({ code: 'NOT_NEEDED' }));
  });

  it('one click: the advertised products found automatically, a 4:5 canvas, the most different concepts, each product exact on its own layer, through review to the editor', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setMask([PHONE, BUDS]);
    const concept = (title: string, family: string, environment: string, surface: string, palette: string[], composition: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ title, family, theme: `${title} theme`, environment, surface, props: [], palette, lighting: 'soft window light', mood: 'calm', camera: 'eye-level', composition, ...extra });
    const written = [
      concept('Studio pedestal', 'studio', 'a seamless grey studio sweep', 'a matte grey cylinder pedestal', ['grey', 'white'], { x: 0.5, y: 0.6, scale: 0.6, copy_space: 'top' }),
      concept('Studio pedestal in blue', 'studio', 'a seamless grey studio sweep', 'a matte grey cylinder pedestal', ['blue', 'white'], { x: 0.5, y: 0.6, scale: 0.6, copy_space: 'top' }),
      concept('Forest stream', 'nature', 'mossy stones beside a clear forest stream', 'a flat wet river stone', ['moss green', 'slate'], { x: 0.4, y: 0.65, scale: 0.55, copy_space: 'right' }, { camera: 'low-angle', props: ['ferns'] }),
      concept('Festive table', 'festive', 'a festive dinner table with brass diyas and marigolds', 'a carved wooden tray', ['saffron', 'maroon', 'gold'], { x: 0.55, y: 0.55, scale: 0.5, copy_space: 'bottom' }, { camera: 'high-angle', props: ['marigolds'] }),
      concept('Rooftop dusk', 'architectural', 'a concrete rooftop at dusk with city lights far below', 'a polished concrete ledge', ['indigo', 'amber'], { x: 0.6, y: 0.62, scale: 0.65, copy_space: 'left' }),
    ];
    t.setConcepts(() => written as never);
    const { set: started } = await start(t, analysis.id, { protectedIds: undefined, surprise: undefined, count: 3, aspectRatio: '4:5' });
    expect(started).toMatchObject({ aspectRatio: '4:5', selection: { basis: 'rules' } });
    const set = await t.settledSet(started.id);
    expect(set).toMatchObject({ state: 'ready', usage: { segmentationCalls: 2, conceptCalls: 1, imageGenerationCalls: 3 } });
    // Two more concepts than needed were asked for, with what a creative director needs about the products.
    expect(t.write).toHaveBeenLastCalledWith(expect.objectContaining({ count: 5, ratio: '4:5', subjects: ['earbuds', 'smartphone'], brands: ['Apple'] }), expect.anything());
    // The recolour of the studio set is never one of the creatives; the three chosen are of different families.
    expect(set.variants.map(v => v.title)).not.toContain('Studio pedestal in blue');
    expect(new Set(set.variants.map(v => v.concept!.family)).size).toBe(3);
    expect(set.conceptReport).toMatchObject({ candidates: 5, chosen: 3, rejected: expect.arrayContaining([{ title: 'Studio pedestal in blue', reason: expect.stringMatching(/^too close/) }]) });
    expect(set.conceptReport!.minDistance).toBeGreaterThanOrEqual(1.2);
    // Each creative on the 4:5 canvas, its products where its own concept put them: three different layouts.
    for (const v of set.variants) {
      expect(v).toMatchObject({ status: 'done', image: { width: 1216, height: 1520 }, preservation: { method: 'exact-source-pixels', maxDifference: 0, outsideAlphaPixels: 0, scale: 1 }, layout: { scale: 1 } });
      expect(v.prompt).toMatch(/products already placed in the attached image/);
      expect(v.layers!.subjects!.map(l => l.subjectId)).toEqual(['smartphone_1', 'earbuds_1']);
    }
    expect(new Set(set.variants.map(v => `${v.layout!.box.x},${v.layout!.box.y}`)).size).toBe(3);
    expect(t.imageEdits.mock.calls.every(([request]) => (request as { size: string }).size === '1216x1520')).toBe(true);
    // Through the normal review to the editor: a flattened generated scene, a shadow per product, each product exact.
    const e = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() }).execution;
    expect(e.variant).toMatchObject({ aspectRatio: '4:5', scale: 1 });
    t.service.decompose(e.id, { plan: 'composed' });
    const done = await t.settled(e.id), run = readRun(join(t.root, 'runs', done.runId!));
    expect(run.canvas).toEqual({ width: 1216, height: 1520 });
    expect(run.outputLayers!.map(l => l.name)).toEqual(['Generated scene (flattened)', 'Contact shadow · Smartphone', 'Contact shadow · Earbuds', 'Smartphone (exact source pixels)', 'Earbuds (exact source pixels)']);
    const layer = await sharp(join(t.root, 'runs', run.id, 'layer-3-subject-1.png')).ensureAlpha().raw().toBuffer(), crop = await sharp(t.source).extract(px(PHONE)).ensureAlpha().raw().toBuffer();
    expect(layer.equals(crop)).toBe(true);
  });

});

describe('smart edits made by their strategy: local regions, a restyle around the kept products, never an unneeded call (Step 4)', { timeout: 60_000 }, () => {
  const raw = async (bytes: Buffer, width = W, height = H) => sharp(bytes).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();

  it('a replaced phone is painted only in its own regions: the result is the source\'s size, and outside them the source\'s own pixels although the model painted everything', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    // Feature 2 edits on the creative's own-ratio canvas (nothing padded, nothing cropped on the way back).
    expect(execution.edit).toMatchObject({ strategy: { kind: 'local' }, image: { width: W, height: H }, generated: editCanvasSize(W, H), preservation: { method: 'outside-regions', maxDifferenceOutside: 0 } });
    expect(execution.edit!.strategy!.regions.map(r => r.targetId).sort()).toEqual(['mark_2', 'smartphone_1', 'text_1']);
    expect(t.imageEdits.mock.calls[0][0]).toMatchObject({ size: `${editCanvasSize(W, H).width}x${editCanvasSize(W, H).height}`, mask: expect.anything() });
    const [out, src] = await Promise.all([raw(readFileSync(t.executions.path(execution.id, execution.edit!.image!.file))), raw(t.source)]);
    // Outside: every pixel the regions (and their soft inner edge) do not reach, exactly as the composite defines them.
    const alpha = regionAlpha(execution.edit!.strategy!.regions.map(r => r.box), W, H, Math.round(0.015 * W));
    let outside = 0, differing = 0;
    for (let i = 0; i < W * H; i++) if (alpha[i] === 0) { outside++; if ([0, 1, 2].some(c => out[i * 3 + c] !== src[i * 3 + c])) differing++; }
    expect(outside).toBe(execution.edit!.preservation!.unchangedPixels);
    expect(differing).toBe(0);
    expect(outside).toBeGreaterThan(W * H * 0.5);
    // The review reads the changes where the analysis found them.
    expect(execution.edit!.review!.method).toBe('analysis-boxes');
  });

  it('a restyled background cuts out the products it keeps (one mask request each) and keeps them exact; an unreliable cutout edits the whole image and asks for a look', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setMask([PHONE, BUDS]);
    const restyle = { edits: { background_1: { action: 'modify', value: 'warm sunset gradient' } }, corrections: {} };
    const { resolution } = await t.smart.resolve(analysis.id, { draft: restyle });
    const { execution } = await t.generate(analysis.id, resolution.id, restyle);
    expect(execution.edit).toMatchObject({ strategy: { kind: 'background', protectIds: ['earbuds_1', 'smartphone_1'] }, image: { width: W, height: H }, preservation: { method: 'protected-products', maxDifferenceOutside: 0, products: { ok: true, maxDifference: 0, outsideAlphaPixels: 0 } } });
    expect(execution.usage).toMatchObject({ segmentationCalls: 2, imageGenerationCalls: 1 });
    expect(t.segment).toHaveBeenCalledTimes(1);
    const phone = px(PHONE), [out, src] = await Promise.all([raw(readFileSync(t.executions.path(execution.id, execution.edit!.image!.file))), raw(t.source)]);
    let differing = 0;
    for (let y = phone.top + 4; y < phone.top + phone.height - 4; y++) for (let x = phone.left + 4; x < phone.left + phone.width - 4; x++) { const i = y * W + x; if ([0, 1, 2].some(c => out[i * 3 + c] !== src[i * 3 + c])) differing++; }
    expect(differing).toBe(0);
    // No reliable cutout: the whole image is edited, said plainly, and a person must look before decomposition.
    const u = await setup(), a2 = await u.analyzed();
    u.setMask([]);
    const r2 = (await u.smart.resolve(a2.id, { draft: restyle })).resolution, e2 = (await u.generate(a2.id, r2.id, restyle)).execution;
    expect(e2.edit).toMatchObject({ strategy: { kind: 'global', fallback: expect.stringMatching(/products may have been redrawn/) }, image: { width: W, height: H } });
    expect(e2.edit!.review).toMatchObject({ requiresAcknowledgement: true, checks: expect.arrayContaining([expect.objectContaining({ id: 'cutout-limitation', severity: 'warning' })]) });
  });

  it('all fields empty: the original image is reviewed with no image request; "regenerate anyway" is one explicit request at the source size', async () => {
    const t = await setup(), analysis = await t.analyzed(), empty = { edits: {}, corrections: {} };
    const { resolution } = await t.smart.resolve(analysis.id, { draft: empty });
    expect(resolution.plan!.status).toBe('unchanged');
    const { execution } = await t.generate(analysis.id, resolution.id, empty);
    expect(execution).toMatchObject({ state: 'generated', edit: { original: true, strategy: { kind: 'none' }, image: { sha256: sha(t.source), width: W, height: H } }, usage: { imageGenerationCalls: 0 } });
    expect(t.imageEdits).not.toHaveBeenCalled();
    t.service.decompose(execution.id);
    expect(await t.settled(execution.id)).toMatchObject({ state: 'done', usage: { imageGenerationCalls: 0 } });
    const again = await t.service.start({ mode: 'REUSE_TEMPLATE_WITH_EDIT', templateId: t.version.templateId, templateVersion: t.version.version, reviewBeforeDecompose: true, analysisId: analysis.id, resolutionId: resolution.id, draft: empty,
      regenerateUnchanged: true, idempotencyKey: randomUUID(), upload: t.upload() });
    await vi.waitFor(() => expect(t.executions.get(again.execution.id).state).toBe('generated'), { timeout: 20_000 });
    expect(t.executions.get(again.execution.id).edit).toMatchObject({ regenerate: true, strategy: { kind: 'global' }, image: { width: W, height: H } });
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
  });

  it('the normal Generate\'s template fields go through the same engine: a filled product field is a local edit of its own item, at the source size', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const scene = parseSceneDescription(phoneOfferAnalysis()), slots = describeTemplateSlots(t.version);
    // The fields as the wizard sends them: the product changed, the supporting product kept, everything else empty.
    const { draft, problems } = draftFromTemplateFields(scene, analysis.mapping, slots, { values: { main_product: 'Xiaomi phone' }, mainProduct: { keepSupporting: true } });
    expect(problems).toEqual([]);
    expect(draft.edits).toEqual({ smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } });
    const { resolution } = await t.smart.resolve(analysis.id, { draft });
    expect(resolution.plan).toMatchObject({ status: 'clear' });
    const { execution } = await t.generate(analysis.id, resolution.id, draft);
    expect(execution.edit).toMatchObject({ strategy: { kind: 'local' }, image: { width: W, height: H }, preservation: { method: 'outside-regions', maxDifferenceOutside: 0 } });
    expect(execution.edit!.prompt).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
  });

  it('template fields without an image analysis: a replaced product with text fields left as they are waits for the user\'s decision; decided, it is generated at the source size', async () => {
    const t = await setup();
    await expect(t.service.start({ mode: 'REUSE_TEMPLATE_WITH_EDIT', templateId: t.version.templateId, templateVersion: t.version.version, reviewBeforeDecompose: true, values: { main_product: 'portable speaker' }, idempotencyKey: randomUUID(), upload: t.upload() }))
      .rejects.toMatchObject({ code: 'DECISION_REQUIRED', details: { questions: [expect.objectContaining({ slotId: 'headline' })] } });
    expect(t.imageEdits).not.toHaveBeenCalled();
    const { execution } = await t.service.start({ mode: 'REUSE_TEMPLATE_WITH_EDIT', templateId: t.version.templateId, templateVersion: t.version.version, reviewBeforeDecompose: true, values: { main_product: 'portable speaker' },
      options: { textDecisions: { headline: 'remove' } }, idempotencyKey: randomUUID(), upload: t.upload() });
    await vi.waitFor(() => expect(t.executions.get(execution.id).state).toBe('generated'), { timeout: 20_000 });
    const done = t.executions.get(execution.id);
    expect(done.edit!.prompt).toContain('Remove the headline text at the top completely');
    expect(done.edit!.prompt).toContain('Show no brand name or logo on it');
    expect(done.edit).toMatchObject({ strategy: { kind: 'global' }, image: { width: W, height: H } });
  });

  it('a resolution saved before these rules is rebuilt from its own saved resolver answer, with no new call, and then generates', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const first = (await t.smart.resolve(analysis.id, { draft: replacePhone })).resolution;
    expect(t.resolve).toHaveBeenCalledTimes(1);
    // As saved by the earlier compiler: no rules version, and the prompt that contradicted itself about the brand.
    const old = t.scenes.updateResolution(analysis.id, first.id, r => { delete r.rules; r.prompt = r.prompt!.replace(/ The only exception is [^.]+, as described above\./, ''); });
    await expect(t.generate(analysis.id, old.id, replacePhone)).rejects.toMatchObject({ code: 'STALE_RESOLUTION' });
    const { resolution, created } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    expect(created).toBe(true);
    expect(resolution).toMatchObject({ rules: PLAN_RULES, resolver: { called: true, reusedFrom: old.id } });
    expect(resolution.id).not.toBe(old.id);
    expect(resolution.prompt).toContain('The only exception is the Xiaomi brand marking');
    expect(t.resolve).toHaveBeenCalledTimes(1); // the saved answer was merged again
    expect((await t.smart.resolve(analysis.id, { draft: replacePhone })).resolution.id).toBe(resolution.id);
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    expect(execution).toMatchObject({ state: 'generated', usage: { resolutionCalls: 1 } });
  });
});

describe('Generate creative template, integrated: products rendered into different creatives (offline fakes)', { timeout: 90_000 }, () => {
  const start = (t: Awaited<ReturnType<typeof setup>>, analysisId: string, extra: Record<string, unknown> = {}) => t.smart.startVariants({ analysisId, templateId: t.version.templateId, templateVersion: 1, protectedIds: ['smartphone_1'], rendering: 'integrated', count: 3, aspectRatio: '4:5', idempotencyKey: randomUUID(), ...extra });

  it('renders every variant from a clean product sheet (no mask), gives each a different direction with no prompt even when the concept call fails, and hands the chosen one to the normal review', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.write.mockRejectedValueOnce(new Error('concept writer down'));
    const set = await t.settledSet((await start(t, analysis.id)).set.id);
    expect(set).toMatchObject({ state: 'ready', rendering: 'integrated', concepts: { status: 'built-in' }, references: { file: 'product-sheet.png' }, usage: { segmentationCalls: 1, imageGenerationCalls: 3 } });
    expect(set.variants.map(v => v.status)).toEqual(['done', 'done', 'done']);
    expect(new Set(set.variants.map(v => v.concept?.presentation)).size).toBe(3);
    const sent = t.imageEdits.mock.calls.map(c => c[0] as { prompt: string; mask?: unknown; size: string });
    expect(sent.every(r => !r.mask && r.size === '1216x1520' && r.prompt.includes('PRODUCTS (keep consistent)') && r.prompt.includes('INTEGRATION'))).toBe(true);
    expect(new Set(sent.map(r => r.prompt)).size).toBe(3);
    const { execution } = t.smart.selectVariant(set.id, 'v1', { idempotencyKey: randomUUID() });
    expect(execution).toMatchObject({ state: 'generated', variantSource: { setId: set.id, variantId: 'v1' }, compatibility: { status: 'structural-change' } });
    expect(execution.variant).toBeUndefined();
  });

  it('draws a renamed product as its new identity without the old cutout, and names the old brand as stale', async () => {
    const t = await setup(), analysis = await t.analyzed();
    const set = await t.settledSet((await start(t, analysis.id, { products: { smartphone_1: { name: 'Apple iPhone 15' } }, count: 1 })).set.id);
    expect(set.products?.[0]).toMatchObject({ id: 'smartphone_1', requested: 'Apple iPhone 15', brand: 'Apple' });
    expect(t.segment).not.toHaveBeenCalled();
    expect(t.imageEdits).not.toHaveBeenCalled();
    const prompt = (t.imageGenerations.mock.calls[0][0] as unknown as { prompt: string }).prompt;
    expect(prompt).toContain('show it as a genuine Apple iPhone 15');
    await expect(start(t, analysis.id, { rendering: 'exact', products: { smartphone_1: { name: 'Apple iPhone 15' } } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('Feature 2 keeps the template structure: a new background and a replaced product (offline fakes)', { timeout: 60_000 }, () => {
  it('runs layered: the background around every product kept in place, then the phone repainted only in its own slot, on the creative\'s own-ratio canvas', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi()); t.setMask([PHONE, BUDS]);
    const draft = { edits: { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, background_1: { action: 'modify', value: 'warm sunset gradient' }, earbuds_1: { action: 'keep' } }, corrections: {} };
    const { resolution } = await t.smart.resolve(analysis.id, { draft });
    expect(resolution.plan).toMatchObject({ status: 'clear', conflicts: [] });
    const { execution } = await t.generate(analysis.id, resolution.id, draft);
    expect(execution.state).toBe('generated');
    expect(execution.edit!.strategy).toMatchObject({ kind: 'layered', protectIds: ['earbuds_1', 'smartphone_1'] });
    expect(execution.edit!.strategy!.regions.map(r => r.targetId)).toEqual(['smartphone_1']);
    expect(execution.usage.imageGenerationCalls).toBe(2);
    const canvas = `${editCanvasSize(W, H).width}x${editCanvasSize(W, H).height}`, calls = t.imageEdits.mock.calls.map(c => c[0] as { size: string; prompt: string });
    expect(calls.map(c => c.size)).toEqual([canvas, canvas]);
    // Pass 1 restyles the background and keeps the phone; pass 2 replaces the phone inside its own slot.
    expect(calls[0].prompt).toContain('Restyle the background');
    expect(calls[0].prompt).not.toContain('Replace the smartphone');
    expect(calls[1].prompt).toMatch(/Replace the smartphone[^.]*\. Remove the original completely: no part of it may remain\. Draw the new one exactly in the original's slot \(about \d+–\d+% across/);
    expect(execution.edit).toMatchObject({ image: { width: W, height: H }, preservation: { method: 'outside-regions', maxDifferenceOutside: 0 } });
  });
});

describe('a creative Seedream refuses is never lost: classified, not repeated blindly, recoverable without Seedream (offline fakes)', { timeout: 60_000 }, () => {
  it('records the partner refusal by image hash, asks before an identical repeat, and cuts the products out (no Seedream, no regeneration) into editor layers', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi()); t.setMask([PHONE, BUDS]);
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    const image = readFileSync(t.executions.path(execution.id, execution.edit!.image!.file)), edits = t.imageEdits.mock.calls.length;
    t.fal.partnerRejections = 2;
    t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'simple' });
    const failed = await t.settled(execution.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED' } });
    const run = readRun(join(t.root, 'runs', failed.runId!));
    expect(run.rejection).toMatchObject({ category: 'partner-content', loc: 'body.image', reason: 'partner_validation_failed', billableUnits: '0', imageSha256: execution.edit!.image!.sha256 });
    expect(run.providerImage).toMatchObject({ source: { sha256: execution.edit!.image!.sha256 }, provider: { normalized: false } });
    // The identical request again (same image, same plan) needs the person's confirmation; another plan does not, once.
    expect(() => t.service.retryExtraction(failed.id, { plan: 'simple' })).toThrow(expect.objectContaining({ code: 'REPEAT_REQUIRES_CONFIRMATION' }));
    t.service.retryExtraction(failed.id, { plan: 'saved' });
    const twice = await t.settled(failed.id);
    expect(t.service.extractionHistory(twice.id)).toMatchObject({ imageSha256: execution.edit!.image!.sha256, accepted: 0, refused: { 'partner-content': 2 }, billedZero: 2 });
    // Refused twice by the partner check and never accepted: every further Seedream try asks first.
    expect(() => t.service.retryExtraction(twice.id, { plan: 'refresh' })).toThrow(expect.objectContaining({ code: 'REPEAT_REQUIRES_CONFIRMATION' }));
    // Recovery without Seedream: the products cut out (SAM-3, one request each) over a background filled locally.
    const submits = t.decomposed.length, segments = t.segment.mock.calls.length;
    t.service.retryExtraction(twice.id, { plan: 'cutouts' });
    const recovered = await t.settled(twice.id);
    expect(recovered).toMatchObject({ state: 'done', planDecision: { choice: 'cutouts' }, warnings: [expect.stringMatching(/^LAYERS_CUTOUTS_ONLY: .*a local fill, not a reconstruction/)] });
    expect(t.decomposed.length).toBe(submits); // no Seedream upload
    expect(t.segment.mock.calls.length).toBeGreaterThan(segments);
    expect(t.imageEdits.mock.calls.length).toBe(edits); // never regenerated
    expect(readFileSync(t.executions.path(execution.id, execution.edit!.image!.file))).toEqual(image);
    const done = readRun(join(t.root, 'runs', recovered.runId!));
    expect(done).toMatchObject({ stage: 'done', composed: { source: 'product-cutouts', extraction: 'cutouts' } });
    expect(done.layers?.map(l => l.name)).toEqual(['Background (filled locally behind the products)', 'Smartphone (cut out)', 'Earbuds (cut out)']);
    expect(done.editorLayerFiles).toHaveLength(3);
  });

  it('a flat preview is one layer, said so, with no request at all', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    t.fal.partnerRejections = 1;
    t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'simple' });
    const failed = await t.settled(execution.id), submits = t.decomposed.length, segments = t.segment.mock.calls.length;
    t.service.retryExtraction(failed.id, { plan: 'flat' });
    const flat = await t.settled(failed.id);
    expect(flat).toMatchObject({ state: 'done', warnings: [expect.stringMatching(/^LAYERS_NOT_SPLIT: a flat preview, not a decomposition/)] });
    const run = readRun(join(t.root, 'runs', flat.runId!));
    expect(run).toMatchObject({ stage: 'done', composed: { source: 'single-layer', extraction: 'none' } });
    expect(run.layers?.map(l => l.name)).toEqual(['Flat preview (not split into layers)']);
    expect([t.decomposed.length, t.segment.mock.calls.length]).toEqual([submits, segments]);
  });

  it('Qwen layers are an alternative only after Seedream refused the image: chosen explicitly, one request, real layers for the editor', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi()); t.setMask([PHONE, BUDS]);
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    // Seedream is always the first extractor.
    expect(() => t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'qwen' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    t.fal.partnerRejections = 1;
    t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'simple' });
    const failed = await t.settled(execution.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED' } });
    const image = readFileSync(t.executions.path(execution.id, execution.edit!.image!.file)), edits = t.imageEdits.mock.calls.length, seedream = t.submitted.filter(e => e.startsWith('bytedance/')).length;
    t.service.retryExtraction(failed.id, { plan: 'qwen' });
    const done = await t.settled(failed.id);
    expect(done).toMatchObject({ state: 'done', planDecision: { choice: 'qwen' }, usage: { qwenLayerCalls: 1 }, warnings: [expect.stringMatching(/^LAYERS_QWEN: .*AI-generated/)] });
    expect(t.submitted.filter(e => e === 'fal-ai/qwen-image-layered')).toHaveLength(1);
    expect(t.submitted.filter(e => e.startsWith('bytedance/'))).toHaveLength(seedream); // no Seedream request
    expect(t.imageEdits.mock.calls.length).toBe(edits); // never regenerated
    expect(readFileSync(t.executions.path(execution.id, execution.edit!.image!.file))).toEqual(image);
    const run = readRun(join(t.root, 'runs', done.runId!));
    expect(run).toMatchObject({ stage: 'done', composed: { source: 'qwen-layers', extraction: 'qwen' }, templateExecution: { plan: 'qwen', input: { sha256: execution.edit!.image!.sha256 } } });
    expect(run.layers!.map(l => l.name)).toEqual([expect.stringMatching(/^Background \(Qwen; /), expect.stringMatching(/smartphone/i)]);
    expect(run.layers![1].placement).toMatchObject({ kind: 'bbox-crop' });
    expect(run.editorLayerFiles).toHaveLength(2);
    const report = JSON.parse(readFileSync(join(t.root, 'runs', done.runId!, 'qwen-layers.json'), 'utf8'));
    expect(report).toMatchObject({ endpoint: 'fal-ai/qwen-image-layered', requestId: expect.any(String), alignment: { ok: true, mapping: 'stretch' }, kept: 2 });
    expect(report.reconstruction.mae).toBeLessThan(2);
    expect(JSON.parse(readFileSync(t.executions.path(execution.id, 'qwen-request.json'), 'utf8'))).toMatchObject({ endpoint: 'fal-ai/qwen-image-layered', input: { enable_safety_checker: true, image_url: expect.stringMatching(/^<uploaded copy/) } });
  });

  it('a failed Qwen request leaves the refused Seedream run in place, so every other choice stays open, and is repeated only when confirmed', async () => {
    const t = await setup(), analysis = await t.analyzed();
    t.setProposal(xiaomi());
    const { resolution } = await t.smart.resolve(analysis.id, { draft: replacePhone });
    const { execution } = await t.generate(analysis.id, resolution.id, replacePhone);
    t.fal.partnerRejections = 1;
    t.service.decompose(execution.id, { acknowledgeReview: true, plan: 'simple' });
    const refused = await t.settled(execution.id);
    t.fal.qwenFailures = 1;
    t.service.retryExtraction(refused.id, { plan: 'qwen' });
    const failed = await t.settled(refused.id);
    expect(failed).toMatchObject({ state: 'failed', runId: refused.runId, error: { code: 'QWEN_LAYERS_FAILED', message: expect.stringContaining('HTTP 422') }, usage: { qwenLayerCalls: 1 } });
    expect(() => t.service.retryExtraction(failed.id, { plan: 'qwen' })).toThrow(expect.objectContaining({ code: 'REPEAT_REQUIRES_CONFIRMATION' }));
    t.service.retryExtraction(failed.id, { plan: 'refresh' });
    expect(await t.settled(failed.id)).toMatchObject({ state: 'done', planDecision: { choice: 'refresh' } });
  });
});

