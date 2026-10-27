// End-to-end Template Studio pipeline with MOCKED providers (no network, no cost). Ported from the Generator's
// tests/pipeline.test.ts, plus FrameFlow's additions: generation modes, reference drift, exact product pixels, cutouts,
// and the decomposition handoff.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRun } from '../decomposition/layerizeExperiment.js';
import { ingestAsset } from './assets/ingest.js';
import { attachLogo, createBrandKit } from './brand/kits.js';
import { CampaignError, createCampaign, createCampaignSchema, type CreateCampaignInput } from './campaigns/service.js';
import { overlayDocSchema } from './compose/overlay.js';
import { parseStudioEnv } from './config.js';
import { claimNextJob, enqueueJob } from './jobs/queue.js';
import { runJob } from './jobs/runner.js';
import { jobRegistry } from './jobs/worker.js';
import { decompositionScene, HandoffError, linkDecomposition } from './handoff.js';
import { editorOverlay, posterDetail } from './posters/dto.js';
import { renderPosterImage, renderPosterLogo } from './posters/service.js';
import { readStorageFile } from './storage.js';
import { createTemplate, startAnalysis } from './templates/service.js';
import { FakeProvider, fakeSegmenter } from './testing/fakeProvider.js';
import { logoPng, productCutoutPng, productPhotoPng, referencePosterPng, TEST_BRAND_RULES } from './testing/fixtures.js';
import { tempStudio } from './testing/harness.js';
import type { Segmenter } from '../decomposition/creativeTemplates/segmenter.js';

let ctx: ReturnType<typeof tempStudio>;
let provider: FakeProvider;
let segmenter: Segmenter | undefined;

beforeEach(() => {
  ctx = tempStudio();
  provider = new FakeProvider();
  segmenter = undefined;
});

async function runNext(env = ctx.env) {
  const job = claimNextJob(ctx.db, 'w1', 60_000);
  if (!job) throw new Error('no job');
  const state = await runJob(ctx.db, job, jobRegistry[job.kind], { workerId: 'w1', leaseMs: 60_000, storageDir: ctx.storageDir, env, provider, segmenter: () => segmenter });
  return { job, state };
}

async function asset(buffer: Buffer, role: 'reference' | 'subject' | 'logo' | 'cutout', label: string) {
  return (await ingestAsset({ buffer, role, filename: `${label}.png`, label }, { db: ctx.db, storageDir: ctx.storageDir })).asset;
}

async function brandKit() {
  const kit = createBrandKit(ctx.db, { name: 'Test Brand', rules: TEST_BRAND_RULES });
  for (const [colour, hex] of [['Studio Navy', '#14325c'], ['White', '#ffffff']] as const) {
    const logo = await asset(await logoPng(hex), 'logo', `logo-${colour}`);
    attachLogo(ctx.db, kit.id, { assetId: logo.id, kind: 'primary', name: `Test Brand ${colour}`, colourName: colour });
  }
  return kit;
}

async function readyTemplate(brandKitId: string | null = null) {
  const ref = await asset(await referencePosterPng(), 'reference', 'reference');
  const template = createTemplate(ctx.db, { name: 'Blue studio', referenceAssetIds: [ref.id], brandKitId });
  startAnalysis(ctx.db, ctx.env, template.id, 'analyse-key-1');
  const { state } = await runNext();
  expect(state).toBe('complete');
  return ctx.db.templates.require(template.id);
}

const campaign = (templateId: string, extra: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  idempotencyKey: `gen-${Math.random().toString(16).slice(2)}`, templateId, subjects: [], copy: { headline: 'Upgrade your kitchen' }, partnerLogoIds: [], formatId: 'portrait-4-5',
  fidelityMode: 'match', preserveProductPixels: false, ...extra,
});
const imageCalls = () => provider.calls.filter(c => c.kind === 'image');
const plannerCall = () => provider.calls.find(c => c.schemaName === 'concept_plan')!;
const reviewCall = () => provider.calls.find(c => c.schemaName === 'poster_review')!;

