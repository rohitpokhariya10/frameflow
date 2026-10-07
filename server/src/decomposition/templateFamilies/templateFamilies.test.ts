import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compileGenerationPrompt, matchThresholds, type StructureAnalysis } from '@frameflow/shared';
import type { RunRecord } from '../layerizeExperiment.js';
import { analysisOf, CREATIVES, renderCreative, type CreativeSpec } from './creatives.fixture.js';
import { detectTemplateFamily, type FamilyServices } from './familyMatcher.js';
import { familyDecomposition, planAgreement, recordFamilyRun, validateGeneratedFamily, validateReusedDecomposition, type FamilyAssignment } from './familyRuns.js';
import { ensureSeedFamilies, fileFamilyStore, ImmutableVersionError, memoryFamilyStore, type TemplateFamilyStore } from './store.js';
import { parseStructureResponse, StructurePlannerError, type StructurePlanner, type StructureTier } from './structurePlanner.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const usage = { input_tokens: 1800, output_tokens: 700, total_tokens: 2500 };
/** A planner that answers from the image → analysis table, or with a scripted answer; every call is counted. */
function fakePlanner(tier: StructureTier, answers: Map<string, StructureAnalysis>, script?: (n: number) => StructureAnalysis | Error): StructurePlanner & { analyze: ReturnType<typeof vi.fn> } {
  let n = 0;
  return { tier, model: tier === 'cheap' ? 'gpt-5.6-luna' : 'gpt-5.6-sol', analyze: vi.fn(async (image: Buffer) => {
    const answer = script ? script(n++) : answers.get(sha(image));
    if (!answer) throw new StructurePlannerError('STRUCTURE_INVALID', 'unknown test image');
    if (answer instanceof Error) throw answer;
    return { analysis: answer, model: tier === 'cheap' ? 'gpt-5.6-luna' : 'gpt-5.6-sol', tier, responseId: `resp-${tier}`, usage, request: { model: tier }, raw: { usage: { ...usage, input_tokens_details: { cached_tokens: 0 } } }, durationMs: 3 };
  }) };
}
async function setup(store: TemplateFamilyStore = memoryFamilyStore(), script?: { cheap?: (n: number) => StructureAnalysis | Error; strong?: (n: number) => StructureAnalysis | Error }) {
  const answers = new Map<string, StructureAnalysis>();
  const cheap = fakePlanner('cheap', answers, script?.cheap), strong = fakePlanner('strong', answers, script?.strong);
  const services: FamilyServices = { store, planners: () => ({ cheap, strong }), thresholds: matchThresholds() };
  const image = async (spec: CreativeSpec) => { const bytes = await renderCreative(spec); answers.set(sha(bytes), analysisOf(spec)); return bytes; };
  const detect = async (spec: CreativeSpec | Buffer, groupId = 'group') => { const bytes = Buffer.isBuffer(spec) ? spec : await image(spec); return detectTemplateFamily({ image: bytes, sha256: sha(bytes), services, groupId }); };
  return { store, cheap, strong, detect, image };
}

