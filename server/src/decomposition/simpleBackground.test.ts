import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BLUE_GHOST, BLUE_PANEL, BLUE_PANEL_WITH_SLAB, BLUE_PARTS, creative, LAVENDER_PARTS, OFFER_PARTS, OFFER_PATCH, OFFER_SPECKLES, part, partPng, plannedAnalysis, PLASTER_WALL, refinedRun } from './simpleBackground.fixture.js';

const B = (key: string) => part(BLUE_PARTS, key), L = (key: string) => part(LAVENDER_PARTS, key), O = (key: string) => part(OFFER_PARTS, key);
const at = (x: number, y: number) => Math.round(y * 1.024) * 1024 + Math.round(x * 1.024);
const raw = async (file: string | Buffer) => sharp(file).removeAlpha().raw().toBuffer();
const lum = (rgb: Buffer, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
const diff = (a: Buffer, b: Buffer, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
/** Share (%) of the background that is a darker ghost of the true one (a silhouette, a shadow, a blob). */
const darker = (background: Buffer, truth: Buffer) => { let n = 0; for (let i = 0; i < truth.length / 3; i++) if (lum(background, i) < lum(truth, i) - 12) n++; return 100 * n / (truth.length / 3); };
/** Pixels (count) of the background within 10 of a color: a grey slab, a product left behind. */
const near = (background: Buffer, [r, g, b]: number[]) => { let n = 0; for (let i = 0; i < background.length / 3; i++) if (Math.abs(background[i * 3] - r) < 10 && Math.abs(background[i * 3 + 1] - g) < 10 && Math.abs(background[i * 3 + 2] - b) < 10) n++; return n; };
const names = (run: Awaited<ReturnType<typeof refinedRun>>['run']) => run.outputLayers!.map(l => l.name);
const womanPlan = (extra: [string, string][] = []) => plannedAnalysis('A woman in front of a plain blue-purple wall under a headline.', [['blue_wall', 'background'], ...extra, ['woman', 'person'], ['headline_text', 'text']]);

describe('a person on a plain branded wall (blue-purple)', () => {
  it('1/4/7. her ghost and shadow in Seedream\'s base are rejected; the plain wall continues behind her and where her shadow was; no call', async () => {
    const s = await refinedRun(await creative(BLUE_PARTS), womanPlan(), [{ base: [B('wall'), B('shadow'), BLUE_GHOST], layers: [B('woman'), B('headline')] }]);
    const b = s.run.refinement!.background!;
    expect(b.candidates.find(c => c.method === 'provider-base')!.reasons).toContain('silhouette-residue');
    expect(b).toMatchObject({ status: 'continued-clean', method: 'plain-field', quality: 'usable', aiTried: false, fallbackUsed: false });
    expect(b.shadow!.percent).toBeGreaterThan(1);
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
    expect(s.reconstruct).not.toHaveBeenCalled();
    const [clean, wall] = await Promise.all([raw(join(s.dir, 'clean-background.png')), raw(await creative([B('wall')]))]);
    for (const [x, y] of [[510, 700], [510, 300], [400, 650], [700, 120]]) expect(diff(clean, wall, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(8);
    expect(darker(clean, wall)).toBeLessThan(0.3);
    expect(names(s.run)).toEqual(['Background', 'Woman in yellow top', 'White NEW ARRIVALS headline text']);
    expect(s.run.refinement!.layerPlan).toMatchObject({ editableLayers: 3, dropped: [], backgroundKind: 'plain' });
  }, 60_000);

  it('6. a base that is already clean is kept as returned: no repair, no reconstruction file, no extra layer, no call', async () => {
    const s = await refinedRun(await creative(BLUE_PARTS), womanPlan(), [{ base: [B('wall')], layers: [B('shadow'), B('woman'), B('headline')] }]);
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean', method: 'provider-base', needed: false });
    expect(existsSync(join(s.dir, 'clean-background.png'))).toBe(false);
    expect(s.run.calls).toMatchObject({ seedreamResidual: 0, backgroundReconstruction: 0 });
    // Her shadow goes with her, not into a layer of its own.
    expect(names(s.run)).toEqual(['Background', 'Woman in yellow top + Soft shadow of the woman', 'White NEW ARRIVALS headline text']);
    expect(s.run.outputLayers![1].semantic).toMatchObject({ id: 'woman', type: 'person' });
    expect(s.run.outputLayers![1].grouping?.parent).toBe('layer-02.png');
  }, 60_000);

  it('7. a wall panel returned with a grey slab hidden behind her is not kept: hiding her shows the panel continued, never grey', async () => {
    const original = await creative([B('wall'), BLUE_PANEL, B('woman'), B('headline')]);
    const s = await refinedRun(original, womanPlan([['light_wall_panel', 'background panel']]), [{ base: [B('wall')], layers: [BLUE_PANEL_WITH_SLAB, B('woman'), B('headline')] }]);
    expect(s.run.refinement!.layerPlan!.dropped).toEqual([expect.objectContaining({ name: 'Light blue wall panel', reason: 'filler-behind-subject', action: 'fold' })]);
    expect(names(s.run)).toEqual(['Background', 'Woman in yellow top', 'White NEW ARRIVALS headline text']);
    const background = await raw(join(s.dir, s.run.outputLayers![0].file)), panel = await raw(await creative([B('wall'), BLUE_PANEL]));
    for (const [x, y] of [[510, 700], [510, 420], [300, 600]]) expect(diff(background, panel, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(8);
    expect(near(background, [0x9c, 0xa3, 0xaf])).toBe(0);
    // Where the headline covered the panel's top-right corner, its top edge and side continue straight to the corner.
    for (const [x, y] of [[700, 150], [800, 170], [700, 128], [900, 160], [830, 145]]) expect(diff(background, panel, at(x, y)), `corner ${x},${y}`).toBeLessThanOrEqual(12);
    expect(s.run.calls).toMatchObject({ seedreamResidual: 0, backgroundReconstruction: 0 });
  }, 60_000);
});

describe('a gradient product shot (lavender): the background\'s own design is not a leftover', () => {
  const plan = (extra: [string, string][] = []) => plannedAnalysis('A lavender phone on a white platform in a lavender studio.', [['studio_background', 'background'], ['lavender_phone', 'product'], ...extra]);

  it('2/6. every planned element extracted: the platform and circles are the background\'s design — no residual pass, no repair, not "contaminated"', async () => {
    const s = await refinedRun(await creative(LAVENDER_PARTS), plan(), [{ base: [L('backdrop')], layers: [L('phone')] }]);
    expect(s.submitted).toHaveLength(1);
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
    expect(s.run.refinement!.planCoverage).toEqual({ planned: ['lavender_phone'], matched: { lavender_phone: 'layer-01.png' }, complete: true });
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean', contaminated: false });
    expect(s.run.refinement!.background!.residual.verdict).not.toBe('contaminated');
    expect(s.run.outputLayers![0].cleanBackground).toEqual({ status: 'provider-clean', method: 'provider-base' });
  }, 60_000);

  it('a missing planned element alone does not spend a residual call on the background’s soft shapes', async () => {
    const s = await refinedRun(await creative(LAVENDER_PARTS), plan([['gift_box', 'product']]), [{ base: [L('backdrop')], layers: [L('phone')] }, { base: [L('backdrop')], layers: [] }]);
    expect(s.run.refinement!.planCoverage).toMatchObject({ complete: false });
    expect(s.run.calls!.seedreamResidual).toBe(0);
    expect(s.run.refinement).toMatchObject({ stopReason: 'residue-only' });
  }, 60_000);

  it('2. Seedream\'s base still shows the phone: the gradient and platform continue where it stood, with no call and no trace of it', async () => {
    const s = await refinedRun(await creative(LAVENDER_PARTS), plan(), [{ base: LAVENDER_PARTS, layers: [L('phone')] }]);
    const b = s.run.refinement!.background!;
    expect(b).toMatchObject({ status: 'continued-clean', quality: 'usable', aiTried: false });
    expect(s.run.calls).toMatchObject({ seedreamResidual: 0, backgroundReconstruction: 0 });
    const [clean, backdrop] = await Promise.all([raw(join(s.dir, 'clean-background.png')), raw(await creative([L('backdrop')]))]);
    expect(near(clean, [0x51, 0x46, 0x61]) + near(clean, [0x29, 0x24, 0x31])).toBe(0);
    for (const [x, y] of [[500, 400], [420, 600], [600, 300]]) expect(diff(clean, backdrop, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(10);
    expect(darker(clean, backdrop)).toBeLessThan(0.5);
    // No lighter ghost of the phone either: down its middle the gradient continues, not the platform's white.
    for (let y = 250; y <= 650; y += 50) expect(diff(clean, backdrop, at(500, y)), `column ${y}`).toBeLessThanOrEqual(6);
  }, 60_000);
});

describe('a person on a textured wall: a local fill would smear it, so a dirty base gets the one reconstruction', () => {
  const plan = () => plannedAnalysis('A woman in front of a textured plaster wall.', [['plaster_wall', 'background'], ['woman', 'person']]);
  const scene = () => [PLASTER_WALL, B('woman')];
  /** Mean difference from the true wall where she stood (her body, away from her edges). */
  const behindHer = async (file: string) => {
    const [clean, wall, alpha] = await Promise.all([raw(file), raw(await creative([PLASTER_WALL])), sharp(await partPng(B('woman'))).ensureAlpha().extractChannel(3).raw().toBuffer()]);
    let sum = 0, n = 0; for (let i = 0; i < alpha.length; i++) if (alpha[i] === 255) { sum += diff(clean, wall, i); n++; }
    return sum / n;
  };

  it('Seedream\'s base still shows her: the local continuation is not trusted, the one image edit runs and is used, and every step says why', async () => {
    const s = await refinedRun(await creative(scene()), plan(), [{ base: scene(), layers: [B('woman')] }], { truth: await creative([PLASTER_WALL]) });
    const b = s.run.refinement!.background!;
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 1 });
    expect(b).toMatchObject({ status: 'ai-reconstructed', method: 'ai-reconstruction', quality: 'usable', fallbackUsed: false, aiTried: true, trust: { trusted: false } });
    expect(b.trust!.reason).toMatch(/cannot be continued reliably by a local fill/);
    expect(b.steps!.map(step => [step.step, step.outcome])).toEqual([['provider-base', 'rejected'], ['scene-composite', 'skipped'], ['local-continuation', 'skipped'], ['ai-reconstruction', 'chosen']]);
    expect(b.steps![0].reason).toMatch(/still shows Woman in yellow top/);
    expect(b.steps![2].reason).toMatch(/The reconstruction pass runs instead\.$/);
    expect(b.steps![3]).toMatchObject({ call: true, reason: 'The image edit is usable.' });
    expect(await behindHer(join(s.dir, 'clean-background.png'))).toBeLessThan(4);
  }, 60_000);

  it('without a reconstruction the local fill is only a fallback: never reported clean, and the run asks for a review', async () => {
    const s = await refinedRun(await creative(scene()), plan(), [{ base: scene(), layers: [B('woman')] }], 'none');
    const b = s.run.refinement!.background!;
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(b).toMatchObject({ status: 'fallback', quality: 'degraded', fallbackUsed: true, aiTried: false });
    expect(b.candidates.find(c => c.chosen)!.reasons).toContain('untrusted-continuation');
    expect(b.steps!.find(step => step.step === 'ai-reconstruction')).toMatchObject({ outcome: 'skipped', call: false, reason: 'No background reconstructor is configured.' });
    expect(b.steps!.at(-1)).toMatchObject({ step: 'fallback', outcome: 'chosen' });
    expect(b.reasons.join(' ')).toMatch(/Review it: it is not a verified clean background\./);
  }, 60_000);

  it('a clean base on the same wall costs nothing: no reconstruction, the provider base is kept', async () => {
    const s = await refinedRun(await creative(scene()), plan(), [{ base: [PLASTER_WALL], layers: [B('woman')] }], { truth: await creative([PLASTER_WALL]) });
    const b = s.run.refinement!.background!;
    expect(s.reconstruct).not.toHaveBeenCalled();
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(b).toMatchObject({ status: 'provider-clean', method: 'provider-base', quality: 'usable' });
    expect(b.steps!.map(step => [step.step, step.outcome])).toEqual([['provider-base', 'chosen'], ['scene-composite', 'skipped'], ['local-continuation', 'skipped'], ['ai-reconstruction', 'skipped']]);
    expect(b.steps!.slice(1).every(step => /^Not needed/.test(step.reason))).toBe(true);
  }, 60_000);
});

describe('a flat offer creative with text areas', () => {
  it('3/6/C. product, badge, headline and button stay editable; background noise split into layers folds back; the clean base is kept; no call', async () => {
    const original = await creative([O('yellow'), OFFER_PATCH, OFFER_SPECKLES, ...OFFER_PARTS.slice(1)]);
    const analysis = plannedAnalysis('A purple gift box on a flat yellow offer.', [['yellow_background', 'background'], ['gift_box', 'product'], ['price_badge', 'badge'], ['headline_text', 'text'], ['shop_now_button', 'button']]);
    const s = await refinedRun(original, analysis, [{ base: [O('yellow')], layers: [OFFER_PATCH, OFFER_SPECKLES, ...OFFER_PARTS.slice(1)] }]);
    expect(names(s.run)).toEqual(['Background', 'Purple gift box product', 'Red 50% OFF price badge', 'Black MEGA DEAL headline text', 'Black SHOP NOW button']);
    expect(Object.fromEntries(s.run.refinement!.layerPlan!.dropped.map(d => [d.name, d.reason]))).toEqual({ 'Soft yellow background shape': 'background-fragment', 'Background texture dots': 'background-fragment' });
    expect(s.run.refinement!.layerPlan).toMatchObject({ editableLayers: 5, backgroundKind: 'plain' });
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean' });
    expect(s.run.calls).toMatchObject({ seedreamResidual: 0, backgroundReconstruction: 0 });
  }, 60_000);
});
