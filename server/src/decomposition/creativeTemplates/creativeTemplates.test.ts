import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { compileTemplateEdit, contentWords, EDIT_INSTRUCTION_SLOT, EXECUTION_POLICY, GENERATE_UNCHANGED_INSTRUCTION, leakedContent, type TemplateExecution, type TemplateStructure, type TemplateVersion } from '@frameflow/shared';
import type { FalTransport } from '../providers/falClient.js';
import { ProviderError } from '../providers/adapters.js';
import { readRun, type RunRecord } from '../layerizeExperiment.js';
import { interleavedPartFixture } from '../semanticPlanner.fixture.js';
import { createOpenAIPlanner } from '../layerizePlanner.js';
import { TEMPLATE_CAPTURE_SCHEMA, type SemanticAnalysis } from '../semanticPlanner.js';
import { captureTemplateVersion, zoneOf } from './capture.js';
import { compileTemplatePlan, templatePlanPrompt, templatePlanStrategy } from './compile.js';
import { fileExecutionStore } from './executions.js';
import { createTemplateExecutions } from './service.js';
import { fileTemplateStore } from './store.js';
import { registerCreativeTemplateRoutes } from './routes.js';
import { templateHealth } from './templateEdits.js';
import { RunError } from '../layerizeExperiment.js';
import { parseStructure } from './inspect.js';
import { executionGenerationCost, readRunDiagnostics } from '../runDiagnostics.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const none = { relation: 'none' as const, parent_id: '', separation_risk: 'low' as const, keep_with_parent: false }, clear = { is_occluded: false, occluded_by: [], requires_reconstruction: false };
type Element = SemanticAnalysis['elements'][number];
const element = (id: string, type: string, description: string, z: number, region: string, attachment: Element['attachment'] = none): Element =>
  ({ id, type, description, editable_independently: true, approximate_region: region, z_order: z, confidence: 'high', occlusion: clear, attachment });
/** What the planner says about the first creative: a baby girl holding an iPhone. Its words must never reach the template. */
const babyPhone: SemanticAnalysis = {
  image_type: 'studio portrait photograph', scene_summary: 'A smiling baby girl in a cream lace dress holding a gold iPhone in front of a blue painted backdrop.',
  elements: [element('blue_backdrop', 'background', 'Blue painted studio backdrop', 0, 'full canvas'), element('baby_girl', 'person', 'Smiling baby girl in a cream lace dress, waving', 1, 'center, 15–80% across'),
    element('gold_iphone', 'product', 'Gold iPhone held in her right hand', 2, 'bottom right', { relation: 'held_in_hand', parent_id: 'baby_girl', separation_risk: 'low', keep_with_parent: false })],
  relationships: [{ source: 'baby_girl', relationship: 'holding', target: 'gold_iphone' }], ambiguities: [], recommended_layer_count: 3,
  decomposition_strategy: 'Separate the baby girl and the iPhone from the blue backdrop.', downstream_decomposition_prompt: 'Create 3 layers: the blue backdrop; the smiling baby girl in a cream dress; the gold iPhone in her hand.',
};
const babyCapture = { roles: { blue_backdrop: 'background', baby_girl: 'primary_subject', gold_iphone: 'held_object' }, name: 'Subject Holding Product', description: 'A primary subject holding an object in front of a background.' };
/** A second, different structure: earbuds with a call-to-action button. */
const earbudsCta: SemanticAnalysis = {
  image_type: 'product advertisement', scene_summary: 'White AirPods on a pedestal with a Buy Now button on a purple gradient.',
  elements: [element('purple_gradient', 'background', 'Purple gradient background', 0, 'full canvas'), element('airpods', 'product', 'White AirPods in their open case', 1, 'center'),
    element('buy_now', 'cta button', 'Rounded Buy Now button', 2, 'bottom center')],
  relationships: [], ambiguities: [], recommended_layer_count: 3, decomposition_strategy: 'AirPods and button apart from the gradient.', downstream_decomposition_prompt: 'Separate the AirPods, the Buy Now button and the purple gradient.',
};
const earbudsCapture = { roles: { purple_gradient: 'background', airpods: 'main_product', buy_now: 'cta' }, name: 'Product + CTA + Background', description: 'A main product above a call-to-action button on a background.' };
/** The live 08:13 creative's capture roles (request 01a11a94-…): the case lid is a main-product part. */
const interleavedCapture = { roles: { background_gradient: 'background', circular_backdrop: 'backdrop', circuit_decorations: 'decoration', pedestal: 'prop', case_shadow: 'effect', case_lid: 'main_product',
  seated_earbud: 'supporting_product', case_base: 'main_product', floating_earbud: 'supporting_product' }, name: 'Floating Product Showcase', description: 'A main product with supporting products above a prop.' };
const withCapture = (analysis: SemanticAnalysis, capture: typeof babyCapture | typeof earbudsCapture | typeof interleavedCapture) =>
  ({ ...analysis, elements: analysis.elements.map(e => ({ ...e, template_role: capture.roles[e.id as keyof typeof capture.roles] })), reusable_template: { name: capture.name, description: capture.description } });

/** The template system with every provider faked and every call counted. Images are flat colors, so no cleanup pass is needed. */
async function setup(root = mkdtempSync(join(tmpdir(), 'creative-templates-'))) {
  const answers = new Map<string, unknown>();
  const plannerCalls = vi.fn(async (request: { input: { content: { image_url?: string }[] }[]; text: { format: { schema: unknown } } }) => {
    const image = request.input[0].content.find(c => c.image_url)!.image_url!, answer = answers.get(sha(Buffer.from(image.split(',')[1], 'base64')));
    if (!answer) throw new Error('No planner answer for this image.');
    const value = request.text.format.schema === TEMPLATE_CAPTURE_SCHEMA ? answer : (answer as { semantic: unknown }).semantic;
    return { status: 'completed', output: [], output_text: JSON.stringify((value as { capture?: unknown }).capture ?? value) };
  });
  const planner = createOpenAIPlanner({ client: { responses: { create: plannerCalls } } as never });
  const decomposed: Buffer[] = [], seedreamPrompts: string[] = [], files = new Map<string, Buffer>();
  /** What Seedream returns for an image, by its sha: the base, plus the layers it names in its own words (none by default). */
  const seedreamLayers = new Map<string, { name: string; left: number; top: number; size: number }[]>();
  const failures: { result?: Error[] } = {};
  const transport: FalTransport = {
    upload: async (image) => { decomposed.push(image as Buffer); return `https://v3b.fal.media/files/t/in-${decomposed.length}.png`; },
    submit: async (_endpoint, input) => { seedreamPrompts.push(String((input as { prompt?: string }).prompt ?? '')); return { requestId: `r${seedreamPrompts.length}` }; },
    status: async () => 'COMPLETED',
    result: async (_e, id) => {
      const failure = failures.result?.shift();
      if (failure) throw failure;
      const input = decomposed[Number(id.slice(1)) - 1], { width, height } = await sharp(input).metadata(), named = seedreamLayers.get(sha(input)) ?? [];
      files.set(`base-${id}`, input);
      for (const [i, layer] of named.entries()) files.set(`${id}-${i}`, await sharp({ create: { width: width!, height: height!, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: await png(layer.size, layer.size, '#f5f5f5'), left: layer.left, top: layer.top }]).png().toBuffer());
      return { layers: [{ image: { url: `https://v3b.fal.media/files/t/base-${id}.png` }, z_index: 0 }, ...named.map((layer, i) => ({ image: { url: `https://v3b.fal.media/files/t/${id}-${i}.png` }, z_index: i + 1, name: layer.name }))] };
    },
    cancel: async () => undefined, download: async (url) => files.get(/files\/t\/(.+)\.png$/.exec(url)![1])!,
  };
  const imageEdits = vi.fn(async (request: { size: string; prompt: string }) => {
    const [width, height] = request.size.split('x').map(Number);
    return { data: [{ b64_json: (await png(width, height, '#7a2e8c')).toString('base64') }], usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { image_tokens: 800, text_tokens: 200, cached_tokens: 0 } } };
  });
  const templates = fileTemplateStore(join(root, 'templates')), executions = fileExecutionStore(join(root, 'executions')), runsDir = join(root, 'runs'), logs: string[] = [];
  const inspections = new Map<string, ReturnType<typeof parseStructure> | Error>();
  const inspectCalls = vi.fn(async (bytes: Buffer, _mime: string, save: (file: string, value: object) => void) => {
    save('structure.openai-request.json', { model: 'gpt-5.6-luna' });
    const answer = inspections.get(sha(bytes));
    if (!answer || answer instanceof Error) throw answer ?? new Error('No offline structure answer.');
    save('structure.openai-response.json', { id: 'offline-structure', model: 'gpt-5.6-luna', usage: { input_tokens: 1500, output_tokens: 400 } });
    return answer;
  });
  let line: Promise<unknown> = Promise.resolve();
  /** Holds every queued execution until released (a decomposition still running elsewhere). */
  const hold = () => { let release!: () => void; const gate = new Promise<void>(done => { release = done; }); line = line.then(() => gate); return release; };
  const service = createTemplateExecutions({ templates, executions, runsDir, log: entry => logs.push(entry),
    inspector: () => ({ model: 'gpt-5.6-luna', inspect: inspectCalls }),
    deps: () => ({ planner, transport: () => transport, sleep: async () => undefined }),
    generation: () => ({ model: 'gpt-image-2', client: () => ({ images: { edit: imageEdits, generate: vi.fn() } }) as never }),
    inTurn: (_id, work) => { line = line.then(work).catch(() => undefined); } });
  /** A creative of a given color, and what the planner says about it. */
  const creative = async (color: string, analysis?: SemanticAnalysis, capture?: typeof babyCapture | typeof earbudsCapture | typeof interleavedCapture, width = 640) => {
    const bytes = await png(width, 800, color);
    if (analysis) {
      answers.set(sha(bytes), { semantic: analysis, capture: capture ? withCapture(analysis, capture) : undefined });
      // Automatic inspection needs zones; a zone-less creative is only ever reused by manual selection.
      if (capture && analysis.elements.every(e => (capture.roles as Record<string, string>)[e.id] && zoneOf(e.approximate_region))) inspections.set(sha(bytes), parseStructure({ confidence: 0.96, elements: analysis.elements.map(e => ({ id: e.id, role: (capture.roles as Record<string, string>)[e.id], zone: zoneOf(e.approximate_region), independent: e.editable_independently,
        parent: e.attachment.parent_id, attachment: e.attachment.relation, keepWithParent: e.attachment.keep_with_parent, currentValue: e.description })), relationships: analysis.relationships.map(r => ({ source: r.source, target: r.target, relation: r.relationship === 'holding' ? 'holds' : r.relationship })) }));
      seedreamLayers.set(sha(bytes), analysis.elements.filter(e => e.type !== 'background').map((e, i) => ({ name: e.description, left: i ? 420 : 200, top: i ? 520 : 150, size: i ? 140 : 320 })));
    }
    return bytes;
  };
  const start = (mode: string, bytes: Buffer, extra: { values?: unknown; options?: unknown; productReference?: { bytes: Buffer; fileName?: string; mimeType?: string }; reviewBeforeDecompose?: boolean; templateVersion?: number; allowMismatch?: boolean; inspect?: boolean; templateId?: string; editInstruction?: string; idempotencyKey?: string; planFresh?: boolean; regenerateUnchanged?: boolean } = {}) =>
    service.start({ mode, idempotencyKey: extra.idempotencyKey ?? randomUUID(), upload: { bytes, fileName: 'creative.png', mimeType: 'image/png' }, ...extra });
  const settled = async (id: string): Promise<TemplateExecution> => {
    for (let i = 0; i < 500; i++) { const e = executions.get(id); if (e.state === 'done' || e.state === 'failed') return e; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Never settled.');
  };
  const runOf = (execution: TemplateExecution): RunRecord => readRun(join(runsDir, execution.runId!));
  const detect = async (bytes: Buffer) => {
    const { execution } = await start('CREATE_TEMPLATE', bytes, { inspect: true });
    await line;
    return executions.get(execution.id);
  };
  return { root, templates, executions, service, start, settled, creative, runOf, hold, plannerCalls, imageEdits, decomposed, seedreamPrompts, seedreamLayers, failures, logs, inspections, inspectCalls, detect, runsDir };
}
const SOURCE_WORDS = /\b(?:baby|girl|iphone|cream|lace|gold|blue|waving|smiling)\b/i;