describe('template family detection', () => {
  it('seeds Templates A/B/C as ordinary active families, idempotently (CASE 15)', () => {
    const store = memoryFamilyStore();
    ensureSeedFamilies(store); ensureSeedFamilies(store);
    expect(store.list().map(f => [f.id, f.status, f.seed?.key, f.versions])).toEqual([
      ['fam-framed-portrait', 'active', 'template-a', [1]], ['fam-centered-product', 'active', 'template-b', [1]], ['fam-people-campaign', 'active', 'template-c', [1]]]);
  });
  it('CASE 5: an ambiguous creative gets ONE low-cost analysis, and the strong model is not called when it validates', async () => {
    const t = await setup(), d = await t.detect(CREATIVES.bottleCentered);
    expect(d).toMatchObject({ status: 'done', outcome: 'reused', method: 'cheap-planner', ref: { familyId: 'fam-centered-product', version: 1 } });
    expect(t.cheap.analyze).toHaveBeenCalledTimes(1); expect(t.strong.analyze).not.toHaveBeenCalled();
    expect(d.detectedValues).toMatchObject({ product: 'amber perfume bottle', headline: 'Glow Season', cta: 'Discover' });
    expect(t.store.get('fam-centered-product')!.stats).toMatchObject({ matches: 1, observed: { analysis: { calls: 1 } } });
  });
  it('CASE 7 → CASE 1/4/8: a new layout creates a family once; the same structure later is reused with 0 calls', async () => {
    const t = await setup();
    const first = await t.detect(CREATIVES.headphonesBlue, 'g1');
    expect(first).toMatchObject({ outcome: 'created', method: 'cheap-planner', familyName: 'Centered Product Offer' });
    const family = t.store.get(first.ref!.familyId)!;
    expect(family).toMatchObject({ status: 'provisional', versions: [1] });
    expect(family.exemplars).toHaveLength(1);
    expect(JSON.stringify(t.store.current(family.id))).not.toMatch(/headphones|Summer Sale/);
    // Headphones → iPhone, blue → red: the local fingerprint finds the family; no structural call at all.
    const second = await t.detect(CREATIVES.iphoneRed, 'g2');
    expect(second).toMatchObject({ outcome: 'reused', method: 'local-fingerprint', ref: first.ref, detectedValues: {} });
    expect(second.calls).toEqual([]);
    expect(t.cheap.analyze).toHaveBeenCalledTimes(1);
    expect(t.store.list()).toHaveLength(4);
  });
  it('CASE 10: two creatives of a new layout detected at once make one analysis and one family', async () => {
    const t = await setup(), [a, b] = await Promise.all([t.image(CREATIVES.headphonesBlue), t.image(CREATIVES.iphoneRed)]);
    const [first, second] = await Promise.all([t.detect(a, 'g1'), t.detect(b, 'g2')]);
    expect(first).toMatchObject({ outcome: 'created' });
    expect(second).toMatchObject({ outcome: 'reused', method: 'local-fingerprint', ref: first.ref, calls: [] });
    expect(t.cheap.analyze).toHaveBeenCalledTimes(1);
    expect(t.store.list()).toHaveLength(4);
  });
  it('the exact same image is never analyzed twice', async () => {
    const t = await setup(), bytes = await t.image(CREATIVES.splitBlue);
    await t.detect(bytes);
    const again = await t.detect(bytes);
    expect(again).toMatchObject({ outcome: 'reused', calls: [] });
    expect(['cached-analysis', 'local-fingerprint']).toContain(again.method);
    expect(t.cheap.analyze).toHaveBeenCalledTimes(1);
  });
  it('CASE 3/11: a split two-product layout never joins the centred family, and back', async () => {
    const t = await setup();
    const centred = await t.detect(CREATIVES.headphonesBlue), split = await t.detect(CREATIVES.splitBlue);
    expect(split.outcome).toBe('created');
    expect(split.ref!.familyId).not.toBe(centred.ref!.familyId);
    expect(split.candidates.find(c => c.familyId === centred.ref!.familyId && c.stage === 'structure')!.problems[0]).toMatch(/product count/);
    const sideways = await t.detect(CREATIVES.sideways);
    expect(sideways.outcome).toBe('created');
    expect((await t.detect(CREATIVES.splitOrange)).ref).toEqual(split.ref);
    expect((await t.detect(CREATIVES.iphoneRed)).ref).toEqual(centred.ref);
  });
  it('CASE 6: an unusable low-cost answer escalates ONCE to the strong model', async () => {
    const low = { ...analysisOf(CREATIVES.splitBlue), confidence: 0.3 };
    const t = await setup(memoryFamilyStore(), { cheap: () => low, strong: () => analysisOf(CREATIVES.splitBlue) });
    const d = await t.detect(CREATIVES.splitBlue);
    expect(d).toMatchObject({ status: 'done', method: 'strong-planner', outcome: 'created' });
    expect(d.calls.map(c => [c.tier, c.status])).toEqual([['cheap', 'invalid'], ['strong', 'ok']]);
    expect(d.escalation).toMatch(/below 0.6/);
    expect(t.cheap.analyze).toHaveBeenCalledTimes(1); expect(t.strong.analyze).toHaveBeenCalledTimes(1);
  });
  it('a failed detection leaves every family untouched and makes no further call', async () => {
    const bad = new StructurePlannerError('STRUCTURE_INVALID', 'boxes outside the canvas');
    const t = await setup(memoryFamilyStore(), { cheap: () => bad, strong: () => bad });
    ensureSeedFamilies(t.store);
    const before = JSON.stringify(t.store.list());
    const d = await t.detect(CREATIVES.splitBlue);
    expect(d).toMatchObject({ status: 'failed', error: { code: 'STRUCTURE_INVALID' } });
    expect(d.calls).toHaveLength(2);
    expect(JSON.stringify(t.store.list())).toBe(before);
  });
  it('validates planner answers locally', () => {
    expect(() => parseStructureResponse({ layout_name: 'x', background: { kind: 'flat', description: '' }, elements: [{ id: 'a', role: 'product', label: '', text: '', x: 0.8, y: 0, width: 0.5, height: 0.2, z: 0 }], relations: [], decomposition_recipe: 'template-b', confidence: 0.9 })).toThrow(/outside the canvas/);
    expect(() => parseStructureResponse({ layout_name: 'x', background: { kind: 'flat', description: '' }, elements: [{ id: 'a', role: 'product', label: '', text: '', x: 0, y: 0, width: 0.5, height: 0.2, z: 0 }], relations: [{ from: 'a', to: 'b', type: 'holds' }], decomposition_recipe: 'template-b', confidence: 0.9 })).toThrow(/unknown element/);
  });
});