describe('template creation', () => {
  it('analyses references into a saved, versioned style profile with a recorded cost', async () => {
    const t = await readyTemplate();
    expect(t.status).toBe('ready');
    const v = ctx.db.profiles.require(t.currentProfileVersionId);
    expect(v).toMatchObject({ version: 1, selectedClusterId: 'c1', cached: false });
    expect(provider.calls.filter(c => c.schemaName === 'style_profile')).toHaveLength(1);
    expect(ctx.db.usage.all()).toHaveLength(1);
    expect(ctx.db.usage.all()[0].costUnknown).toBe(false);
  });

  it('reuses the cached analysis for identical inputs without a new paid call', async () => {
    const t = await readyTemplate();
    startAnalysis(ctx.db, ctx.env, t.id, 'analyse-key-2');
    await runNext();
    expect(provider.calls.filter(c => c.schemaName === 'style_profile')).toHaveLength(1);
    const versions = ctx.db.profiles.filter(p => p.templateId === t.id);
    expect(versions.map(v => [v.version, v.cached]).sort()).toEqual([[1, false], [2, true]]);
    expect(ctx.db.usage.all()).toHaveLength(1);
  });

  it('repairs an invalid answer once, then fails clearly', async () => {
    const ref = await asset(await referencePosterPng(400, 500), 'reference', 'broken');
    const t = createTemplate(ctx.db, { name: 'Broken', referenceAssetIds: [ref.id] });
    provider.overrides.style_profile = () => '{ not json';
    startAnalysis(ctx.db, ctx.env, t.id, 'k-broken-1');
    const { state, job } = await runNext();
    expect(state).toBe('failed');
    expect(ctx.db.jobs.require(job.id).error).toMatchObject({ code: 'invalid_output' });
    expect(provider.calls).toHaveLength(2); // original + one repair
  });

  it('refuses references that were not uploaded as template references', async () => {
    const product = await asset(await productPhotoPng(), 'subject', 'product');
    expect(() => createTemplate(ctx.db, { name: 'Wrong', referenceAssetIds: [product.id] })).toThrow(/Template reference/);
  });
});

