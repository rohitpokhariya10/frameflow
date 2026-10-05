import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { ProviderError } from './providers/adapters.js';
import { createRun, executeRun, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import type { Planner } from './layerizePlanner.js';
import { ALL_PARTS, offerBackground, offerComposite, offerPart, partName, rowFillEdit, type OfferPart } from './complexOffer.fixture.js';
import { assessBackgroundContamination, coverageOnGrid, gridFor, layerShape, rgbOnGrid, unionOf } from './backgroundContamination.js';
import { CLEAN_BACKGROUND_PROMPT, editInputs, featherMask, reconstructionSize, type BackgroundReconstructionRequest } from './cleanBackground.js';
import { grow } from './outerBackground.js';
import { classify, MAX_RESIDUAL_PASSES, RESIDUAL_PROMPT, refinementOptions, type RefinementOptions } from './recursiveDecomposition.js';

const planner: Planner = async () => ({ plan: { prompt: 'Separate every product, the pedestal, the confetti and the headline.', planned_layers: [], warnings: [] }, model: 'test-planner', raw: {}, request: {} });
/** What one fake Seedream call returns: these parts as layers, and a base showing `base` (parts Seedream left baked in). */
type Pass = { parts: OfferPart[]; base?: OfferPart[]; extra?: { name: string; part: OfferPart }[] } | 'fail-result' | 'fail-submit';
const CONTAMINATION = { minRegionPercent: 0.25, contaminatedPercent: 0.6, minConfidence: 0.5 };
const WITHOUT = (...missing: OfferPart[]) => ALL_PARTS.filter(part => !missing.includes(part));

/**
 * One run through the real runner (createRun → executeRun) with every provider faked: the planner, Seedream (one scripted
 * answer per submission; an unexpected submission throws) and the background edit (rowFillEdit, or a failure).
 */
async function scenario(script: { passes: Pass[]; edit?: 'ok' | 'fail' | 'none'; refinement?: boolean | Partial<RefinementOptions> }) {
  const original = await offerComposite(), files: Record<string, Buffer> = {}, answers = new Map<string, unknown>();
  const submitted: Record<string, unknown>[] = [], uploads: Buffer[] = [];
  const transport = {
    upload: vi.fn(async (bytes: Buffer) => { uploads.push(bytes); return `https://v3b.fal.media/files/test/upload-${uploads.length}.png`; }),
    submit: vi.fn<FalTransport['submit']>(async (_endpoint, input) => {
      const index = submitted.length, step = script.passes[index];
      if (!step) throw new Error(`Unexpected Seedream submission #${index + 1}.`);
      submitted.push(input);
      if (step === 'fail-submit') throw new Error('fal is unreachable');
      const requestId = `req-${index}`;
      if (step === 'fail-result') { answers.set(requestId, new ProviderError('PROVIDER_ERROR', 'fal returned 500', false, 500)); return { requestId }; }
      const layers: unknown[] = [];
      const add = (name: string, png: Buffer) => { const url = `https://v3b.fal.media/files/test/${requestId}-${layers.length}.png`; files[url] = png; layers.push({ image: { url }, z_index: layers.length, name }); };
      add('Background', await offerComposite(step.base ?? []));
      for (const part of step.parts) add(partName(part), await offerPart(part));
      for (const extra of step.extra ?? []) add(extra.name, await offerPart(extra.part));
      answers.set(requestId, { layers });
      return { requestId };
    }),
    status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async (_endpoint: string, id: string) => { const answer = answers.get(id); if (answer instanceof Error) throw answer; return answer; }),
    cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
  } satisfies FalTransport;
  const edits: BackgroundReconstructionRequest[] = [];
  const reconstruct = vi.fn(async (request: BackgroundReconstructionRequest) => {
    edits.push(request);
    if (script.edit === 'fail') throw new Error('OpenAI image edit returned 500');
    return { image: await rowFillEdit(request.image, request.mask), requestId: 'edit-req-1' };
  });
  const deps: RunnerDeps = { planner, transport: () => transport, sleep: async () => undefined, ...(script.edit === 'none' ? {} : { backgroundReconstructor: { model: 'test-image-edit', reconstruct } }) };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'recursive-')), original, { mode: 'generated' }, { templateKey: 'template-b', semanticPlanning: true, refinement: script.refinement ?? true });
  const run = await executeRun(dir, deps);
  return { dir, run, submitted, uploads, edits, reconstruct, transport, deps, original };
}
const names = (run: ReturnType<typeof readRun>) => (run.outputLayers ?? []).map(l => l.name);
const passOf = (run: ReturnType<typeof readRun>, name: string) => run.outputLayers!.find(l => l.name === name)?.provenance?.sourcePass;
/** Mean absolute RGB difference (0–255) between two images at 256×256. */
async function difference(a: Buffer, b: Buffer) {
  const [x, y] = await Promise.all([a, b].map(image => sharp(image).resize(256, 256, { fit: 'fill' }).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer()));
  let sum = 0; for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}