// Each test runs real decompositions (sharp renders, protection, refinement): slow under a loaded full suite.
describe('creative templates: dynamic, learned once, reused without the planner', { timeout: 30_000 }, () => {
  it('generates once, persists a reviewable image across restart, then explicitly decomposes it with the pinned plan and zero planners', async () => {
    const t = await setup(), bytes = await t.creative('#336699', babyPhone, babyCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    const version = t.templates.current(first.template!.id)!;
    const values = { primary_subject: 'Young man in a blue jacket', held_object: 'football', background: 'night stadium' };
    const options = { templateId: version.templateId, templateVersion: 1, values, reviewBeforeDecompose: true, idempotencyKey: 'wizard-generate-once' };
    const { execution } = await t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, options);
    await vi.waitFor(() => expect(t.executions.get(execution.id).state).toBe('generated'));
    const reviewed = t.executions.get(execution.id);
    expect(reviewed).toMatchObject({ slotValues: values, usage: { plannerCalls: 0, imageGenerationCalls: 1, promptGenerationCalled: false } });
    expect(reviewed.runId).toBeUndefined(); expect(reviewed.edit!.image).toBeTruthy();
    expect(t.seedreamPrompts).toHaveLength(1); expect(t.inspectCalls).not.toHaveBeenCalled();
    // The prompt sent is the canonical compiler's: the same function the wizard previews with.
    expect(reviewed.edit!.prompt).toBe(compileTemplateEdit(version, values).text);
    expect((await t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, options)).created).toBe(false);
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
    const cost = executionGenerationCost(reviewed, t.executions);
    expect(cost).toMatchObject({ confidence: 'Calculated' }); expect(cost.inr).toBeGreaterThan(0);
    // A replaced object cannot be confirmed by pixels: the local review waits for a person, and nothing is sent until then.
    expect(reviewed.edit!.review).toMatchObject({ requiresAcknowledgement: true, note: expect.stringMatching(/pixel comparison only/) });
    // The held object here is its own layer: a different one is a structural change the saved plan was not learned from.
    expect(reviewed.compatibility).toMatchObject({ status: 'structural-change', changedSlots: ['held_object'] });
    const restarted = await setup(t.root);
    expect(() => restarted.service.decompose(execution.id)).toThrow(expect.objectContaining({ code: 'REVIEW_REQUIRED' }));
    expect(() => restarted.service.decompose(execution.id, { acknowledgeReview: true })).toThrow(expect.objectContaining({ code: 'PLAN_DECISION_REQUIRED' }));
    expect(restarted.seedreamPrompts).toHaveLength(0); expect(restarted.plannerCalls).not.toHaveBeenCalled();
    // The user's explicit decision: the saved plan anyway (planner 0). A double-click starts one run.
    restarted.service.decompose(execution.id, { acknowledgeReview: true, plan: 'saved' }); restarted.service.decompose(execution.id, { acknowledgeReview: true, plan: 'saved' });
    const done = await restarted.settled(execution.id);
    expect(done).toMatchObject({ state: 'done', template: first.template, usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
    expect(restarted.imageEdits).not.toHaveBeenCalled(); expect(restarted.plannerCalls).not.toHaveBeenCalled(); expect(restarted.inspectCalls).not.toHaveBeenCalled();
    expect(restarted.seedreamPrompts).toHaveLength(1);
    expect(done).toMatchObject({ planDecision: { choice: 'saved' }, edit: { review: { acknowledgedAt: expect.any(String) } } });
    // Exactly the approved image was decomposed, and the run records which plan and which bytes.
    expect(restarted.decomposed[0]).toEqual(readFileSync(t.executions.path(execution.id, reviewed.edit!.image!.file)));
    expect(restarted.runOf(done).templateExecution).toMatchObject({ plan: 'saved', input: { source: 'approved-generated', sha256: reviewed.edit!.image!.sha256 } });
    const diagnostic = await readRunDiagnostics(join(t.runsDir, done.runId!), { executions: t.executions });
    expect(diagnostic.stages.find(s => s.id === 'generation')!.cost).toEqual(cost);
    expect(diagnostic.stages.find(s => s.id === 'planner')!.calls).toEqual([]);
    expect(restarted.service.decompose(execution.id).runId).toBe(done.runId);
    expect(restarted.seedreamPrompts).toHaveLength(1);
  });
  it('no-change Generate reviews the original image with no image request; "regenerate anyway" is an explicit, separate request; stale approval makes no calls', async () => {
    // Changed deliberately (approved 2026-10-09): nothing to change used to mean one paid whole-image regeneration.
    const t = await setup(), bytes = await t.creative('#336699', babyPhone, babyCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    const options = { templateId: first.template!.id, values: {}, reviewBeforeDecompose: true };
    const a = (await t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, options)).execution;
    await vi.waitFor(() => expect(t.executions.get(a.id).state).toBe('generated'));
    const original = t.executions.get(a.id);
    expect(t.imageEdits).not.toHaveBeenCalled();
    // The image to review is the upload itself, at its own size; it goes on to decomposition like any other.
    expect(original.edit).toMatchObject({ original: true, image: { sha256: original.upload.sha256, width: 640, height: 800 }, review: { requiresAcknowledgement: false, note: expect.stringMatching(/original image, exactly as uploaded/) } });
    expect(original.usage).toMatchObject({ imageGenerationCalled: false, imageGenerationCalls: 0 });
    // Regenerate anyway: one explicit image request, a new saved result, at the source's own size.
    const b = (await t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, { ...options, regenerateUnchanged: true })).execution;
    await vi.waitFor(() => expect(t.executions.get(b.id).state).toBe('generated'));
    const regenerated = t.executions.get(b.id);
    expect(b.id).not.toBe(a.id); expect(t.imageEdits).toHaveBeenCalledTimes(1);
    expect(regenerated.edit).toMatchObject({ regenerate: true, image: { width: 640, height: 800 } });
    expect(regenerated.edit!.prompt).toContain(GENERATE_UNCHANGED_INSTRUCTION);
    t.service.decompose(a.id);
    const decomposed = await t.settled(a.id);
    expect(decomposed).toMatchObject({ state: 'done', usage: { imageGenerationCalls: 0, plannerCalls: 0 } });
    expect(t.seedreamPrompts).toHaveLength(2);
    t.templates.update(first.template!.id, template => { template.status = 'deleted'; });
    expect(() => t.service.decompose(b.id)).toThrow(/unavailable/);
    expect(t.seedreamPrompts).toHaveLength(2); expect(t.plannerCalls).toHaveBeenCalledTimes(1);
  });
  it('primary manual flow creates once and reuses a chosen template for new content with zero analysis and planner calls', async () => {
    const t = await setup();
    const first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const ball = structuredClone(babyPhone); ball.elements[2].description = 'Red ball held in the hand';
    const bytes = await t.creative('#dd8844', ball, babyCapture);
    const second = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', bytes, { templateId: first.template!.id })).execution.id);
    expect(second).toMatchObject({ state: 'done', template: first.template, usage: { plannerCalls: 0, imageGenerationCalls: 0, promptGenerationCalled: false, generationPromptSource: 'saved-template', decompositionPlanSource: 'saved-template' } });
    expect(second.inspection).toBeUndefined(); expect(t.inspectCalls).not.toHaveBeenCalled(); expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    const diagnostics = await readRunDiagnostics(join(t.runsDir, second.runId!), { executions: t.executions });
    expect(diagnostics.stages.find(s => s.id === 'reference')).toMatchObject({ status: 'Skipped', calls: [] });
    expect(diagnostics.stages.find(s => s.id === 'planner')?.calls).toEqual([]);
    expect(diagnostics.execution).toMatchObject({ generationPromptSource: 'saved-template', decompositionPlanSource: 'saved-template', plannerCallsAvoided: 1 });
    // A different held object (its own layer) is never decomposed with the saved plan unseen: refused before any call.
    const edits = t.imageEdits.mock.calls.length;
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, { templateId: first.template!.id, values: { held_object: 'baseball' } })).rejects.toMatchObject({ code: 'PLAN_DECISION_REQUIRED' });
    expect(t.imageEdits).toHaveBeenCalledTimes(edits);
    const { execution: generating } = await t.start('REUSE_TEMPLATE_WITH_EDIT', bytes, { templateId: first.template!.id, values: { held_object: 'baseball' }, reviewBeforeDecompose: true });
    await vi.waitFor(() => expect(t.executions.get(generating.id).state).toBe('generated'));
    t.service.decompose(generating.id, { acknowledgeReview: true, plan: 'saved' });
    const edited = await t.settled(generating.id);
    expect(edited.edit?.prompt).toContain('Replace the held object at the bottom right with "baseball". Remove the original completely');
    expect(edited.usage).toMatchObject({ plannerCalls: 0, imageGenerationCalls: 1 }); expect(t.inspectCalls).not.toHaveBeenCalled();
  });
  it('warns locally before a mismatched manual reuse, keeps the chosen template, and creates a new one only on request', async () => {
    const t = await setup();
    const first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const different = await t.creative('#eeeeee', earbudsCta, earbudsCapture, 1000);
    const before = t.seedreamPrompts.length;
    await expect(t.start('REUSE_TEMPLATE_ORIGINAL', different, { templateId: first.template!.id })).rejects.toMatchObject({ code: 'TEMPLATE_MAY_NOT_FIT' });
    expect(t.seedreamPrompts).toHaveLength(before); expect(t.plannerCalls).toHaveBeenCalledTimes(1); expect(t.inspectCalls).not.toHaveBeenCalled();
    const continued = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', different, { templateId: first.template!.id, allowMismatch: true })).execution.id);
    expect(continued).toMatchObject({ state: 'done', template: first.template, usage: { plannerCalls: 0 } });
    expect(continued.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Selected template may not fit')]));
    const newLayout = await t.settled((await t.start('CREATE_TEMPLATE', different)).execution.id);
    expect(newLayout).toMatchObject({ state: 'done', usage: { plannerCalls: 1 } });
    expect(newLayout.template?.id).not.toBe(first.template?.id); expect(t.templates.list()).toHaveLength(2);
    // Known exact-upload evidence can flag an incompatible selection even without a shape difference.
    const original = await t.creative('#336699', babyPhone, babyCapture);
    await expect(t.start('REUSE_TEMPLATE_ORIGINAL', original, { templateId: newLayout.template!.id })).rejects.toMatchObject({ code: 'TEMPLATE_MAY_NOT_FIT', details: { warnings: expect.arrayContaining([expect.stringContaining('Saved evidence')]) } });
    expect(t.inspectCalls).not.toHaveBeenCalled(); expect(t.plannerCalls).toHaveBeenCalledTimes(2);
  });
  it('reusing a template on its own source image never warns, even when its layers have no zones', async () => {
    const t = await setup(), vague = { ...babyPhone, elements: babyPhone.elements.map(e => ({ ...e, approximate_region: 'as in the image' })) };
    const bytes = await t.creative('#5a3d7a', vague, babyCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    expect(t.templates.current(first.template!.id)!.structure.layers.every(l => !l.zone)).toBe(true);
    const reused = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', bytes, { templateId: first.template!.id })).execution.id);
    expect(reused).toMatchObject({ state: 'done', usage: { plannerCalls: 0, imageGenerationCalls: 0 } });
    expect(reused.warnings.filter(w => w.startsWith('TEMPLATE_FIT_WARNING'))).toEqual([]);
  });
  it('automatic A → different-content B → different-layout C → C repeat uses planners 1, 0, 1, 0, without selecting a template', async () => {
    const t = await setup(), a = await t.creative('#336699', babyPhone, babyCapture);
    const detectedA = await t.detect(a);
    expect(detectedA).toMatchObject({ state: 'ready', inspection: { outcome: 'new', calls: 0 } });
    t.service.proceed(detectedA.id);
    const first = await t.settled(detectedA.id);
    expect(first.state).toBe('done'); expect(first.usage.plannerCalls).toBe(1);
    const ball = structuredClone(babyPhone); ball.elements[2].description = 'Red ball held in the hand';
    const b = await t.creative('#dd8844', ball, babyCapture), detectedB = await t.detect(b);
    expect(sha(b)).not.toBe(sha(a));
    expect(detectedB).toMatchObject({ state: 'ready', template: first.template, inspection: { outcome: 'strong', calls: 1, currentValues: { held_object: 'Red ball held in the hand' } }, usage: { generationPromptSource: 'saved-template', decompositionPlanSource: 'saved-template' } });
    t.service.proceed(detectedB.id);
    const second = await t.settled(detectedB.id);
    expect(second).toMatchObject({ state: 'done', usage: { plannerCalls: 0, imageGenerationCalls: 0, promptGenerationCalled: false } });
    expect(t.runOf(second).refinement).toMatchObject({ state: 'done', planCoverage: { complete: true }, background: { quality: 'usable', contaminated: false } });
    expect(t.templates.list()).toHaveLength(1);
    const diagnostics = await readRunDiagnostics(join(t.runsDir, second.runId!), { executions: t.executions });
    expect(diagnostics.execution).toMatchObject({ plannerCallsAvoided: 1, generationPromptSource: 'saved-template' });
    expect(diagnostics.stages.find(s => s.id === 'reference')?.calls).toHaveLength(1);
    expect(diagnostics.stages.find(s => s.id === 'planner')?.calls).toHaveLength(0);
    const exact = await t.detect(b);
    expect(exact).toMatchObject({ template: first.template, inspection: { outcome: 'exact', calls: 0 } });
    t.service.proceed(exact.id); expect((await t.settled(exact.id)).usage.plannerCalls).toBe(0);
    const c = await t.creative('#eeeeee', earbudsCta, earbudsCapture), detectedC = await t.detect(c);
    expect(detectedC.inspection?.outcome).toBe('new'); expect(detectedC.template).toBeUndefined();
    t.service.proceed(detectedC.id); const third = await t.settled(detectedC.id);
    expect(third).toMatchObject({ state: 'done', usage: { plannerCalls: 1 } });
    expect(third.template?.id).not.toBe(first.template?.id);
    const next = await t.detect(await t.creative('#995588', earbudsCta, earbudsCapture));
    expect(next.template).toEqual(third.template);
    t.service.proceed(next.id); expect((await t.settled(next.id)).usage.plannerCalls).toBe(0);
    expect(t.templates.list()).toHaveLength(2); expect(t.plannerCalls).toHaveBeenCalledTimes(2);
    expect(t.imageEdits).not.toHaveBeenCalled(); expect(t.inspectCalls).toHaveBeenCalledTimes(3);
  });
  it('automatic product matching tolerates two versus three child parts, compiles dynamic edits locally, and Plan fresh forces one planner', async () => {
    const t = await setup(), a = await t.creative('#552277', earbudsCta, earbudsCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', a)).execution.id);
    for (const count of [2, 3]) {
      const bytes = await t.creative(count === 2 ? '#774499' : '#999999', earbudsCta, earbudsCapture), answer = t.inspections.get(sha(bytes)) as ReturnType<typeof parseStructure>;
      const product = answer.structure.layers.find(l => l.role === 'main_product')!;
      for (let i = 1; i < count; i++) answer.structure.layers.push({ ...product, id: `child_${i}` });
      const detected = await t.detect(bytes);
      expect(detected.template).toEqual(first.template);
      if (count === 2) {
        expect(() => t.service.proceed(detected.id, { values: { bad: 'unsafe slot' } })).toThrow(/saved template field/);
        t.service.proceed(detected.id, { values: { main_product: 'white earbuds in an open case' } });
        const done = await t.settled(detected.id);
        expect(done.usage).toMatchObject({ plannerCalls: 0, imageGenerationCalls: 1, generationPromptSource: 'saved-template' });
        expect(done.edit?.prompt).toContain('Main product (center): white earbuds in an open case');
      } else {
        t.service.proceed(detected.id, { planFresh: true });
        expect(await t.settled(detected.id)).toMatchObject({ state: 'done', plannerReason: 'plan-fresh', usage: { plannerCalls: 1 } });
      }
    }
    expect(t.templates.list()).toHaveLength(1);
  });
  it('uncertain or failed inspection falls back safely, and retries do not inspect or execute twice', async () => {
    const t = await setup(), a = await t.creative('#336699', babyPhone, babyCapture);
    await t.settled((await t.start('CREATE_TEMPLATE', a)).execution.id);
    const b = await t.creative('#bb3377', babyPhone, babyCapture);
    (t.inspections.get(sha(b)) as ReturnType<typeof parseStructure>).confidence = 0.6;
    const low = await t.detect(b);
    expect(low.inspection?.outcome).toBe('uncertain'); expect(low.template).toBeUndefined();
    const retry = await t.start('CREATE_TEMPLATE', b, { inspect: true, idempotencyKey: low.idempotencyKey });
    expect(retry).toMatchObject({ created: false, execution: { id: low.id } }); expect(t.inspectCalls).toHaveBeenCalledTimes(1);
    t.service.proceed(low.id); expect(() => t.service.proceed(low.id)).toThrow(/still running/);
    expect((await t.settled(low.id)).usage.plannerCalls).toBe(1);
    expect((await t.start('CREATE_TEMPLATE', b, { inspect: true, idempotencyKey: low.idempotencyKey })).created).toBe(false);
    const c = await t.creative('#448811', babyPhone, babyCapture); t.inspections.set(sha(c), new Error('offline failure'));
    const failed = await t.detect(c);
    expect(failed).toMatchObject({ state: 'ready', inspection: { outcome: 'uncertain', calls: 1 } });
    t.service.proceed(failed.id); const done = await t.settled(failed.id);
    expect(done.usage.plannerCalls).toBe(1);
    const diagnostics = await readRunDiagnostics(join(t.runsDir, done.runId!), { executions: t.executions });
    expect(diagnostics.stages.find(s => s.id === 'reference')).toMatchObject({ status: 'Warning', calls: [{ model: 'gpt-5.6-luna' }] });
  });
  it('ambiguous, inactive and invalid templates cannot silently win an automatic match', async () => {
    const t = await setup();
    const first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const version = t.templates.current(first.template!.id)!;
    const duplicate = t.templates.create(id => ({ ...version, templateId: id }));
    const ambiguous = await t.detect(await t.creative('#aabbcc', babyPhone, babyCapture));
    expect(ambiguous.template).toBeUndefined(); expect(ambiguous.inspection?.reason).toContain('Multiple compatible');
    t.templates.update(duplicate.template.id, x => { x.status = 'deleted'; });
    const compatibleBytes = await t.creative('#aaccee', babyPhone, babyCapture);
    (t.inspections.get(sha(compatibleBytes)) as ReturnType<typeof parseStructure>).confidence = 0.87;
    const compatible = await t.detect(compatibleBytes);
    expect(compatible.inspection?.outcome).toBe('compatible'); expect(compatible.template).toEqual(first.template);
    t.templates.update(first.template!.id, x => { x.status = 'deleted'; });
    expect(() => t.service.proceed(compatible.id)).toThrow(/unavailable/);
    t.templates.create(id => ({ ...version, templateId: id, generationPrompt: { text: 'missing edit slot' } }));
    const invalid = await t.detect(await t.creative('#eeccaa', babyPhone, babyCapture));
    expect(invalid.template).toBeUndefined(); expect(invalid.inspection?.reason).toContain('Template validation failed');
    expect(t.plannerCalls).toHaveBeenCalledTimes(1); expect(t.imageEdits).not.toHaveBeenCalled();
  });
  it('TEST 1: a new installation has no templates at all', async () => {
    const t = await setup();
    expect(t.templates.list()).toEqual([]);
  });

  it('TEST 2: creating a template calls the planner exactly once (no separate prompt call, no image generation), decomposes the upload and saves a role-only template', async () => {
    const t = await setup(), baby = await t.creative('#336699', babyPhone, babyCapture);
    const { execution, created } = await t.start('CREATE_TEMPLATE', baby);
    expect(created).toBe(true);
    const done = await t.settled(execution.id);
    expect(done).toMatchObject({ state: 'done', template: { name: 'Subject Holding Product', version: 1 },
      usage: { plannerCalled: true, plannerCalls: 1, promptGenerationCalled: false, imageGenerationCalled: false, imageGenerationCalls: 0, generationPromptSource: 'planner', decompositionPlanSource: 'planner' } });
    expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    expect(t.imageEdits).not.toHaveBeenCalled();
    // The upload itself is what was decomposed.
    expect(t.decomposed.map(sha)).toEqual([sha(baby)]);
    const [template] = t.templates.list(), version = t.templates.current(template.id)!;
    expect(template).toMatchObject({ name: 'Subject Holding Product', currentVersion: 1, versions: [1], layerRoles: ['background', 'primary_subject', 'held_object'], thumbnail: 'thumbnail.png' });
    expect(version.structure.layers.map(l => [l.id, l.role, l.zone])).toEqual([['background', 'background', 'full-canvas'], ['primary_subject', 'primary_subject', 'center'], ['held_object', 'held_object', 'bottom-right']]);
    expect(version.structure.layers[2].attachment).toMatchObject({ relation: 'held_in_hand', parent: 'primary_subject' });
    expect(version.structure.relationships).toEqual([{ source: 'primary_subject', relation: 'holds', target: 'held_object' }]);
    // Nothing of the source image is kept in the reusable template; its run keeps its own history.
    expect(JSON.stringify({ ...version, source: undefined })).not.toMatch(SOURCE_WORDS);
    expect(version.generationPrompt.text).toContain('{{edit_instruction}}');
    expect(JSON.stringify(t.runOf(done).planner!.semantic_analysis)).toMatch(/baby girl/);
    expect(t.logs).toEqual(expect.arrayContaining([expect.stringMatching(/^\[TEMPLATE\] creating new template/), expect.stringMatching(/^\[PLANNER\] invoked: template creation/),
      expect.stringMatching(/^\[GENERATION\] skipped: template creation decomposes the upload/), expect.stringMatching(/^\[DECOMPOSE\] using original uploaded image/), expect.stringMatching(/^\[TEMPLATE\] saved template=tpl-/)]));
  });

  it('TEST 3: REUSE_TEMPLATE_ORIGINAL makes zero planner, analysis and generation calls and decomposes the original upload with the saved plan', async () => {
    const t = await setup(), created = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const man = await t.creative('#a0522d'); // a man holding a football: the planner has no answer for it, and must not be asked
    const before = t.plannerCalls.mock.calls.length;
    const done = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', man, { templateId: created.template!.id })).execution.id);
    expect(done).toMatchObject({ state: 'done', template: created.template, usage: { plannerCalled: false, plannerCalls: 0, promptGenerationCalled: false, imageGenerationCalled: false, decompositionPlanSource: 'saved-template', generationPromptSource: 'saved-template' } });
    expect(t.plannerCalls).toHaveBeenCalledTimes(before);
    expect(t.imageEdits).not.toHaveBeenCalled();
    const run = t.runOf(done);
    expect(run.promptSource).toMatchObject({ mode: 'template-plan', templateId: created.template!.id, version: 1 });
    expect(run.calls).toMatchObject({ planner: 0, seedreamInitial: 1 });
    expect(run.templateExecution).toMatchObject({ mode: 'REUSE_TEMPLATE_ORIGINAL', template: { id: created.template!.id, version: 1 } });
    // Exactly the uploaded bytes went to decomposition, with a role-only plan.
    expect(sha(t.decomposed.at(-1)!)).toBe(sha(man));
    expect(t.seedreamPrompts.at(-1)).toMatch(/main person or character/);
    expect(t.seedreamPrompts.at(-1)).not.toMatch(SOURCE_WORDS);
    expect(t.templates.get(created.template!.id)!.stats).toMatchObject({ reuses: 1, edits: 0 });
    expect(t.logs).toEqual(expect.arrayContaining([expect.stringMatching(/^\[TEMPLATE\] reuse template=tpl-\w+ v1 mode=REUSE_TEMPLATE_ORIGINAL/), expect.stringMatching(/^\[PLANNER\] skipped: existing reusable plan/),
      expect.stringMatching(/^\[GENERATION\] skipped: no edit requested/), expect.stringMatching(/^\[DECOMPOSE\] using original uploaded image run=/)]));
  });

  it('TEST 4: REUSE_TEMPLATE_WITH_EDIT makes exactly one image edit from the saved prompt, zero planner calls, and decomposes the edited image', async () => {
    const t = await setup(), created = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const person = await t.creative('#556b2f'), before = t.plannerCalls.mock.calls.length;
    const done = await t.settled((await t.start('REUSE_TEMPLATE_WITH_EDIT', person, { templateId: created.template!.id, editInstruction: 'replace the product with a red bottle' })).execution.id);
    expect(done).toMatchObject({ state: 'done', usage: { plannerCalled: false, plannerCalls: 0, promptGenerationCalled: false, imageGenerationCalled: true, imageGenerationCalls: 1, generationPromptSource: 'saved-template' } });
    expect(t.plannerCalls).toHaveBeenCalledTimes(before);
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
    const prompt = t.imageEdits.mock.calls[0][0].prompt;
    expect(prompt).toContain('Make only this change: replace the product with a red bottle.');
    expect(prompt).toContain('the primary subject in the center, holding the held object');
    expect(prompt).not.toMatch(SOURCE_WORDS);
    // The edited image (not the upload) was decomposed, with the saved plan.
    const edited = readFileSync(t.executions.path(done.id, done.edit!.image!.file));
    expect(sha(t.decomposed.at(-1)!)).toBe(sha(edited));
    expect(sha(edited)).not.toBe(sha(person));
    expect(t.runOf(done)).toMatchObject({ promptSource: { mode: 'template-plan' }, calls: { planner: 0 } });
    expect(t.templates.get(created.template!.id)!.stats).toMatchObject({ reuses: 1, edits: 1 });
    expect(t.logs).toEqual(expect.arrayContaining([expect.stringMatching(/^\[GENERATION\] invoked: one image edit/), expect.stringMatching(/^\[DECOMPOSE\] using edited image/)]));
  });

  it('exact upload helpers remain available, while explicit creation and Plan fresh each make one planner call', async () => {
    const t = await setup(), bytes = await t.creative('#336699', babyPhone, babyCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    expect(first.state).toBe('done');
    const detected = await t.detect(bytes);
    t.service.proceed(detected.id);
    const second = await t.settled(detected.id);
    expect(second.template).toEqual(first.template);
    expect(second.usage.plannerCalls).toBe(0);
    expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    const fresh = await t.settled((await t.start('CREATE_TEMPLATE', bytes, { planFresh: true })).execution.id);
    expect(fresh.usage.plannerCalls).toBe(1);
    const explicit = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    expect(explicit.usage.plannerCalls).toBe(1);
    expect(t.plannerCalls).toHaveBeenCalledTimes(3);
    expect(t.templates.list()).toHaveLength(1);
  });

  it('TEST 5: a genuinely different structure creates a second template with exactly one more planner call', async () => {
    const t = await setup();
    await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const second = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#5b2c83', earbudsCta, earbudsCapture))).execution.id);
    expect(second).toMatchObject({ state: 'done', template: { name: 'Product + CTA + Background' }, usage: { plannerCalls: 1 } });
    expect(t.plannerCalls).toHaveBeenCalledTimes(2);
    expect(t.templates.list().map(x => x.name).sort()).toEqual(['Product + CTA + Background', 'Subject Holding Product']);
    expect(t.templates.current(second.template!.id)!.structure.layers.map(l => l.role)).toEqual(['background', 'main_product', 'cta']);
  });

  it('TEST 6: templates and executions survive a restart (a new store on the same folders)', async () => {
    const t = await setup(), done = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const restarted = await setup(t.root);
    expect(restarted.templates.list().map(x => x.id)).toEqual([done.template!.id]);
    expect(restarted.templates.version(done.template!.id, 1)).toEqual(t.templates.version(done.template!.id, 1));
    expect(restarted.executions.get(done.id).state).toBe('done');
    // And it is reused after the restart without the planner.
    const reuse = await restarted.settled((await restarted.start('REUSE_TEMPLATE_ORIGINAL', await restarted.creative('#a0522d'), { templateId: done.template!.id })).execution.id);
    expect(reuse).toMatchObject({ state: 'done', usage: { plannerCalls: 0 } });
    expect(restarted.plannerCalls).not.toHaveBeenCalled();
  });

  it('TEST 7: a failed creation leaves no template: planner failure, decomposition failure and an unusable capture', async () => {
    const t = await setup();
    // The planner has no answer for this image: it fails, nothing is decomposed, nothing saved.
    const plannerFailed = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#111111'))).execution.id);
    expect(plannerFailed).toMatchObject({ state: 'failed', error: { code: 'PLANNER_API_ERROR' } });
    // A capture without roles for every element.
    const partial = await t.creative('#222222', babyPhone, { ...babyCapture, roles: { blue_backdrop: 'background', baby_girl: 'primary_subject' } } as unknown as typeof babyCapture);
    expect(await t.settled((await t.start('CREATE_TEMPLATE', partial)).execution.id)).toMatchObject({ state: 'failed', error: { code: 'PLANNER_INVALID_JSON' } });
    expect(t.templates.list()).toEqual([]);
    expect(existsSync(join(t.root, 'templates')) ? readdirSync(join(t.root, 'templates')) : []).toEqual([]);
  });

  it('TEST 8: a repeated submission never starts a second execution (same key, or the same upload still running)', async () => {
    const t = await setup(), baby = await t.creative('#336699', babyPhone, babyCapture);
    const first = await t.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'double-click-1' });
    const again = await t.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'double-click-1' });
    const refreshed = await t.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'after-refresh-2' });
    expect([again.created, refreshed.created]).toEqual([false, false]);
    expect(new Set([first.execution.id, again.execution.id, refreshed.execution.id]).size).toBe(1);
    await t.settled(first.execution.id);
    expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    expect(t.templates.list()).toHaveLength(1);
    // A key reused for another request is refused, not mistaken for it.
    await expect(t.start('CREATE_TEMPLATE', await t.creative('#999999'), { idempotencyKey: 'double-click-1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('work a restart left behind never swallows a new submission of the same upload; a repeated key still returns it', async () => {
    const t = await setup(), baby = await t.creative('#336699', babyPhone, babyCapture);
    const release = t.hold();
    const first = await t.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'before-restart-1' });
    // A new process on the same folders: the unfinished execution is no longer anyone's work.
    const restarted = await setup(t.root);
    const retried = await restarted.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'after-restart-2' });
    expect(retried.created).toBe(true); expect(retried.execution.id).not.toBe(first.execution.id);
    expect((await restarted.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'before-restart-1' })).execution.id).toBe(first.execution.id);
    // The process that owns it still treats a refresh as the same execution.
    expect((await t.start('CREATE_TEMPLATE', baby, { idempotencyKey: 'refresh-3' })).execution.id).toBe(first.execution.id);
    release();
    await Promise.all([t.settled(first.execution.id), restarted.settled(retried.execution.id)]);
  });

  it('refuses requests a mode does not allow, before anything is stored or sent', async () => {
    const t = await setup(), done = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id), image = await t.creative('#444444');
    const id = done.template!.id;
    await expect(t.start('CREATE_TEMPLATE', image, { templateId: id })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(t.start('REUSE_TEMPLATE_ORIGINAL', image, { templateId: id, editInstruction: 'make it red' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', image, { templateId: id })).rejects.toMatchObject({ code: 'INVALID_EDIT_INSTRUCTION' });
    await expect(t.start('REUSE_TEMPLATE_ORIGINAL', image, { templateId: 'tpl-000000000000' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    await expect(t.start('SOMETHING_ELSE', image)).rejects.toMatchObject({ code: 'INVALID_MODE' });
    await expect(t.start('CREATE_TEMPLATE', Buffer.from('not an image'))).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    expect(t.executions.list()).toHaveLength(1);
    expect(EXECUTION_POLICY.REUSE_TEMPLATE_ORIGINAL).toMatchObject({ planner: false, promptGeneration: false, imageGeneration: false });
    expect(EXECUTION_POLICY.REUSE_TEMPLATE_WITH_EDIT).toMatchObject({ planner: false, promptGeneration: false, imageGeneration: true });
  });

  it('pins the version an execution started with; a newer version never changes it, and a missing one fails safely', async () => {
    const t = await setup(), done = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id), id = done.template!.id;
    const v1 = t.templates.version(id, 1)!;
    t.templates.addVersion(id, version => ({ ...v1, version, createdAt: new Date().toISOString(), name: 'Subject Holding Product (revised)' }));
    expect(t.templates.version(id, 1)).toEqual(v1);
    const reuse = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', await t.creative('#a0522d'), { templateId: id })).execution.id);
    expect(reuse.template).toMatchObject({ id, version: 2 });
    expect(t.runOf(reuse).promptSource).toMatchObject({ mode: 'template-plan', version: 2 });
    expect(t.executions.get(done.id).template).toMatchObject({ version: 1 });
    // A version file removed while the execution waits its turn: it fails before any call.
    const release = t.hold(), pending = await t.start('REUSE_TEMPLATE_ORIGINAL', await t.creative('#654321'), { templateId: id });
    unlinkSync(join(t.root, 'templates', id, 'v2.json'));
    release();
    expect(await t.settled(pending.execution.id)).toMatchObject({ state: 'failed', error: { code: 'STALE_TEMPLATE_VERSION' } });
  });
});

describe('the key acceptance, false matches, provider failures and resume', { timeout: 30_000 }, () => {
  it('KEY ACCEPTANCE: same-structure second image → same template → saved generation template → saved decomposition plan → GPT planner calls = 0', async () => {
    const t = await setup(), created = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id), id = created.template!.id;
    expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    const before = t.plannerCalls.mock.calls.length;
    // A man holding a football: the same structure, different content. No edit, then an edit.
    const original = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', await t.creative('#a0522d'), { templateId: id })).execution.id);
    const edited = await t.settled((await t.start('REUSE_TEMPLATE_WITH_EDIT', await t.creative('#8b4513'), { templateId: id, editInstruction: 'replace the held object with a basketball' })).execution.id);
    for (const execution of [original, edited]) {
      expect(execution.template).toEqual(created.template);
      expect(execution.usage).toMatchObject({ plannerCalled: false, plannerCalls: 0, promptGenerationCalled: false, decompositionPlanSource: 'saved-template' });
      expect(t.runOf(execution)).toMatchObject({ promptSource: { mode: 'template-plan', templateId: id, version: 1 }, calls: { planner: 0 } });
    }
    expect([original.usage.generationPromptSource, edited.usage.generationPromptSource]).toEqual(['saved-template', 'saved-template']);
    expect(t.plannerCalls).toHaveBeenCalledTimes(before);
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
    expect(t.templates.list()).toHaveLength(1);
  });

  it('flags a template picked for a different structure (false match) instead of passing it off as a good reuse', async () => {
    const t = await setup(), created = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id), id = created.template!.id;
    // The right structure: Seedream returns a person and the object they hold.
    const man = await t.creative('#a0522d');
    t.seedreamLayers.set(sha(man), [{ name: 'Man in a blue shirt', left: 200, top: 150, size: 320 }, { name: 'Football', left: 420, top: 520, size: 140 }]);
    const good = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', man, { templateId: id })).execution.id);
    expect(good.warnings.filter(w => w.startsWith('TEMPLATE_LAYERS_MISSING'))).toEqual([]);
    // Another structure (earbuds and a button, no person): every planned role is checked, the mismatch is reported.
    const earbuds = await t.creative('#5b2c83');
    t.seedreamLayers.set(sha(earbuds), [{ name: 'White earbuds case', left: 220, top: 200, size: 260 }, { name: 'Buy Now button', left: 240, top: 620, size: 120 }]);
    const wrong = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', earbuds, { templateId: id })).execution.id);
    expect(wrong.state).toBe('done');
    expect(wrong.warnings.join(' ')).toMatch(/TEMPLATE_LAYERS_MISSING: Selected template may not fit this image\. No layer matched primary_subject.*create a new template from it/);
    // Reported, never "fixed" by calling the planner behind the user's back.
    expect(wrong.usage.plannerCalls).toBe(0);
  });

  it('a fal failure after submission is resumed from the saved request (no new call), and the template is saved then', async () => {
    const t = await setup(), baby = await t.creative('#336699', babyPhone, babyCapture);
    t.failures.result = [new Error('network down')];
    const failed = await t.settled((await t.start('CREATE_TEMPLATE', baby)).execution.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'FAL_RESULT_FAILED' } });
    expect(t.templates.list()).toEqual([]);
    const submissions = t.seedreamPrompts.length;
    expect(t.service.resume(failed.id).state).toBe('decomposing');
    const done = await t.settled(failed.id);
    expect(done).toMatchObject({ state: 'done', template: { name: 'Subject Holding Product', version: 1 }, usage: { plannerCalls: 1 } });
    expect(t.seedreamPrompts).toHaveLength(submissions);
    expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    expect(t.templates.list()).toHaveLength(1);
    expect(() => t.service.resume(done.id)).toThrow(/cannot be resumed/);
  });

  it('a decomposition the provider rejects fails the execution, saves no template, and is not resumable', async () => {
    const t = await setup(), baby = await t.creative('#336699', babyPhone, babyCapture);
    t.failures.result = [Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, requestId: 'r1', messages: [{ msg: 'The provided image could not be processed for layer decomposition.', type: 'invalid_request' }] } })];
    const failed = await t.settled((await t.start('CREATE_TEMPLATE', baby)).execution.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED' } });
    expect(t.templates.list()).toEqual([]);
    expect(() => t.service.resume(failed.id)).toThrow(/cannot be resumed/);
  });
});