describe('poster generation (Generator behaviour)', () => {
  it('generates a poster with exact copy, a brand-compliant logo, and recorded costs', async () => {
    const kit = await brandKit();
    const t = await readyTemplate(kit.id);
    const product = await asset(await productPhotoPng(), 'subject', 'Chimney X1');
    const copy = { headline: 'Upgrade your kitchen', offer: 'No-cost EMI from ₹1,999/month', footer: 'T&C apply. Offer valid till 31 Oct 2026.' };
    const input = campaign(t.id, { idempotencyKey: 'gen-key-0001', subjects: [{ assetId: product.id, name: 'Chimney X1' }], copy, fidelityMode: 'adapt' });
    const { job } = createCampaign(ctx.db, ctx.env, input);
    // A double submit returns the same job.
    expect(createCampaign(ctx.db, ctx.env, { ...input, copy: {}, subjects: [] }).job.id).toBe(job.id);

    const { state } = await runNext();
    expect(['complete', 'needs_review']).toContain(state);
    const poster = ctx.db.posters.find(p => p.jobId === job.id)!;
    const doc = overlayDocSchema.parse(poster.overlay);
    // Exact copy, never paraphrased.
    expect(Object.fromEntries(doc.texts.map(x => [x.field, x.text]))).toEqual(copy);
    expect(['top_left', 'top_right']).toContain(doc.logo?.corner);
    // The low-contrast planned colour was fixed and noted.
    expect(doc.texts.every(x => x.color !== '#2f6fd6')).toBe(true);
    expect(doc.notes.some(n => n.includes('legibility'))).toBe(true);

    const image = imageCalls()[0];
    expect(image.prompt).toMatch(/^ABSOLUTE RULE: the image must contain NO text/);
    expect(image.prompt).toContain('SUBJECT IDENTITY for "Chimney X1"');
    // Layout guide, style reference and subject, in that order.
    expect(image.images).toBe(3);
    expect(image.imageNames?.[0]).toBe('layout-guide.png');
    expect(image.prompt).toContain('= the orange block in the layout guide');
    expect(ctx.db.assets.count(a => a.role === 'layout_guide')).toBe(1);
    // The planner's 50%-wide product was held to the template's framing.
    const region = (ctx.db.conceptPlans.all()[0].scenePlan as { subjects: { region: { x: number; width: number } }[] }).subjects[0].region;
    expect(region.width).toBeLessThanOrEqual(0.66);
    expect(region.x).toBeGreaterThanOrEqual(0.08);

    const png = await renderPosterImage(ctx.db, ctx.storageDir, poster, { format: 'png' });
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);

    // Every paid call recorded: product analysis, plan, image, review.
    const stages = ctx.db.usage.filter(u => u.jobId === job.id).map(u => u.stage).sort();
    expect(stages.slice(0, 3)).toEqual(['generate_scene', 'plan', 'review']);
    expect(stages[3]).toMatch(/^subject:/);
    const detail = posterDetail(ctx.db, ctx.env, poster.id)!;
    expect(detail.cost.calls).toBe(4);
    expect(detail.cost.unknownCalls).toBe(0);
    expect(detail.cost.lines.map(l => l.label)).toEqual(expect.arrayContaining(['Product analysis', 'AI composition planning', 'Image generation', 'Image review']));
    expect(detail.cost.total.microUsd).toBeGreaterThan(0);
  });

  it('reuses a cached product analysis on the next poster (no new paid call)', async () => {
    const t = await readyTemplate();
    const product = await asset(await productPhotoPng(), 'subject', 'Oven');
    createCampaign(ctx.db, ctx.env, campaign(t.id, { subjects: [{ assetId: product.id, name: 'Oven' }] }));
    await runNext();
    createCampaign(ctx.db, ctx.env, campaign(t.id, { subjects: [{ assetId: product.id, name: 'Oven' }] }));
    await runNext();
    expect(provider.calls.filter(c => c.schemaName === 'subject_analysis')).toHaveLength(1);
  });

  it('flags text found in the generated scene for review', async () => {
    const t = await readyTemplate();
    provider.sceneText = ['SALE'];
    const { job } = createCampaign(ctx.db, ctx.env, campaign(t.id, { copy: { headline: 'Diwali offers' } }));
    expect((await runNext()).state).toBe('needs_review');
    const poster = ctx.db.posters.find(p => p.jobId === job.id)!;
    expect(JSON.stringify(ctx.db.reviews.find(r => r.posterId === poster.id)!.hardFailures)).toContain('contains text: SALE');
    expect(posterDetail(ctx.db, ctx.env, poster.id)!.checks.find(c => c.id === 'scene_text')!.status).toBe('fail');
  });

  it('refuses to start when the estimate exceeds the poster limit', async () => {
    const t = await readyTemplate();
    const tight = parseStudioEnv({ OPENAI_API_KEY: 'x', STUDIO_MAX_JOB_BUDGET_USD: '0.05' }, ctx.dir);
    expect(() => createCampaign(ctx.db, tight, campaign(t.id))).toThrow(/above the \$0.05 limit/);
  });
});