async function pixel(file: string, x: number, y: number) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels];
}

describe('recursive decomposition: complex offer creative with fake providers', () => {
  it('pass 1 misses the speaker and power bank; one residual pass finds them; one clean background; nothing duplicated', async () => {
    const s = await scenario({ passes: [
      { parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS },
      // Seedream finds the two missed products, plus a copy of the headphones and a second speaker layer: both duplicates.
      { parts: ['speaker', 'powerBank'], extra: [{ name: 'Wireless headphones', part: 'headphones' }, { name: 'Speaker body', part: 'speaker' }] },
    ] });
    const run = readRun(s.dir);
    expect(run.stage).toBe('done');
    // Final: background + every part exactly once.
    expect(names(run).sort()).toEqual(['Background', ...ALL_PARTS.map(partName)].sort());
    expect(names(run).filter(name => /speaker/i.test(name!))).toEqual(['Bluetooth speaker']);
    expect(names(run).filter(name => /headphones/i.test(name!))).toEqual(['Wireless headphones']);
    // Exactly one residual pass, stopped because residual 2 is clean.
    expect(run.refinement).toMatchObject({ state: 'done', passesExecuted: 2, stopReason: 'clean' });
    expect(run.refinement!.assessments.map(a => [a.residual, a.verdict, a.sent])).toEqual([['residual-pass-1.png', 'contaminated', true], ['residual-pass-2.png', 'clean', false]]);
    expect(s.submitted).toHaveLength(2);
    expect(String(s.submitted[1].prompt)).toMatch(new RegExp(`^${RESIDUAL_PROMPT.slice(0, 60).replace(/[()]/g, '\\$&')}`));
    // The residual is what was sent: the uploaded bytes are residual-pass-1.png.
    expect(s.uploads[1].equals(readFileSync(join(s.dir, 'residual-pass-1.png')))).toBe(true);
    // Duplicates rejected in favor of the earlier layer.
    const pass = run.refinement!.passes[0];
    expect(pass).toMatchObject({ pass: 1, state: 'done', requestId: 'req-1', returnedLayers: 5, accepted: ['pass-1-layer-01.png', 'pass-1-layer-02.png'] });
    expect(pass.rejected.map(r => [r.name, r.reason])).toEqual(expect.arrayContaining([['Wireless headphones', expect.stringMatching(/^(duplicate|inside-extracted-region)$/)], ['Speaker body', 'duplicate']]));
    expect(pass.rejected.find(r => r.name === 'Speaker body')!.duplicateOf).toBe('pass-1-layer-01.png');
    // Call accounting: nothing hidden.
    expect(run.calls).toEqual({ fitCheck: 0, planner: 1, seedreamInitial: 1, seedreamResidual: 1, backgroundReconstruction: 1 });
    // Clean background: AI reconstructed from the original, the products gone.
    const base = run.outputLayers![0];
    expect(base).toMatchObject({ file: 'clean-background.png', rawFile: 'layer-00.png', zIndex: 0, placement: { kind: 'base' }, cleanBackground: { status: 'ai-reconstructed', method: 'ai-reconstruction' } });
    expect(await difference(readFileSync(join(s.dir, 'clean-background.png')), await offerBackground())).toBeLessThan(1.5);
    expect(await difference(readFileSync(join(s.dir, 'layer-00.png')), await offerBackground())).toBeGreaterThan(5);
    expect(run.refinement!.background).toMatchObject({ status: 'ai-reconstructed', needed: true, contaminated: false, recreated: [], source: 'original' });
    // Reconstruction still matches the original (major products appear once, composition recognizable).
    expect(await difference(readFileSync(join(s.dir, 'reconstructed.png')), s.original)).toBeLessThan(1.5);
    expect(run.refinement!.fidelity!.after.meanAbsDiff).toBeLessThanOrEqual(run.refinement!.fidelity!.before.meanAbsDiff);
    // Artifacts: the existing three plus the debugging ones; the editor's layers are outputLayers.
    for (const file of ['layers.json', 'contact-sheet.png', 'reconstructed.png', 'clean-background.png', 'foreground-mask.png', 'residual-pass-1.png', 'residual-pass-2.png', 'decomposition-debug.json']) expect(existsSync(join(s.dir, file)), file).toBe(true);
    expect(run.outputLayers!.map(({ sources, ...layer }) => { expect(sources).toEqual([layer.file]); return layer; })).toEqual(run.layers);
    const debug = JSON.parse(readFileSync(join(s.dir, 'decomposition-debug.json'), 'utf8'));
    expect(debug.callSummary).toEqual(['Template fit check (OpenAI): 0', 'Planner (OpenAI): 1', 'Initial layerize (Seedream): 1', 'Residual layerize (Seedream): 1', 'Background reconstruction (OpenAI image edit): 1']);
    expect(run.warnings.some(w => /^RECURSIVE_DECOMPOSITION: 2 pass\(es\) \(1 initial \+ 1 residual\); stopped: clean/.test(w))).toBe(true);
  }, 60_000);

  it('records provenance for every layer and orders by occlusion, not by pass (the speaker stands on the pedestal)', async () => {
    const s = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: ['speaker', 'powerBank'] }] });
    const run = readRun(s.dir), layers = run.outputLayers!;
    expect(passOf(run, 'Bluetooth speaker')).toBe(1);
    expect(passOf(run, 'Power bank')).toBe(1);
    for (const part of WITHOUT('speaker', 'powerBank')) expect(passOf(run, partName(part))).toBe(0);
    expect(layers.find(l => l.name === 'Bluetooth speaker')!.provenance).toMatchObject({ sourcePass: 1, sourceImage: 'residual-pass-1.png', parentResidualId: 'residual-pass-1', providerFile: 'pass-1-layer-01.png', providerRequestId: 'req-1', mask: 'pass-1-layer-01.png' });
    expect(layers.find(l => l.name === 'Smartwatch')!.provenance).toMatchObject({ sourcePass: 0, sourceImage: 'original.png', providerRequestId: 'req-0' });
    // bbox in canvas pixels: the speaker spans x 560–710, y 470–720 of 1000 on a 1024 canvas.
    const [x0, y0, x1, y1] = layers.find(l => l.name === 'Bluetooth speaker')!.provenance!.bbox!;
    expect([x0, y0, x1, y1].map(v => Math.round(v / 1.024 / 10) * 10)).toEqual([560, 470, 710, 720]);
    // Stacking: background at the bottom, the speaker and power bank above the pedestal they stand on; z is consecutive.
    const z = (name: string) => layers.find(l => l.name === name)!.zIndex;
    expect(layers.map(l => l.zIndex)).toEqual(layers.map((_, i) => i));
    expect(z('Bluetooth speaker')).toBeGreaterThan(z('Display pedestal'));
    expect(z('Power bank')).toBeGreaterThan(z('Display pedestal'));
    // layers.json carries the same provenance, additively.
    const json = JSON.parse(readFileSync(join(s.dir, 'layers.json'), 'utf8'));
    expect(json).toMatchObject({ canvas: { width: 1024, height: 1024 }, refinement: { passesExecuted: 2, residualPasses: 1, stopReason: 'clean', background: { status: 'ai-reconstructed' } } });
    expect(json.layers.map((l: { provenance: { sourcePass: number } }) => l.provenance.sourcePass).filter((p: number) => p === 1)).toHaveLength(2);
  }, 60_000);

  it('builds the foreground union mask from every foreground layer, grown a little, and sends it with the original once', async () => {
    const s = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: ['speaker', 'powerBank'] }] });
    const run = readRun(s.dir), mask = join(s.dir, 'foreground-mask.png');
    expect(run.refinement!.mask).toMatchObject({ file: 'foreground-mask.png', dilatePx: 8, featherPx: 4 });
    expect(run.refinement!.mask!.layers).toHaveLength(9);
    // Removed: inside every product (headphone cup, speaker, power bank, watch face, gift box, text). Kept: open background.
    for (const [x, y] of [[290, 400], [635, 650], [360, 680], [812, 650], [100, 640], [500, 77]]) expect(await pixel(mask, Math.round(x * 1.024), Math.round(y * 1.024)), `${x},${y}`).toBe(255);
    for (const [x, y] of [[40, 250], [960, 700], [500, 980], [200, 50]]) expect(await pixel(mask, Math.round(x * 1.024), Math.round(y * 1.024)), `${x},${y}`).toBe(0);
    // Exactly one background edit: the original image, a same-size mask transparent where objects are, the compact prompt.
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    const [edit] = s.edits;
    expect(edit.prompt).toBe(CLEAN_BACKGROUND_PROMPT);
    expect(edit.size).toEqual({ width: 1024, height: 1024 });
    const [image, alpha] = await Promise.all([sharp(edit.image).metadata(), sharp(edit.mask).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true })]);
    expect([image.width, image.height, alpha.info.width, alpha.info.height]).toEqual([1024, 1024, 1024, 1024]);
    expect(alpha.data[Math.round(650 * 1.024) * 1024 + Math.round(635 * 1.024)]).toBe(0);
    expect(alpha.data[Math.round(250 * 1.024) * 1024 + Math.round(40 * 1.024)]).toBe(255);
    expect(await difference(edit.image, s.original)).toBeLessThan(0.5);
    for (const word of ['reconstruct only the underlying background', 'Do not recreate the removed products', 'do not add any new product, person, text, logo']) expect(CLEAN_BACKGROUND_PROMPT).toContain(word);
  }, 60_000);

  it('a resume or re-render reuses the saved residual pass and background edit and sends nothing new', async () => {
    const s = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: ['speaker', 'powerBank'] }] });
    const before = readRun(s.dir), background = readFileSync(join(s.dir, 'clean-background.png'));
    const again = await resumeRun(s.dir, s.deps);
    expect(s.transport.submit).toHaveBeenCalledTimes(2);
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(again.calls).toEqual(before.calls);
    expect(again.outputLayers!.map(l => [l.file, l.zIndex, l.provenance?.sourcePass])).toEqual(before.outputLayers!.map(l => [l.file, l.zIndex, l.provenance?.sourcePass]));
    expect(again.refinement!.background!.status).toBe('ai-reconstructed');
    expect(readFileSync(join(s.dir, 'clean-background.png')).equals(background)).toBe(true);
  }, 60_000);
});