const rejection422 = (requestId: string) => {
  const error = Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request.', false, 422), {
    providerDetail: { status: 422, billableUnits: '0', requestId, messages: [{ msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request', loc: 'body.image_url' }] } });
  Object.defineProperty(error, 'providerBody', { value: { status: 422, headers: { date: new Date().toUTCString(), 'x-fal-billable-units': '0' }, body: { detail: [] } }, enumerable: false });
  return error;
};

describe('product replacement, plan decisions and extraction recovery (offline fakes: control flow, not live image quality)', { timeout: 30_000 }, () => {
  /** An earbuds template, and a generated image the fakes know (so a refreshed plan has a planner answer for it). */
  async function earbuds() {
    const t = await setup(), source = await t.creative('#eeeeee', earbudsCta, earbudsCapture, 1000);
    const created = await t.settled((await t.start('CREATE_TEMPLATE', source)).execution.id);
    const version = t.templates.current(created.template!.id)!;
    const generated = await t.creative('#204060', earbudsCta, earbudsCapture, 1000);
    // As a real model answers: at the requested canvas size (the result is mapped back to the source's own size).
    t.imageEdits.mockImplementation(async (request: { size: string }) => { const [w, h] = request.size.split('x').map(Number);
      return { data: [{ b64_json: (await sharp(generated).resize(w, h, { fit: 'fill' }).png().toBuffer()).toString('base64') }], usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { image_tokens: 800, text_tokens: 200, cached_tokens: 0 } } }; });
    const generate = async (values: Record<string, string>, extra: Parameters<typeof t.start>[2] = {}) => {
      const { execution } = await t.start('REUSE_TEMPLATE_WITH_EDIT', source, { templateId: version.templateId, values, reviewBeforeDecompose: true, ...extra });
      await vi.waitFor(() => expect(['generated', 'failed']).toContain(t.executions.get(execution.id).state));
      return t.executions.get(execution.id);
    };
    return { t, source, version, generated, generate };
  }

  it('earbuds → BOAT SPEAKER: the prompt sent replaces the product, an optional reference goes as the second image, and the plan waits for a decision', async () => {
    const { t, version, generate } = await earbuds();
    const reference = await png(300, 300, '#111111');
    const speaker = await generate({ main_product: 'SPEAKER' }, { options: { mainProduct: { brand: 'BOAT' } }, productReference: { bytes: reference, fileName: 'speaker.png', mimeType: 'image/png' } });
    expect(speaker.state).toBe('generated');
    const compiled = compileTemplateEdit(version, { main_product: 'SPEAKER' }, { mainProduct: { brand: 'BOAT' }, productReference: true });
    expect(speaker.edit!.prompt).toBe(compiled.text);
    expect(speaker.edit!.prompt).toContain('Replace the main product in the center with "BOAT SPEAKER". Remove the original main product completely');
    expect(speaker.edit!.prompt).not.toContain('Do not add or remove elements');
    // The reference is stored with its hash and sent as the second image of the one edit request.
    expect(speaker.edit!.reference).toMatchObject({ file: 'product-reference.png', sha256: sha(reference) });
    expect(readFileSync(t.executions.path(speaker.id, speaker.edit!.reference!.file))).toEqual(reference);
    const sent = t.imageEdits.mock.calls.at(-1)![0] as unknown as { image: unknown[] };
    expect(Array.isArray(sent.image) && sent.image.length).toBe(2);
    expect(speaker).toMatchObject({ editOptions: { mainProduct: { brand: 'BOAT' } }, compatibility: { status: 'structural-change', changedSlots: ['main_product'] }, usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
    // Nothing is decomposed until the image is reviewed and a plan is chosen.
    const prompts = t.seedreamPrompts.length;
    expect(() => t.service.decompose(speaker.id)).toThrow(expect.objectContaining({ code: 'REVIEW_REQUIRED' }));
    expect(() => t.service.decompose(speaker.id, { acknowledgeReview: true })).toThrow(expect.objectContaining({ code: 'PLAN_DECISION_REQUIRED', message: expect.stringMatching(/one planner call/) }));
    expect(() => t.service.decompose(speaker.id, { acknowledgeReview: true, plan: 'whatever' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(t.seedreamPrompts).toHaveLength(prompts); expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    // A reference only goes with template fields, and only when an image is generated.
    await expect(t.start('REUSE_TEMPLATE_ORIGINAL', await png(1000, 800, '#eeeeee'), { templateId: version.templateId, productReference: { bytes: reference } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', await png(1000, 800, '#eeeeee'), { templateId: version.templateId, editInstruction: 'make it a speaker', productReference: { bytes: reference } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', await png(1000, 800, '#eeeeee'), { templateId: version.templateId, values: { main_product: 'x' }, options: { mainProduct: { mode: 'swap' } }, reviewBeforeDecompose: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // A photo of a product never travels with a background-only change, or with a main product only changed in detail.
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', await png(1000, 800, '#eeeeee'), { templateId: version.templateId, values: { background: 'teal' }, productReference: { bytes: reference }, reviewBeforeDecompose: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('replaced main product') });
    await expect(t.start('REUSE_TEMPLATE_WITH_EDIT', await png(1000, 800, '#eeeeee'), { templateId: version.templateId, values: { main_product: 'matte' }, options: { mainProduct: { mode: 'details' } }, productReference: { bytes: reference }, reviewBeforeDecompose: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(t.imageEdits).toHaveBeenCalledTimes(1);
  });

  it('refreshing the plan is one explicit planner call on exactly the approved image; a background-only change reuses the saved plan with zero', async () => {
    const { t, generate } = await earbuds();
    const speaker = await generate({ main_product: 'Bluetooth speaker' });
    t.service.decompose(speaker.id, { acknowledgeReview: true, plan: 'refresh' }); t.service.decompose(speaker.id, { acknowledgeReview: true, plan: 'refresh' });
    const refreshed = await t.settled(speaker.id);
    expect(refreshed).toMatchObject({ state: 'done', planDecision: { choice: 'refresh' }, usage: { plannerCalls: 1, imageGenerationCalls: 1, decompositionPlanSource: 'planner' } });
    expect(t.plannerCalls).toHaveBeenCalledTimes(2);
    expect(t.runOf(refreshed).templateExecution).toMatchObject({ plan: 'refresh', planRefresh: true, input: { source: 'approved-generated', sha256: speaker.edit!.image!.sha256 } });
    expect(t.decomposed.at(-1)).toEqual(readFileSync(t.executions.path(speaker.id, speaker.edit!.image!.file)));
    // A recolor keeps the saved plan: no decision asked, planner 0.
    const recolor = await generate({ background: 'warm yellow gradient' });
    expect(recolor.compatibility).toMatchObject({ status: 'compatible' });
    t.service.decompose(recolor.id, recolor.edit!.review?.requiresAcknowledgement ? { acknowledgeReview: true } : {});
    const reused = await t.settled(recolor.id);
    expect(reused).toMatchObject({ state: 'done', usage: { plannerCalls: 0, decompositionPlanSource: 'saved-template' } });
    expect(reused.planDecision).toBeUndefined();
    expect(t.plannerCalls).toHaveBeenCalledTimes(2);
  });

  it('decomposes only the approved image: a changed file on disk is refused before anything is uploaded', async () => {
    const { t, generate } = await earbuds();
    const recolor = await generate({ background: 'teal' });
    writeFileSync(t.executions.path(recolor.id, recolor.edit!.image!.file), await png(1000, 800, '#ff0000'));
    const uploads = t.decomposed.length;
    t.service.decompose(recolor.id, { acknowledgeReview: true });
    const refused = await t.settled(recolor.id);
    expect(refused).toMatchObject({ state: 'failed', error: { code: 'INPUT_IDENTITY_MISMATCH', state: 'decomposing' } });
    expect(refused.runId).toBeUndefined();
    expect(t.decomposed).toHaveLength(uploads);
  });

  it('a fal 422 keeps the generated creative, is not resumed or retried on its own, and an explicit retry with a simpler grouping is one new Seedream request', async () => {
    const { t, generate } = await earbuds();
    const recolor = await generate({ background: 'teal' });
    const image = readFileSync(t.executions.path(recolor.id, recolor.edit!.image!.file)), prompts = t.seedreamPrompts.length;
    t.failures.result = [rejection422('req-422')];
    t.service.decompose(recolor.id, { acknowledgeReview: true });
    const failed = await t.settled(recolor.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', state: 'decomposing', message: expect.stringContaining('layer-extraction failure, not an image-generation failure: any generated creative is kept') } });
    expect(failed.error!.message).toContain('Seedream did not produce a valid decomposition'); expect(failed.error!.message).not.toContain('at intake');
    expect(t.runOf(failed).error).toMatchObject({ provider: { requestId: 'req-422', billableUnits: '0' } });
    // The generated creative is untouched, nothing ran again, and Resume cannot repeat the stored answer.
    expect(failed.edit!.image).toEqual(recolor.edit!.image);
    expect(readFileSync(t.executions.path(recolor.id, recolor.edit!.image!.file))).toEqual(image);
    expect(t.seedreamPrompts).toHaveLength(prompts + 1);
    expect(() => t.service.resume(failed.id)).toThrow();
    await new Promise(done => setTimeout(done, 50));
    expect(t.seedreamPrompts).toHaveLength(prompts + 1); expect(t.imageEdits).toHaveBeenCalledTimes(1);
    // An explicit retry: a choice of plan, the same image, one new request; a double-click is refused while it runs.
    expect(() => t.service.retryExtraction(failed.id, { plan: 'bogus' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    t.service.retryExtraction(failed.id, { plan: 'simple' });
    expect(() => t.service.retryExtraction(failed.id, { plan: 'simple' })).toThrow(expect.objectContaining({ code: 'BUSY' }));
    const retried = await t.settled(failed.id);
    expect(retried).toMatchObject({ state: 'done', planDecision: { choice: 'simple' }, extractionAttempts: [{ runId: failed.runId, plan: 'saved', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED' } }], usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
    expect(retried.runId).not.toBe(failed.runId);
    expect(t.runOf(retried).templateExecution).toMatchObject({ plan: 'simple', input: { source: 'approved-generated', sha256: recolor.edit!.image!.sha256 } });
    expect(t.seedreamPrompts).toHaveLength(prompts + 2); expect(t.imageEdits).toHaveBeenCalledTimes(1); expect(t.plannerCalls).toHaveBeenCalledTimes(1);
    expect(t.decomposed.at(-1)).toEqual(image);
    // Only a failed extraction is retryable.
    expect(() => t.service.retryExtraction(retried.id, { plan: 'saved' })).toThrow(expect.objectContaining({ code: 'NOT_RETRYABLE' }));
  });

  it('a failed generation or a failed template creation is never offered as an extraction retry', async () => {
    const { t, generate } = await earbuds();
    t.imageEdits.mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }));
    const failed = await generate({ background: 'teal' });
    expect(failed).toMatchObject({ state: 'failed', error: { state: 'generating' } });
    expect(() => t.service.retryExtraction(failed.id, { plan: 'saved' })).toThrow(expect.objectContaining({ code: 'NOT_RETRYABLE' }));
    const other = await t.creative('#123456', babyPhone, babyCapture);
    t.failures.result = [rejection422('req-create')];
    const creation = await t.settled((await t.start('CREATE_TEMPLATE', other)).execution.id);
    expect(creation.state).toBe('failed');
    expect(() => t.service.retryExtraction(creation.id, { plan: 'refresh' })).toThrow(expect.objectContaining({ code: 'NOT_RETRYABLE' }));
  });
});

/** The template routes over a setup's stores and service, with the experiment's error mapping. */
async function serve(t: Awaited<ReturnType<typeof setup>>) {
  const router = express.Router();
  registerCreativeTemplateRoutes(router, { templates: t.templates, executions: t.executions, service: t.service, runsDir: t.runsDir, runState: () => undefined });
  router.use(((error: unknown, _req, res, _next) => { void _next; const code = error instanceof RunError ? error.code : 'INTERNAL';
    res.status(code === 'NOT_FOUND' || code === 'TEMPLATE_NOT_FOUND' ? 404 : error instanceof RunError ? 400 : 500).json({ error: { code, message: error instanceof Error ? error.message : '' } }); }) as express.ErrorRequestHandler);
  const server = express().use('/x', router).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(`${base}${path}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  return { call, close: () => server.close() };
}

describe('Create New Template with an interleaved product part (live 422, request 01a11a94-…)', { timeout: 30_000 }, () => {
  it('sends Seedream a possible layer order: the case lid stays its own layer behind the seated earbud, never merged into the base in front of it', async () => {
    const t = await setup(), bytes = await t.creative('#c9b6e4', interleavedPartFixture, interleavedCapture as never);
    const created = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    expect(t.plannerCalls).toHaveBeenCalledTimes(1); expect(t.seedreamPrompts).toHaveLength(1);
    expect(created.state, JSON.stringify(created.error)).toBe('done');
    const sent = t.seedreamPrompts[0];
    // Before: "Create 7 layers … (5) right-side earbud … (6) … case base … together with case shadow, case lid in the same layer".
    expect(sent).toMatch(/^Create 8 layers back-to-front: /);
    expect(sent).not.toContain('case lid in the same layer');
    expect(sent.indexOf('Open rear lid and hinge')).toBeGreaterThan(0);
    expect(sent.indexOf('Open rear lid and hinge')).toBeLessThan(sent.indexOf('Right-side earbud'));
    expect(sent.indexOf('Right-side earbud')).toBeLessThan(sent.indexOf('Large foreground charging-case base'));
    expect(t.runOf(created).planner).toMatchObject({ semantic_protection: { keptApart: [{ id: 'case_lid', parent: 'case_base', between: 'seated_earbud' }] } });
  });
});

describe('template CRUD: view, edit, version, delete — saved runs keep their history', { timeout: 30_000 }, () => {
  it('views a template with its versions and health; renames with validation that persists across a restart', async () => {
    const t = await setup(), created = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const id = created.template!.id, api = await serve(t);
    try {
      const view = await api.call('GET', `/templates/${id}`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ template: { id, currentVersion: 1 }, version: { version: 1 }, versions: [{ version: 1, runs: 1 }], health: { status: 'ok', checkedRuns: 1 } });
      expect((await api.call('PATCH', `/templates/${id}`, { name: '  Summer   hero  ', description: 'A person holding something.' })).body).toMatchObject({ name: 'Summer hero', description: 'A person holding something.' });
      for (const [body, code] of [[{ name: '' }, 'INVALID_NAME'], [{ name: 'x'.repeat(61) }, 'INVALID_NAME'], [{ name: '<b>Hero</b>' }, 'INVALID_REQUEST'], [{ description: 'd'.repeat(241) }, 'INVALID_REQUEST'], [{ status: 'deleted' }, 'INVALID_REQUEST'], [{}, 'NO_CHANGE']] as const)
        expect((await api.call('PATCH', `/templates/${id}`, body)).body.error.code, JSON.stringify(body)).toBe(code);
      // A new store on the same folder (a restart): the edit is there, the version untouched.
      const restarted = fileTemplateStore(join(t.root, 'templates'));
      expect(restarted.get(id)).toMatchObject({ name: 'Summer hero', versions: [1] });
      expect(restarted.version(id, 1)!.name).toBe(created.template!.name);
    } finally { api.close(); }
  });

  it('plan settings become a new version (planner 0); earlier versions and their runs are unchanged; stale or empty edits are refused', async () => {
    const t = await setup(), first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const learned = t.templates.current(first.template!.id)!;
    // A template whose structure has separable layers: a backdrop and a decoration around the subject.
    const structure: TemplateStructure = { relationships: [], layers: [
      { id: 'background', role: 'background', zone: 'full-canvas', order: 0, independent: true, required: false },
      { id: 'backdrop', role: 'backdrop', zone: 'center', order: 1, independent: true, required: false },
      { id: 'decoration', role: 'decoration', order: 2, independent: true, required: false },
      { id: 'primary_subject', role: 'primary_subject', zone: 'center', order: 3, independent: true, required: true }] };
    const { template } = t.templates.create(templateId => ({ ...learned, templateId, structure, plan: { ...learned.plan, prompt: templatePlanPrompt(structure), strategy: templatePlanStrategy(structure), recommendedLayers: 4 } }));
    const reused = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', await t.creative('#336699', babyPhone, babyCapture), { templateId: template.id, allowMismatch: true })).execution.id);
    const v1 = readFileSync(join(t.root, 'templates', template.id, 'v1.json'), 'utf8'), api = await serve(t), plannerCalls = t.plannerCalls.mock.calls.length;
    try {
      await api.call('PATCH', `/templates/${template.id}`, { name: 'Panel hero' });
      const folded = await api.call('POST', `/templates/${template.id}/versions`, { fromVersion: 1, separateLayers: { backdrop: false }, expectedEditorLayers: { min: 2, max: 6 }, refinement: true });
      expect(folded.status).toBe(201);
      expect(folded.body.template).toMatchObject({ name: 'Panel hero', currentVersion: 2, versions: [1, 2] });
      const v2: TemplateVersion = folded.body.version;
      expect(v2).toMatchObject({ version: 2, name: 'Panel hero', derivedFrom: { version: 1, reason: 'settings', change: expect.stringContaining('backdrop: kept with another layer') }, decomposition: { expectedEditorLayers: { min: 2, max: 6 } } });
      expect(v2.structure.layers.find(l => l.id === 'backdrop')).toMatchObject({ independent: false, attachment: { relation: 'part_of_object', parent: 'background', keepWithParent: true } });
      expect(v2.plan.recommendedLayers).toBe(3);
      expect(compileTemplatePlan(v2).prompt).not.toBe(compileTemplatePlan(t.templates.version(template.id, 1)!).prompt);
      // Back to its own layer: v3, with the fold removed.
      const separate = await api.call('POST', `/templates/${template.id}/versions`, { fromVersion: 2, separateLayers: { backdrop: true } });
      expect(separate.body.version.structure.layers.find((l: { id: string }) => l.id === 'backdrop')).toEqual(expect.objectContaining({ independent: true }));
      expect(separate.body.version.structure.layers.find((l: { id: string }) => l.id === 'backdrop').attachment).toBeUndefined();
      for (const [body, code] of [[{ fromVersion: 1, refinement: true }, 'STALE_TEMPLATE_VERSION'], [{ separateLayers: { backdrop: true } }, 'NO_CHANGE'],
        [{ separateLayers: { primary_subject: false } }, 'INVALID_REQUEST'], [{ separateLayers: { nothing: false } }, 'INVALID_REQUEST'], [{ expectedEditorLayers: { min: 5, max: 2 } }, 'INVALID_REQUEST'], [{ colour: 'red' }, 'INVALID_REQUEST']] as const)
        expect((await api.call('POST', `/templates/${template.id}/versions`, body)).body.error.code, JSON.stringify(body)).toBe(code);
      // History: v1 is byte-identical, the run that used it still names v1 and reads it, and no planner was called.
      expect(readFileSync(join(t.root, 'templates', template.id, 'v1.json'), 'utf8')).toBe(v1);
      expect(t.executions.get(reused.id).template).toMatchObject({ version: 1 });
      expect((await api.call('GET', `/templates/${template.id}/versions/1`)).body).toEqual(JSON.parse(v1));
      expect((await api.call('GET', `/templates/${template.id}`)).body.versions).toEqual([{ version: 1, createdAt: expect.any(String), runs: 1 },
        { version: 2, createdAt: expect.any(String), derivedFrom: expect.objectContaining({ reason: 'settings' }), runs: 0 }, { version: 3, createdAt: expect.any(String), derivedFrom: expect.objectContaining({ version: 2 }), runs: 0 }]);
      expect(t.plannerCalls.mock.calls.length).toBe(plannerCalls);
    } finally { api.close(); }
  });

  it('deleting a template removes it from the library and new work, never its saved runs, images or versions', async () => {
    const t = await setup(), bytes = await t.creative('#336699', babyPhone, babyCapture);
    const first = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id), id = first.template!.id;
    const reused = await t.settled((await t.start('REUSE_TEMPLATE_ORIGINAL', bytes, { templateId: id })).execution.id), api = await serve(t);
    try {
      expect((await api.call('DELETE', `/templates/${id}`)).body).toMatchObject({ id, status: 'deleted' });
      expect((await api.call('GET', '/templates')).body.templates).toEqual([]);
      expect((await api.call('GET', `/templates/${id}`)).status).toBe(404);
      expect((await api.call('PATCH', `/templates/${id}`, { name: 'Again' })).status).toBe(404);
      await expect(t.start('REUSE_TEMPLATE_ORIGINAL', bytes, { templateId: id })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
      // Saved runs keep everything: the execution, its pinned version, its run and its layers.
      const shown = await api.call('GET', `/template-executions/${reused.id}`);
      expect(shown.body).toMatchObject({ state: 'done', template: { id, version: 1 }, runId: reused.runId });
      expect((await api.call('GET', `/templates/${id}/versions/1`)).status).toBe(200);
      expect(existsSync(join(t.runsDir, reused.runId!, 'run.json'))).toBe(true);
      expect(t.runOf(reused).outputLayers!.length).toBeGreaterThan(1);
    } finally { api.close(); }
  });

  it('an explicit new plan of the source creative is the template\'s next version (one planner call), never a second template', async () => {
    const t = await setup(), first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id), id = first.template!.id;
    t.templates.update(id, x => { x.name = 'Renamed by the user'; });
    const planner = t.plannerCalls.mock.calls.length, api = await serve(t);
    try {
      expect((await api.call('POST', `/templates/${id}/replan`, {})).body.error.code).toBe('INVALID_REQUEST');
      // A double-click: both requests carry the same key and start one execution.
      const [started, twice] = await Promise.all([api.call('POST', `/templates/${id}/replan`, { idempotencyKey: 'replan-key-1' }), api.call('POST', `/templates/${id}/replan`, { idempotencyKey: 'replan-key-1' })]);
      expect([started.status, twice.status].sort()).toEqual([200, 202]);
      expect(twice.body.id).toBe(started.body.id);
      expect(started.body).toMatchObject({ mode: 'CREATE_TEMPLATE', plannerReason: 'plan-fresh', updatesTemplate: { id, fromVersion: 1 } });
      const done = await t.settled(started.body.id);
      expect(done).toMatchObject({ state: 'done', template: { id, version: 2 }, usage: { plannerCalls: 1 } });
      expect(t.plannerCalls.mock.calls.length).toBe(planner + 1);
      expect(t.templates.list()).toHaveLength(1);
      expect(t.templates.get(id)).toMatchObject({ name: 'Renamed by the user', versions: [1, 2], currentVersion: 2 });
      expect(t.templates.version(id, 2)).toMatchObject({ name: 'Renamed by the user', derivedFrom: { version: 1, reason: 'replan' }, source: { executionId: done.id } });
    } finally { api.close(); }
  });

  it('health reads the template\'s runs: a backdrop shape the plan does not name, or a lost planned layer, marks the plan incomplete', async () => {
    const t = await setup(), first = await t.settled((await t.start('CREATE_TEMPLATE', await t.creative('#336699', babyPhone, babyCapture))).execution.id);
    const version = t.templates.current(first.template!.id)!, run = (e: Partial<TemplateExecution>) => ({ ...first, id: `e-${Math.random()}`, mode: 'REUSE_TEMPLATE_ORIGINAL', state: 'done', runId: 'r', template: first.template, warnings: [], createdAt: '2026-10-08T07:00:00.000Z', ...e }) as TemplateExecution;
    expect(await templateHealth(version, t.runsDir, [run({})])).toMatchObject({ status: 'ok', issues: [], checkedRuns: 2 });
    const incomplete = await templateHealth(version, t.runsDir, [run({ warnings: ['TEMPLATE_PLAN_INCOMPLETE: the saved plan does not name "Rounded panel"; it was kept as a separate layer.'] })]);
    expect(incomplete).toMatchObject({ status: 'plan-incomplete', issues: [expect.stringContaining('Run of 2026-10-08: the saved plan does not name "Rounded panel"')] });
    expect(await templateHealth({ ...version, source: { ...version.source, runId: 'missing' } }, t.runsDir, [])).toMatchObject({ status: 'unknown', checkedRuns: 0 });
  });
});

describe('content-agnostic capture and compile', () => {
  it('keeps the planner\'s structural name only when it carries none of the image\'s content', () => {
    const run = { id: 'run', stage: 'done', refinement: { state: 'done', planCoverage: { complete: true, planned: ['baby_girl', 'gold_iphone'], matched: { baby_girl: 'person.png', gold_iphone: 'object.png' } }, background: { quality: 'usable', contaminated: false } }, planner: { model: 'gpt-5.6-sol', durationMs: 1, prompt: babyPhone.downstream_decomposition_prompt, planned_layers: [], warnings: [], semantic_analysis: babyPhone,
      capture: { ...babyCapture, name: 'Baby Girl with iPhone', description: 'A baby girl holding an iPhone.' } } } as unknown as RunRecord;
    const version = captureTemplateVersion(run, { templateId: 'tpl-aaaaaaaaaaaa', executionId: 'exec' });
    expect([version.name, version.description]).toEqual(['Subject Holding Product', 'A composition of background, primary subject, held object.']);
    expect(leakedContent(JSON.stringify({ ...version, source: undefined }), contentWords([babyPhone.scene_summary, ...babyPhone.elements.map(e => e.description)]))).toEqual([]);
    // A compiled plan is what a planner answer would be: protected, validated, with a role-only prompt.
    const plan = compileTemplatePlan(version, '2026-10-08T00:00:00.000Z');
    expect(plan).toMatchObject({ mode: 'template-plan', templateId: 'tpl-aaaaaaaaaaaa', version: 1, planned_layers: [{ name: 'background' }, { name: 'primary_subject' }, { name: 'held_object' }] });
    expect(plan.prompt).toMatch(/^Create 3 layers back-to-front: \(1\) the full scene or surface behind every other element across the whole canvas; \(2\) the main person or character/);
    expect(plan.prompt).toMatch(/Keep every person whole/);
  });
  it('does not activate a template when required foreground or background is unverified', async () => {
    const t = await setup(), bytes = await t.creative('#336699', babyPhone, babyCapture);
    t.seedreamLayers.set(sha(bytes), []);
    const done = await t.settled((await t.start('CREATE_TEMPLATE', bytes)).execution.id);
    expect(done).toMatchObject({ state: 'failed', error: { code: 'TEMPLATE_CAPTURE_FAILED' } });
    expect(t.templates.list()).toEqual([]);
  });

  it('names where a layer continues behind others (its saved occlusion) in role words, only in versions saved with that wording', () => {
    const structure: TemplateStructure = { relationships: [], layers: [
      { id: 'background', role: 'background', zone: 'full-canvas', order: 0, independent: true, required: false, occlusion: { occludedBy: ['backdrop', 'main_product'], requiresReconstruction: true } },
      { id: 'backdrop', role: 'backdrop', order: 1, independent: true, required: false, occlusion: { occludedBy: ['decoration', 'main_product', 'supporting_product', 'supporting_product_2'], requiresReconstruction: true } },
      { id: 'decoration', role: 'decoration', zone: 'middle-left', order: 2, independent: true, required: false, occlusion: { occludedBy: ['main_product'], requiresReconstruction: false } },
      { id: 'main_product', role: 'main_product', order: 3, independent: true, required: true, occlusion: { occludedBy: ['supporting_product_2'], requiresReconstruction: true } },
      { id: 'supporting_product', role: 'supporting_product', zone: 'top-left', order: 4, independent: true, required: false },
      { id: 'supporting_product_2', role: 'supporting_product', zone: 'top-center', order: 5, independent: true, required: false }] };
    const worded = templatePlanPrompt(structure, true);
    expect(worded).toContain('(4) the main advertised product, whole, including where it is behind the supporting product at the top;');
    expect(worded).toContain('including where it is behind the decorations on the left, the main product and the supporting product layers;');
    // The base canvas, and a layer whose hidden part is not rebuilt, are not asked to continue behind anything.
    expect(worded.match(/including where it is behind/g)).toHaveLength(2);
    // Versions saved before the wording existed compile exactly as they were saved.
    expect(templatePlanPrompt(structure)).not.toContain('including where it is behind');
    const version = { templateId: 'tpl-cccccccccccc', version: 1, createdAt: '2026-10-08T00:00:00.000Z', name: 'Products on a backdrop', description: 'Products in front of a backdrop.', structure,
      plan: { prompt: templatePlanPrompt(structure), strategy: templatePlanStrategy(structure), recommendedLayers: 6 }, generationPrompt: { text: `Edit: ${EDIT_INSTRUCTION_SLOT}.` },
      decomposition: { refinement: true, expectedEditorLayers: { min: 2, max: 8 } }, source: { runId: 'r', executionId: 'e', plannerModel: 'offline' } } satisfies TemplateVersion;
    expect(compileTemplatePlan(version).prompt).not.toContain('including where it is behind');
    expect(compileTemplatePlan({ ...version, plan: { ...version.plan, prompt: worded, occlusionWording: true } }).prompt).toContain('whole, including where it is behind the supporting product at the top');
  });

  it('reads coarse zones from planner region words', () => {
    expect(['full canvas', 'center, 15–80% across', 'bottom right', 'upper left corner', 'middle', 'left half', 'somewhere'].map(zoneOf))
      .toEqual(['full-canvas', 'center', 'bottom-right', 'top-left', 'center', 'middle-left', undefined]);
  });
});