describe('generation modes', () => {
  it('defaults to Match Reference and keeps the reference design in every instruction', async () => {
    const t = await readyTemplate();
    const product = await asset(await productPhotoPng(), 'subject', 'Fridge');
    const input = campaign(t.id, { subjects: [{ assetId: product.id, name: 'Fridge' }] });
    delete (input as Partial<CreateCampaignInput>).fidelityMode;
    const { campaignId } = createCampaign(ctx.db, ctx.env, createCampaignSchema.parse(input));
    expect(ctx.db.campaigns.require(campaignId).fidelityMode).toBe('match');
    await runNext();

    expect(plannerCall().system).toContain('FIDELITY MODE "match"');
    expect(plannerCall().data?.fidelityMode).toBe('match');
    const prompt = imageCalls()[0].prompt!;
    expect(prompt).toContain('STYLE AND SCENE REFERENCE');
    expect(prompt).toContain('KEEP FROM THE STYLE REFERENCE');
    expect(prompt).toContain('Blue studio backdrop');
    expect(prompt).toContain('Its backdrop, supports, props, surface, camera and lighting are to be KEPT');
    // Nothing tells the image model to disregard the reference's design.
    for (const loose of ['look and feel only', 'recompose freely', 'loose inspiration', 'STYLE REFERENCE ONLY']) expect(prompt).not.toContain(loose);
    expect(reviewCall().system).toContain('made in "match" mode');
    expect(reviewCall().system).not.toContain('expected to use a different environment');
    const attempt = ctx.db.attempts.all()[0];
    expect(attempt.promptVersion).toBe('image-prompt/8+fidelity/1:match');
  });

  it('keeps the Generator\'s own wording for Adapt, and adds the chosen FrameFlow direction in Explore', async () => {
    const t = await readyTemplate();
    createCampaign(ctx.db, ctx.env, campaign(t.id, { fidelityMode: 'adapt' }));
    await runNext();
    const adapt = imageCalls()[0].prompt!;
    expect(adapt).toContain('recompose freely');
    expect(adapt).toContain('the style reference is for look and feel only');
    expect(adapt).not.toContain('KEEP FROM THE STYLE REFERENCE');
    expect(reviewCall().system).toContain('expected to use a different environment');

    createCampaign(ctx.db, ctx.env, campaign(t.id, { fidelityMode: 'explore', creativeDirectionId: 'lifestyle' }));
    await runNext();
    const explore = imageCalls()[1].prompt!;
    expect(explore).toContain('loose inspiration');
    const planner = provider.calls.filter(c => c.schemaName === 'concept_plan')[1];
    expect(planner.system).toContain('FIDELITY MODE "explore"');
    expect(String(planner.data?.userDirection)).toContain('Creative direction "In everyday life"');
    expect(() => createCampaign(ctx.db, ctx.env, campaign(t.id, { fidelityMode: 'match', creativeDirectionId: 'lifestyle' }))).toThrow(CampaignError);
  });

  it('reports an unrelated scene in Match mode as a failed check, with no automatic regeneration', async () => {
    const t = await readyTemplate();
    provider.referenceMatchScore = 2;
    const { job } = createCampaign(ctx.db, ctx.env, campaign(t.id));
    expect((await runNext()).state).toBe('needs_review');
    expect(imageCalls()).toHaveLength(1);
    const poster = ctx.db.posters.find(p => p.jobId === job.id)!;
    const detail = posterDetail(ctx.db, ctx.env, poster.id)!;
    expect(detail.review!.hardFailures.map(h => h.code)).toContain('reference_drift');
    expect(detail.review!.referenceMatch).toMatchObject({ score: 2, sameBackground: false });
    expect(detail.checks.find(c => c.id === 'reference')).toMatchObject({ status: 'fail' });
    expect(detail.checks.find(c => c.id === 'background')).toMatchObject({ status: 'fail' });
    expect(ctx.db.jobs.count(j => j.kind === 'generate_poster')).toBe(1);
  });
});