describe('recursive decomposition: when to recurse and when to stop', () => {
  it('a clean first pass does not recurse and keeps Seedream\'s clean base: no extra call at all', async () => {
    const s = await scenario({ passes: [{ parts: ALL_PARTS, base: [] }] });
    const run = readRun(s.dir);
    expect(run.refinement).toMatchObject({ passesExecuted: 1, stopReason: 'clean', passes: [] });
    expect(run.calls).toEqual({ fitCheck: 0, planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
    expect(s.reconstruct).not.toHaveBeenCalled();
    expect(run.outputLayers![0]).toMatchObject({ file: 'layer-00.png', cleanBackground: { status: 'provider-clean', method: 'provider-base' } });
    expect(run.outputLayers![0].rawFile).toBeUndefined();
    expect(existsSync(join(s.dir, 'clean-background.png'))).toBe(false);
    // Seedream's own order and z-indexes are kept when nothing was added.
    expect(run.outputLayers!.map(l => l.zIndex)).toEqual(run.outputLayers!.map((_, i) => i));
    expect(names(run)).toEqual(['Background', ...ALL_PARTS.map(partName)]);
  }, 60_000);

  it('an unchanged Seedream base reuses residual 1\'s assessment, and it equals a fresh assessment of that base', async () => {
    const A = gridFor({ width: 1024, height: 1024 }, 640);
    // Clean, and with a gift box Seedream left in its base that the residual pass did not return either.
    for (const [passes, verdict] of [[[{ parts: ALL_PARTS, base: [] }], 'clean'], [[{ parts: WITHOUT('giftBox'), base: ['giftBox'] }, { parts: [], base: ['giftBox'] }], 'contaminated']] as const) {
      const s = await scenario({ passes: passes as unknown as Pass[] }), run = readRun(s.dir);
      expect(run.refinement!.background).toMatchObject({ method: 'provider-base', status: verdict === 'clean' ? 'provider-clean' : 'contaminated' });
      const shapes = await Promise.all(run.outputLayers!.slice(1).map(async l => (await layerShape(readFileSync(join(s.dir, l.file)), l, A)).alpha));
      const fresh = assessBackgroundContamination({ rgb: await rgbOnGrid(readFileSync(join(s.dir, 'layer-00.png')), A), width: A.width, height: A.height, explained: unionOf(shapes, A.width * A.height) }, CONTAMINATION);
      const { regions, ...summary } = fresh;
      expect(run.refinement!.background!.residual).toEqual({ ...summary, regions: regions.length });
      expect(fresh.verdict).toBe(verdict);
    }
  }, 60_000);

  it('a clean base that still duplicates its layers is reconstructed once, without recursion', async () => {
    const s = await scenario({ passes: [{ parts: ALL_PARTS, base: ALL_PARTS }] });
    const run = readRun(s.dir);
    expect(run.refinement).toMatchObject({ passesExecuted: 1, stopReason: 'clean', background: { status: 'ai-reconstructed', needed: true } });
    expect(run.calls).toMatchObject({ seedreamResidual: 0, backgroundReconstruction: 1 });
  }, 60_000);

  it('a second residual still contaminated gets a bounded second pass', async () => {
    const s = await scenario({ passes: [
      { parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS },
      { parts: ['speaker'], base: ['powerBank'] },
      { parts: ['powerBank'], base: [] },
    ] });
    const run = readRun(s.dir);
    expect(run.refinement).toMatchObject({ passesExecuted: 3, stopReason: 'clean' });
    expect(run.refinement!.passes.map(p => [p.pass, p.state, p.accepted.length])).toEqual([[1, 'done', 1], [2, 'done', 1]]);
    expect(run.refinement!.assessments.map(a => a.verdict)).toEqual(['contaminated', 'contaminated', 'clean']);
    expect(passOf(run, 'Power bank')).toBe(2);
    expect(run.calls).toMatchObject({ seedreamInitial: 1, seedreamResidual: 2, backgroundReconstruction: 1 });
  }, 60_000);

  it('stops at the maximum depth: never a third residual call, and the leftover is reported as contamination', async () => {
    const s = await scenario({ passes: [
      { parts: WITHOUT('speaker', 'powerBank', 'giftBox'), base: ALL_PARTS },
      { parts: ['speaker'], base: ['powerBank', 'giftBox'] },
      { parts: ['powerBank'], base: ['giftBox'] },
    ] });
    const run = readRun(s.dir);
    expect(MAX_RESIDUAL_PASSES).toBe(2);
    expect(run.refinement).toMatchObject({ passesExecuted: 3, stopReason: 'max-depth' });
    expect(run.refinement!.assessments.at(-1)).toMatchObject({ residual: 'residual-final.png', verdict: 'contaminated', sent: false });
    expect(s.submitted).toHaveLength(3);
    // The gift box is in no layer, so the background honestly says it is still contaminated.
    expect(run.refinement!.background).toMatchObject({ status: 'contaminated', contaminated: true });
    expect(run.warnings.some(w => w.startsWith('BACKGROUND_CONTAMINATED: '))).toBe(true);
    // A run asking for one residual pass gets one.
    const one = await scenario({ refinement: { maxDepth: 1 }, passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: ['speaker'], base: ['powerBank'] }] });
    expect(readRun(one.dir).refinement).toMatchObject({ passesExecuted: 2, stopReason: 'max-depth' });
    expect(one.submitted).toHaveLength(2);
    // Larger depths are clamped to the hard cap.
    expect(refinementOptions({ maxDepth: 9 })!.maxDepth).toBe(2);
  }, 90_000);

  it('a residual pass that returns only duplicates, or nothing, stops the recursion', async () => {
    const duplicates = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: [], base: ['speaker', 'powerBank'], extra: [{ name: 'Wireless headphones', part: 'headphones' }, { name: 'Smartwatch', part: 'watch' }] }] });
    expect(readRun(duplicates.dir).refinement).toMatchObject({ passesExecuted: 2, stopReason: 'all-duplicates' });
    expect(names(readRun(duplicates.dir)).filter(name => name === 'Wireless headphones' || name === 'Smartwatch')).toHaveLength(2);
    const nothing = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: [], base: ['speaker', 'powerBank'] }] });
    const run = readRun(nothing.dir);
    expect(run.refinement).toMatchObject({ passesExecuted: 2, stopReason: 'no-new-layers' });
    expect(nothing.submitted).toHaveLength(2);
    expect(run.refinement!.background!.status).toBe('contaminated');
  }, 60_000);
});