describe('persistence and versions', () => {
  it('CASE 13: families survive a restart and keep being reused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'families-'));
    const first = await setup(fileFamilyStore(root));
    const created = await first.detect(CREATIVES.splitBlue);
    const restarted = await setup(fileFamilyStore(root));
    expect(restarted.store.blueprint(created.ref!)).toMatchObject({ name: 'Split Product Offer', version: 1 });
    const reused = await restarted.detect(CREATIVES.splitOrange);
    expect(reused).toMatchObject({ outcome: 'reused', method: 'local-fingerprint', ref: created.ref, calls: [] });
  });
  it('CASE 14: a run tied to v1 keeps v1 after v2 exists; versions are immutable', async () => {
    const t = await setup(), d = await t.detect(CREATIVES.headphonesBlue), familyId = d.ref!.familyId;
    const v1 = t.store.blueprint({ familyId, version: 1 })!;
    const v2 = t.store.addVersion(familyId, version => ({ ...v1, version, origin: 'developer revision', generationPromptTemplate: `${v1.generationPromptTemplate} Use a softer shadow.` }));
    expect(t.store.get(familyId)).toMatchObject({ currentVersion: 2, versions: [1, 2] });
    expect(t.store.blueprint({ familyId, version: 1 })).toEqual(v1);
    expect(compileGenerationPrompt(v2, {})).toContain('softer shadow');
    expect(compileGenerationPrompt(t.store.blueprint({ familyId, version: 1 })!, {})).not.toContain('softer shadow');
    t.store.update(familyId, f => { f.status = 'active'; f.versions = [9]; f.currentVersion = 9; });
    expect(t.store.get(familyId)).toMatchObject({ currentVersion: 2, versions: [1, 2] });
    const assignment: FamilyAssignment = { detection: d, slotValues: {}, ref: d.ref, generation: { ref: { familyId, version: 1 }, slotValues: {}, prompt: '', compiledAt: '', cacheKey: '' } };
    expect(familyDecomposition(t.store, assignment, { id: '1x1' }, { imageValidation: { passed: true, problems: [] } }).promptSource).toMatchObject({ mode: 'blueprint', version: 1 });
    const backend = fileFamilyStore(mkdtempSync(join(tmpdir(), 'families-')));
    backend.create({ ...v1, familyId: 'fam-immutable-abc123' });
    expect(() => backend.addVersion('fam-immutable-abc123', () => ({ ...v1, familyId: 'fam-immutable-abc123', version: 1 }))).toThrow(/next number/);
    expect(ImmutableVersionError).toBeDefined();
  });
});