describe('restart safety', () => {
  it('never repeats a paid stage that was in flight when the server stopped', async () => {
    const t = await readyTemplate();
    const { job } = createCampaign(ctx.db, ctx.env, campaign(t.id));
    // The server stopped during the image call: earlier stages done, generate_scene still marked running.
    const at = new Date().toISOString();
    for (const [stage, status] of [['analyse_subjects', 'done'], ['plan', 'done'], ['generate_scene', 'running']] as const) {
      ctx.db.stages.insert({ id: `stg_${stage.length.toString(16).padStart(20, '0')}`, jobId: job.id, stage, status, paid: true, output: {}, startedAt: at, completedAt: null, durationMs: null });
    }
    const before = provider.calls.length;
    const { state } = await runNext();
    expect(state).toBe('failed');
    expect(ctx.db.jobs.require(job.id).error).toMatchObject({ code: 'outcome_unknown', stage: 'generate_scene' });
    expect(ctx.db.stages.find(s => s.jobId === job.id && s.stage === 'generate_scene')!.status).toBe('outcome_unknown');
    expect(provider.calls.length).toBe(before);
  });
});

describe('exact product pixels (FrameFlow compositor)', () => {
  it('places the transparent cutout\'s own pixels over the generated scene and measures them', async () => {
    const t = await readyTemplate();
    const cutout = await asset(await productCutoutPng(), 'cutout', 'Speaker');
    const { job } = createCampaign(ctx.db, ctx.env, campaign(t.id, { subjects: [{ assetId: cutout.id, name: 'Speaker' }], preserveProductPixels: true }));
    await runNext();
    const poster = ctx.db.posters.find(p => p.jobId === job.id)!;
    expect(poster.exactProducts).toMatchObject({ requested: true, applied: true, ok: true });
    expect(poster.rawSceneAssetId).not.toBeNull();
    expect(poster.sceneAssetId).not.toBe(poster.rawSceneAssetId);
    // The product's brown body colour is present, exactly, in the composed scene (the model drew teal).
    const scene = ctx.db.assets.require(poster.sceneAssetId);
    const { data } = await sharp(await readStorageFile(ctx.storageDir, scene.normalisedPath)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let brown = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] === 0xb5 && data[i + 1] === 0x65 && data[i + 2] === 0x1d) brown++;
    expect(brown).toBeGreaterThan(1000);
    expect(posterDetail(ctx.db, ctx.env, poster.id)!.checks.find(c => c.id === 'identity')!.status).toBe('pass');
  }, 30_000); // FrameFlow's compositor measures every pixel of a 1024×1280 scene: seconds of CPU under a loaded suite.

  it('requires a transparent cutout for every product', async () => {
    const t = await readyTemplate();
    const photo = await asset(await productPhotoPng(), 'subject', 'Kettle');
    expect(() => createCampaign(ctx.db, ctx.env, campaign(t.id, { subjects: [{ assetId: photo.id, name: 'Kettle' }], preserveProductPixels: true }))).toThrow(/transparent cutout/);
  });

  it('makes a cutout from an opaque photo with FrameFlow\'s segmenter, recording the listed price as an unconfirmed estimate', async () => {
    const calls: { label: string }[] = [];
    segmenter = fakeSegmenter(calls);
    const photo = await asset(await productPhotoPng(), 'subject', 'Kettle');
    enqueueJob(ctx.db, { kind: 'make_cutout', idempotencyKey: 'cutout:k1', input: { assetId: photo.id, label: 'Kettle' } });
    const { state, job } = await runNext();
    expect(state).toBe('complete');
    expect(calls).toEqual([{ label: 'Kettle' }]);
    const cutout = ctx.db.assets.require((ctx.db.jobs.require(job.id).result as { cutoutAssetId: string }).cutoutAssetId);
    expect(cutout).toMatchObject({ role: 'cutout', hasAlpha: true });
    const ledger = ctx.db.usage.filter(u => u.jobId === job.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ stage: 'cutout', usageDerivedMicroUsd: null, costUnknown: true, estimatedMicroUsd: 10_000 });
  });

  it('refuses a cutout when FrameFlow\'s segmenter is not configured', async () => {
    const photo = await asset(await productPhotoPng(), 'subject', 'Kettle');
    enqueueJob(ctx.db, { kind: 'make_cutout', idempotencyKey: 'cutout:k2', input: { assetId: photo.id, label: 'Kettle' } });
    const { state, job } = await runNext();
    expect(state).toBe('failed');
    expect(ctx.db.jobs.require(job.id).error).toMatchObject({ code: 'not_configured' });
    expect(ctx.db.usage.all().filter(u => u.jobId === job.id)).toHaveLength(0);
  });
});