describe('recursive decomposition: failures keep what worked', () => {
  it('a failed residual pass keeps every earlier layer and still cleans the background', async () => {
    const s = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, 'fail-result'] });
    const run = readRun(s.dir);
    expect(run.stage).toBe('done');
    expect(names(run)).toHaveLength(8);
    expect(run.refinement).toMatchObject({ stopReason: 'pass-failed', passesExecuted: 1 });
    expect(run.refinement!.passes[0]).toMatchObject({ pass: 1, state: 'failed', requestId: 'req-1', error: { code: 'FAL_RESULT_FAILED' } });
    expect(run.calls).toMatchObject({ seedreamResidual: 1, backgroundReconstruction: 1 });
    expect(run.warnings.some(w => w.startsWith('RESIDUAL_PASS_FAILED: pass 1'))).toBe(true);
    // A submission that never got a request ID is recorded as failed; it is counted and not resubmitted.
    const lost = await scenario({ passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, 'fail-submit'] });
    expect(readRun(lost.dir).refinement!.passes[0]).toMatchObject({ state: 'failed', error: { code: 'FAL_SUBMIT_FAILED' } });
    expect(readRun(lost.dir).calls!.seedreamResidual).toBe(1);
    expect(lost.transport.submit).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('a failed background edit falls back to a local fill, clearly marked fallback, and is not retried', async () => {
    const s = await scenario({ edit: 'fail', passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }, { parts: ['speaker', 'powerBank'] }] });
    const run = readRun(s.dir);
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(run.calls!.backgroundReconstruction).toBe(1);
    expect(run.outputLayers![0]).toMatchObject({ file: 'clean-background.png', cleanBackground: { status: 'fallback', method: 'local-fill' } });
    expect(run.refinement!.reconstruction).toMatchObject({ state: 'failed', error: { code: 'BACKGROUND_RECONSTRUCTION_FAILED', message: 'OpenAI image edit returned 500' } });
    expect(run.refinement!.background!.reasons.join(' ')).toMatch(/Fell back to a local fill because the OpenAI image edit failed/);
    expect(run.warnings.some(w => w.startsWith('BACKGROUND_FALLBACK: '))).toBe(true);
    // The fallback still removes the products (a blurrier fill, not a pretend-clean AI background).
    expect(await difference(readFileSync(join(s.dir, 'clean-background.png')), await offerBackground())).toBeLessThan(6);
    // A re-render does not retry the failed edit.
    await resumeRun(s.dir, s.deps);
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(readRun(s.dir).refinement!.background!.status).toBe('fallback');
    // Without any reconstructor the same fallback applies, with no call counted.
    const none = await scenario({ edit: 'none', passes: [{ parts: ALL_PARTS, base: ALL_PARTS }] });
    expect(readRun(none.dir)).toMatchObject({ calls: { backgroundReconstruction: 0 }, refinement: { background: { status: 'fallback', method: 'local-fill' } } });
  }, 90_000);
});