describe('decomposition with a family plan', () => {
  async function activeFamily() {
    const t = await setup(), d = await t.detect(CREATIVES.headphonesBlue);
    t.store.update(d.ref!.familyId, f => { f.status = 'active'; });
    return { ...t, d };
  }
  it('CASE 10/18: reuses the structure with THIS creative\'s values; compiled plans are cached per values', async () => {
    const { store, d } = await activeFamily();
    const assignment: FamilyAssignment = { detection: d, slotValues: { product: 'iPhone 17 Pro' }, ref: d.ref, generation: { ref: d.ref!, slotValues: { product: 'iPhone 17 Pro' }, prompt: '', compiledAt: '', cacheKey: '' } };
    const generated = familyDecomposition(store, assignment, { id: '1x1' }, { imageValidation: { passed: true, problems: [] } }), original = familyDecomposition(store, assignment, { id: 'original' });
    expect(generated.promptSource.mode).toBe('blueprint');
    const prompt = (s: typeof generated) => s.promptSource.mode === 'blueprint' ? s.promptSource.prompt : '';
    expect(prompt(generated)).toContain('iPhone 17 Pro');
    expect(prompt(generated)).not.toContain('headphones');
    expect(prompt(original)).toContain('black over-ear headphones');
    expect(generated.templateReuse).toMatchObject({ decompositionPlanReused: true, generationPromptTemplateReused: true, avoided: { planner: 1, analysis: 0 }, cheapPlannerCalls: 1 });
    expect(original.templateReuse.generationPromptTemplateReused).toBe(false);
    expect(generated.promptSource.mode === 'blueprint' && generated.promptSource.semantic_analysis!.recommended_layer_count).toBe(5);
  });
  it('a provisional family, or an explicit fresh plan, uses the full planner', async () => {
    const t = await setup(), d = await t.detect(CREATIVES.headphonesBlue);
    const assignment: FamilyAssignment = { detection: d, slotValues: {}, ref: d.ref };
    expect(familyDecomposition(t.store, assignment, { id: 'original' })).toMatchObject({ promptSource: { mode: 'generated' }, templateReuse: { decompositionPlanReused: false, planNotReusedReason: 'provisional-family', avoided: { planner: 0 } } });
    t.store.update(d.ref!.familyId, f => { f.status = 'active'; });
    expect(familyDecomposition(t.store, assignment, { id: 'original' }, { planFresh: true }).templateReuse.planNotReusedReason).toBe('plan-fresh');
  });
  it('CASE 6/7/8: a generated image reuses the plan only when its own layout still matches the family', async () => {
    const { store, d } = await activeFamily(), localHigh = matchThresholds().localHigh;
    const assignment: FamilyAssignment = { detection: d, slotValues: { product: 'iPhone' }, ref: d.ref, generation: { ref: d.ref!, slotValues: { product: 'iPhone' }, prompt: '', compiledAt: '', cacheKey: '' } };
    const check = async (spec: CreativeSpec) => validateGeneratedFamily(store, assignment, await renderCreative({ ...spec, size: 1024 }), localHigh);
    // Headphones → iPhone, blue → red, in the same places: confirmed, and the saved plan is reused.
    const same = await check(CREATIVES.iphoneRed);
    expect(same).toEqual({ passed: true, problems: [] });
    expect(familyDecomposition(store, assignment, { id: '1x1' }, { imageValidation: same }).templateReuse).toMatchObject({ decompositionPlanReused: true, imageValidation: { passed: true }, avoided: { planner: 1 } });
    // The generator drifted: everything rearranged, a second product, the headline moved, the badge dropped.
    const noBadge: CreativeSpec = { ...CREATIVES.iphoneRed, badge: undefined };
    const drifts: Record<string, CreativeSpec> = {
      rearranged: CREATIVES.sideways,
      extraProduct: { ...CREATIVES.iphoneRed, product: [...CREATIVES.iphoneRed.product!, { box: { x: 0.03, y: 0.35, width: 0.2, height: 0.34 }, shape: 'bottle', color: '#f59e0b', label: 'bottle' }] },
      headlineMoved: { ...CREATIVES.iphoneRed, headline: { ...CREATIVES.iphoneRed.headline!, y: 0.72, height: 0.08 } },
      badgeDropped: noBadge,
    };
    for (const [name, spec] of Object.entries(drifts)) {
      const drifted = await check(spec);
      expect({ name, passed: drifted.passed }).toEqual({ name, passed: false });
      expect(drifted.problems.length).toBeGreaterThan(0);
      const source = familyDecomposition(store, assignment, { id: '1x1' }, { imageValidation: drifted });
      expect(source.promptSource.mode).toBe('generated');
      expect(source.templateReuse).toMatchObject({ decompositionPlanReused: false, planNotReusedReason: 'generated-image-drift', imageValidation: { passed: false }, avoided: { planner: 0 } });
    }
    expect((await check(drifts.extraProduct)).problems.join(' ')).toMatch(/large element the saved layout does not have/);
    // A dropped badge is caught by name, not only by the score: still refused under a looser threshold.
    const looser = await validateGeneratedFamily(store, assignment, await renderCreative({ ...noBadge, size: 1024 }), 0.8);
    expect(looser).toEqual({ passed: false, problems: ['The badge of the saved layout was not found in place.'] });
    expect(await validateGeneratedFamily(store, assignment, Buffer.from('not an image'), localHigh)).toMatchObject({ passed: false });
    // Never reused unchecked; a fresh plan wins over a passing check; the uploaded original needs no image check.
    expect(familyDecomposition(store, assignment, { id: '1x1' }).templateReuse).toMatchObject({ decompositionPlanReused: false, planNotReusedReason: 'generated-image-unchecked' });
    expect(familyDecomposition(store, assignment, { id: '1x1' }, { planFresh: true, imageValidation: same }).templateReuse).toMatchObject({ decompositionPlanReused: false, planNotReusedReason: 'plan-fresh' });
    const original = familyDecomposition(store, assignment, { id: 'original' }, { imageValidation: { passed: false, problems: ['ignored'] } });
    expect(original.templateReuse).toMatchObject({ decompositionPlanReused: true, generationPromptTemplateReused: false });
    expect(original.templateReuse.imageValidation).toBeUndefined();
  });
  function doneRun(source: ReturnType<typeof familyDecomposition>, matched: string[], editorLayers: number, background = 'usable'): RunRecord {
    const required = source.promptSource.mode === 'blueprint' ? source.promptSource.requiredElements : [];
    return { id: '2026-10-07T00-00-00-000Z-abcdef', createdAt: '', updatedAt: '', stage: 'done', promptSource: source.promptSource, blueprint: { familyId: source.blueprint.familyId, version: source.blueprint.version },
      templateReuse: source.templateReuse, original: { file: 'o.png', mime: 'image/png', width: 1, height: 1, bytes: 1 }, input: { file: 'o.png', mime: 'image/png', width: 1, height: 1, orientationNormalized: false },
      seedream: { endpoint: 'x' }, timings: {}, warnings: [], editorLayerFiles: Array.from({ length: editorLayers }, (_, i) => `l${i}.png`), layerCount: { providerReturnedLayers: 6 } as RunRecord['layerCount'],
      refinement: { planCoverage: { planned: required.filter(id => id !== 'background'), matched: Object.fromEntries(matched.map(id => [id, `${id}.png`])), complete: true }, background: { quality: background, contaminated: false } } as unknown as RunRecord['refinement'],
      calls: { fitCheck: 0, planner: 0, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 } };
  }
  it('CASE 42: a reused plan\'s result passes the quality gate only with every required layer and a clean background', async () => {
    const { store, d } = await activeFamily();
    const source = familyDecomposition(store, { detection: d, slotValues: {}, ref: d.ref }, { id: 'original' });
    expect(validateReusedDecomposition(doneRun(source, ['product', 'headline', 'cta'], 5), source.blueprint)).toMatchObject({ passed: true, editorLayers: 5, rawLayers: 6 });
    const missing = validateReusedDecomposition(doneRun(source, ['headline', 'cta'], 3, 'contaminated'), source.blueprint);
    expect(missing.passed).toBe(false);
    expect(missing.problems.join(' ')).toMatch(/product layer was not extracted.*background is not clean/);
    const run = recordFamilyRun(store, doneRun(source, ['headline', 'cta'], 4), { total: { usd: 0.2, inr: 18, knownUsd: 0.2, knownInr: 18, confidence: 'Calculated', notes: [] }, rawLayers: 6, editorLayers: 4, stages: [] });
    expect(run.templateReuse).toMatchObject({ statsRecorded: true, validation: { passed: false } });
    expect(run.warnings.join(' ')).toMatch(/BLUEPRINT_REUSE_UNVERIFIED/);
    const stats = store.get(d.ref!.familyId)!.stats;
    expect(stats).toMatchObject({ decompositionFailure: 1, reuseValidationFailures: 1, rawLayers: 6, editorLayers: 4, costedRuns: 1 });
    recordFamilyRun(store, run);
    expect(store.get(d.ref!.familyId)!.stats.decompositionFailure).toBe(1);
  });
  it('a provisional family becomes active when a full plan agrees with its saved plan', async () => {
    const t = await setup(), d = await t.detect(CREATIVES.headphonesBlue);
    const source = familyDecomposition(t.store, { detection: d, slotValues: {}, ref: d.ref }, { id: 'original' });
    const element = (id: string, type: string) => ({ id, type, description: id, editable_independently: true, approximate_region: '', z_order: 0, confidence: 'high' as const, occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'none' as const, parent_id: '', separation_risk: 'low' as const, keep_with_parent: false } });
    const semantic = { image_type: '', scene_summary: '', relationships: [], ambiguities: [], recommended_layer_count: 5, decomposition_strategy: '', downstream_decomposition_prompt: '',
      elements: [element('bg', 'background gradient'), element('headphones', 'product'), element('title', 'headline text'), element('button', 'cta button'), element('sale_badge', 'badge')] };
    expect(planAgreement(source.blueprint, semantic).passed).toBe(true);
    expect(planAgreement(source.blueprint, { ...semantic, elements: semantic.elements.slice(0, 2) }).passed).toBe(false);
    const run = { ...doneRun(source, [], 5), planner: { model: 'gpt-5.6-sol', durationMs: 1, prompt: 'x', planned_layers: [], warnings: [], semantic_analysis: semantic } };
    recordFamilyRun(t.store, run);
    expect(t.store.get(d.ref!.familyId)).toMatchObject({ status: 'active', activatedBy: run.id });
  });
});