describe('handoff to FrameFlow decomposition', () => {
  async function posterWithLogo() {
    const kit = await brandKit();
    const t = await readyTemplate(kit.id);
    const { job } = createCampaign(ctx.db, ctx.env, campaign(t.id, { copy: { headline: 'Upgrade your kitchen', cta: 'Visit your nearest store' } }));
    await runNext();
    return ctx.db.posters.find(p => p.jobId === job.id)!;
  }

  it('sends the text-free scene at the model\'s resolution, byte-identical every time', async () => {
    const poster = await posterWithLogo();
    const a = await decompositionScene(ctx.db, ctx.storageDir, poster), b = await decompositionScene(ctx.db, ctx.storageDir, poster);
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect([a.asset.width, a.asset.height]).toEqual([1024, 1280]);
    // It is the generated scene, not the poster with copy and logo.
    const rendered = await renderPosterImage(ctx.db, ctx.storageDir, poster, { format: 'png', width: 1024 });
    expect(a.bytes.equals(rendered)).toBe(false);
  });

  it('links a FrameFlow run only when the run\'s saved original is this poster\'s scene', async () => {
    const poster = await posterWithLogo();
    const runsDir = mkdtempSync(join(tmpdir(), 'template-studio-runs-'));
    const scene = await decompositionScene(ctx.db, ctx.storageDir, poster);
    // FrameFlow's own run creation (files only: createRun makes no provider call).
    const { run } = await createRun(runsDir, scene.bytes, { mode: 'generated' }, { refinement: true });
    const link = await linkDecomposition(ctx.db, ctx.storageDir, runsDir, poster, run.id);
    expect(link).toMatchObject({ posterId: poster.id, runId: run.id, sentWidth: 1024, sentHeight: 1280 });
    expect((await linkDecomposition(ctx.db, ctx.storageDir, runsDir, poster, run.id)).id).toBe(link.id);
    expect(posterDetail(ctx.db, ctx.env, poster.id)!.decompositions.map(d => d.runId)).toEqual([run.id]);

    const other = await createRun(runsDir, await referencePosterPng(1024, 1280), { mode: 'generated' });
    await expect(linkDecomposition(ctx.db, ctx.storageDir, runsDir, poster, other.run.id)).rejects.toThrow(HandoffError);
    await expect(linkDecomposition(ctx.db, ctx.storageDir, runsDir, poster, '../../etc')).rejects.toThrow(/Unknown decomposition run/);
    const original = readFileSync(join(runsDir, run.id, run.original.file));
    expect(createHash('sha256').update(original).digest('hex')).toBe(scene.asset.sha256);
  });

  it('gives the editor the exact copy as text and the logo lock-up as one transparent image', async () => {
    const poster = await posterWithLogo();
    const logo = await renderPosterLogo(ctx.db, ctx.storageDir, poster);
    expect(logo).not.toBeNull();
    const meta = await sharp(logo!.image).metadata();
    expect(meta.hasAlpha).toBe(true);
    const overlay = editorOverlay(poster, logo!.box);
    expect(overlay.texts.map(x => [x.field, x.text])).toEqual([['headline', 'Upgrade your kitchen'], ['cta', 'Visit your nearest store']]);
    expect(overlay.texts.every(x => x.renderedFontSizePct !== null && x.lines.length > 0)).toBe(true);
    expect(overlay.logo?.box.width).toBeGreaterThan(0.05);
    expect(['top_left', 'top_right']).toContain(overlayDocSchema.parse(poster.overlay).logo?.corner);
  });
});