describe('recursive decomposition: unrefined runs are unchanged', () => {
  it('a run without the refinement option renders exactly as before: no refinement, no call record, no extra files', async () => {
    const s = await scenario({ refinement: false, passes: [{ parts: WITHOUT('speaker', 'powerBank'), base: ALL_PARTS }] });
    const run = readRun(s.dir);
    expect(run.stage).toBe('done');
    expect(run).not.toHaveProperty('refinement');
    expect(run).not.toHaveProperty('calls');
    expect(s.submitted).toHaveLength(1);
    expect(run.outputLayers![0]).toMatchObject({ file: 'layer-00.png', placement: { kind: 'base' } });
    expect(run.outputLayers!.every(l => l.provenance === undefined && l.cleanBackground === undefined)).toBe(true);
    for (const file of ['clean-background.png', 'residual-pass-1.png', 'decomposition-debug.json', 'foreground-mask.png']) expect(existsSync(join(s.dir, file))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(s.dir, 'layers.json'), 'utf8')))).toEqual(['canvas', 'warnings', 'layers']);
  }, 60_000);

  it('the upload route only refines when asked, and validates the field', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'recursive-route-'));
    const transport = { upload: async () => 'https://v3b.fal.media/files/test/x.png', submit: async () => { throw new Error('not in this test'); }, status: async () => 'COMPLETED' as const, result: async () => ({}), cancel: async () => undefined, download: async () => Buffer.alloc(0) } satisfies FalTransport;
    const server = express().use('/x', createLayerizeRouter({ runsDir, deps: () => ({ planner, transport: () => transport, sleep: async () => undefined }) })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo, image = new Blob([new Uint8Array(await offerComposite())], { type: 'image/png' });
      const post = async (recursive?: string) => {
        const form = new FormData();
        form.append('templateKey', 'template-b');
        if (recursive !== undefined) form.append('recursive', recursive);
        form.append('image', image, 'offer.png');
        const response = await fetch(`http://127.0.0.1:${port}/x/runs`, { method: 'POST', body: form });
        const body = await response.json();
        if (response.ok) for (let i = 0; i < 100 && (await (await fetch(`http://127.0.0.1:${port}/x/runs`)).json()).active; i++) await new Promise(done => setTimeout(done, 20));
        return { status: response.status, body };
      };
      expect((await post()).body).not.toHaveProperty('refinement');
      expect((await post('false')).body).not.toHaveProperty('refinement');
      const refined = (await post('true')).body;
      expect(refined.refinement).toMatchObject({ version: 1, state: 'pending', options: { maxDepth: 2, maxTotalLayers: 32, reconstructBackground: true } });
      expect(refined.calls).toEqual({ fitCheck: 0, planner: 0, seedreamInitial: 0, seedreamResidual: 0, backgroundReconstruction: 0 });
      expect(await post('maybe')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_RECURSIVE' } } });
    } finally { server.close(); }
  }, 30_000);
});

describe('contamination, masks and request sizes', () => {
  const A = gridFor({ width: 1024, height: 1024 }, 640);
  const assess = async (parts: OfferPart[], explainedParts: OfferPart[] = []) => {
    const explained = new Uint8Array(A.width * A.height);
    for (const part of explainedParts) {
      const alpha = await sharp(await offerPart(part)).resize(A.width, A.height, { fit: 'fill' }).extractChannel(3).raw().toBuffer();
      for (let i = 0; i < alpha.length; i++) if (alpha[i] > 127) explained[i] = 1;
    }
    return assessBackgroundContamination({ rgb: await rgbOnGrid(await offerComposite(parts), A), width: A.width, height: A.height, explained }, CONTAMINATION);
  };
  it('a smooth gradient is clean; scattered confetti is not an object; a leftover product is, with where it is', async () => {
    expect((await assess([])).verdict).toBe('clean');
    expect((await assess(['confetti'])).contaminated).toBe(false);
    const speaker = await assess(['speaker']);
    expect(speaker).toMatchObject({ contaminated: true, verdict: 'contaminated' });
    expect(speaker.regions[0]).toMatchObject({ position: 'center' });
    expect(speaker.regions[0].confidence).toBeGreaterThanOrEqual(0.5);
    // Already extracted: the same pixels no longer count.
    expect((await assess(['speaker'], ['speaker'])).contaminated).toBe(false);
  });
  it('mask edges: exact geometry of the grow (square, r px) and the feather (box, f px) around a pixel-exact object', () => {
    const w = 100, h = 100, object = new Uint8Array(w * h);
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) object[y * w + x] = 1;
    // Grown by 6: exactly the square 34–65 in both directions (32×32), nothing else.
    const core = grow(object, w, h, 6);
    const expectedCore = new Uint8Array(w * h);
    for (let y = 34; y <= 65; y++) for (let x = 34; x <= 65; x++) expectedCore[y * w + x] = 1;
    expect(Array.from(core)).toEqual(Array.from(expectedCore));
    // Feathered by 3 (a 7-px box): along the middle row, alpha = 255 × (core pixels in [x-3, x+3]) / 7, rounded.
    const alpha = featherMask(core, w, h, 3), row = (from: number, to: number) => Array.from(alpha.slice(50 * w + from, 50 * w + to + 1));
    expect(row(28, 41)).toEqual([0, 0, 0, 36, 73, 109, 146, 182, 219, 255, 255, 255, 255, 255]);
    // Mirror image on the right: the core ends at 65, so 62 is the last full pixel and 69 the first untouched one.
    expect(row(58, 71)).toEqual([255, 255, 255, 255, 255, 219, 182, 146, 109, 73, 36, 0, 0, 0]);
    // Every object pixel, and everything within (grow − feather) = 3 px of it, is fully replaced; nothing beyond grow + feather is touched.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const outside = Math.max(40 - x, x - 59, 40 - y, y - 59, 0);
      if (outside <= 3) expect(alpha[y * w + x], `${x},${y}`).toBe(255);
      if (outside > 9) expect(alpha[y * w + x], `${x},${y}`).toBe(0);
    }
  });
  it('the production mask path is exact for a pixel-exact layer: coverage → grow → edit mask (transparent = remove)', async () => {
    const canvas = { width: 64, height: 48 }, grid = gridFor(canvas, 2048);
    // A layer whose opaque pixels are exactly x 10–19, y 8–23 (full-canvas placement).
    const rgba = Buffer.alloc(64 * 48 * 4);
    for (let y = 8; y < 24; y++) for (let x = 10; x < 20; x++) rgba.set([20, 20, 20, 255], (y * 64 + x) * 4);
    const png = await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
    const coverage = await coverageOnGrid([{ png, placement: { kind: 'full-canvas', x: 0, y: 0, width: 64, height: 48 } }], grid);
    const core = grow(coverage, 64, 48, 2), expected = new Uint8Array(64 * 48);
    for (let y = 6; y < 26; y++) for (let x = 8; x < 22; x++) expected[y * 64 + x] = 1;
    expect(Array.from(core)).toEqual(Array.from(expected));
    // The edit request at the canvas size: alpha 0 exactly on the grown core, 255 everywhere else.
    const { mask, image } = await editInputs(await offerBackground(64, 48), { map: core, width: 64, height: 48 }, { width: 64, height: 48 });
    const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer();
    expect(Array.from(alpha)).toEqual(Array.from(expected, v => (v ? 0 : 255)));
    expect(await sharp(image).metadata()).toMatchObject({ width: 64, height: 48 });
  });
  it('classifies scene layers as background and every movable layer, even a frame-filling hero, as foreground', () => {
    const grid = { width: 100, height: 100, scale: 1 };
    const shape = (x0: number, y0: number, x1: number, y1: number) => {
      const alpha = new Uint8Array(100 * 100);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * 100 + x] = 1;
      return { alpha, rgba: Buffer.alloc(0), count: (x1 - x0) * (y1 - y0), box: { x0, y0, x1, y1 } };
    };
    const layer = (name: string) => ({ index: 1, file: 'l.png', zIndex: 1, name, pixelWidth: 100, pixelHeight: 100, opaquePercent: 50, placement: { kind: 'full-canvas' as const, x: 0, y: 0, width: 100, height: 100 } });
    const full = shape(0, 0, 100, 100), panel = shape(10, 10, 90, 90), small = shape(40, 40, 60, 60);
    expect(classify(layer('Orange gradient background'), full, grid)).toEqual({ kind: 'background', role: 'background' });
    expect(classify(layer('Untitled layer'), full, grid)).toEqual({ kind: 'background', role: 'background' });
    expect(classify(layer('Inner backdrop'), panel, grid)).toEqual({ kind: 'background', role: 'inner background' });
    expect(classify(layer('Hero product close-up'), full, grid)).toEqual({ kind: 'foreground', role: 'product' });
    expect(classify(layer('Background confetti'), small, grid)).toEqual({ kind: 'foreground', role: 'decor' });
    expect(classify(layer('MEGA SALE headline'), small, grid)).toEqual({ kind: 'foreground', role: 'text' });
    expect(classify(layer('Display pedestal'), small, grid)).toEqual({ kind: 'foreground', role: 'support' });
  });
  it('edit sizes are multiples of 16 within the model limits, and an extreme aspect gets no edit', () => {
    expect(reconstructionSize({ width: 1024, height: 1024 })).toEqual({ width: 1024, height: 1024 });
    expect(reconstructionSize({ width: 1216, height: 1520 })).toEqual({ width: 1216, height: 1520 });
    expect(reconstructionSize({ width: 4096, height: 4096 })).toEqual({ width: 1920, height: 1920 });
    expect(reconstructionSize({ width: 800, height: 600 })).toEqual({ width: 1184, height: 896 });
    expect(reconstructionSize({ width: 4000, height: 1000 })).toBeUndefined();
  });
});
