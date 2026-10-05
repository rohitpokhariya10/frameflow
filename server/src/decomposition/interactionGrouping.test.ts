import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import type { LayerInfo } from './layerizeArtifacts.js';
import { createRun, executeRun, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { compositeOnGrid, fidelity, flattenRgba, gridFor, layerShape, rgbOnGrid } from './backgroundContamination.js';
import { groupInteractions, type InteractionEntry } from './interactionGrouping.js';
import { PROTECTION_CLAUSE, semanticPlan } from './semanticPlanner.js';
import { semanticFixture } from './semanticPlanner.fixture.js';
import { rowFillEdit } from './complexOffer.fixture.js';
import { BAG_PART, BANGLE_PARTS, bangleAnalysis, creative, HOLDING_PARTS, holdingAnalysis, part, partPng, WOMAN_ARM_PART, WOMAN_BODY_PART, WOMAN_WITH_FINGERS } from './protectedInteraction.fixture.js';

const CANVAS = { width: 1024, height: 1024 }, A = gridFor(CANVAS, 640);
type Part = (typeof HOLDING_PARTS)[number];
const full = { kind: 'full-canvas' as const, x: 0, y: 0, width: 1024, height: 1024 };
/** Provider layers for these parts, z 1.. in the given order (the base is not an entry). */
async function entries(parts: Part[]): Promise<InteractionEntry[]> {
  return Promise.all(parts.map(async (p, i) => {
    const png = await partPng(p), layer: LayerInfo = { index: i + 1, file: `layer-${String(i + 1).padStart(2, '0')}.png`, zIndex: i + 1, name: p.name, pixelWidth: 1024, pixelHeight: 1024, opaquePercent: 10, placement: full };
    return { layer, png, shape: await layerShape(png, layer, A) };
  }));
}
const grouped = async (parts: Part[], original: Part[], options = { heldObjects: true }, semantic?: ReturnType<typeof holdingAnalysis>) =>
  groupInteractions({ dir: mkdtempSync(join(tmpdir(), 'interactions-')), canvas: CANVAS, grid: A, entries: await entries(parts), original: await rgbOnGrid(await creative(original), A), semantic, options });
const names = (list: InteractionEntry[]) => list.map(e => e.layer.name);
const groupOf = (list: InteractionEntry[], member: string) => list.find(e => e.layer.grouping?.members.some(m => m.name === member));
/** The stack as an image on the analysis grid. */
const stack = async (list: InteractionEntry[]) => flattenRgba(await compositeOnGrid([...list].sort((a, b) => a.layer.zIndex - b.layer.zIndex).map(e => ({ png: e.png, placement: e.layer.placement })), A));
const H = (key: string) => part(HOLDING_PARTS, key), B = (key: string) => part(BANGLE_PARTS, key);

describe('planner: protected people are enforced in code, not trusted from prose', () => {
  it('a phone held with fingers across it, its screen badge and the grip fragments stay with the woman; the prompt is rebuilt to say so', () => {
    const plan = semanticPlan(holdingAnalysis('high'));
    expect(plan.planned_layers.map(l => l.name)).toEqual(['background_white', 'yellow_field', 'headline_text', 'cta_pill', 'woman_base']);
    expect(plan.semantic_protection.merged).toEqual(expect.arrayContaining([
      { id: 'phone_grip_foreground', parent: 'woman_base', reason: 'finger_fragment' }, { id: 'phone_device', parent: 'woman_base', reason: 'held_object' },
      { id: 'success_badge', parent: 'woman_base', reason: 'attached_part' }]));
    expect(plan.semantic_protection).toMatchObject({ promptRebuilt: true, clauseAppended: true });
    expect(plan.prompt).toMatch(/^Create 5 layers back-to-front: /);
    expect(plan.prompt).toMatch(/\(5\) woman base as seen in the creative together with (phone grip foreground|phone device|success badge)(, (phone grip foreground|phone device|success badge)){2} in the same layer/);
    expect(plan.prompt).not.toMatch(/finger fragments;/);
    expect(plan.prompt.endsWith(PROTECTION_CLAUSE)).toBe(true);
    expect(plan.prompt.length).toBeLessThanOrEqual(2000);
    expect(plan.warnings).toEqual(expect.arrayContaining(['PROTECTED: phone_device stays with woman_base (held object).']));
    // The model's own analysis is kept for debugging, unchanged.
    expect(plan.semantic_analysis).toEqual(holdingAnalysis('high'));
  });

  it('fingers across a phone make it held even when the model rated the split low risk', () => {
    const plan = semanticPlan(holdingAnalysis('low'));
    expect(plan.semantic_protection.merged.find(m => m.id === 'phone_device')).toEqual({ id: 'phone_device', parent: 'woman_base', reason: 'held_object' });
  });

  it('a clean low-risk hold with no grip across the object stays separate, with the model\'s prompt', () => {
    const plan = semanticPlan(semanticFixture);
    expect(plan.planned_layers.map(l => l.name)).toEqual(['phone', 'person']);
    expect(plan.semantic_protection).toEqual({ merged: [], promptRebuilt: false, clauseAppended: true });
    expect(plan.prompt).toBe(`${semanticFixture.downstream_decomposition_prompt} ${PROTECTION_CLAUSE}`);
  });

  it('worn bangles stay with their hands; a standalone bangle and the headline stay separate', () => {
    const plan = semanticPlan(bangleAnalysis());
    expect(plan.planned_layers.map(l => l.name)).toEqual(['background_red', 'left_hands', 'center_hands', 'right_hands', 'standalone_bangle', 'main_headline']);
    expect(plan.semantic_protection.merged).toEqual([
      { id: 'left_bangles', parent: 'left_hands', reason: 'worn_ornament' }, { id: 'center_bangles', parent: 'center_hands', reason: 'worn_ornament' }, { id: 'right_bangles', parent: 'right_hands', reason: 'worn_ornament' }]);
    expect(plan.prompt).toContain('(2) left hands as seen in the creative together with left bangles in the same layer');
  });

  it('rejects a dangling attachment parent; a rebuilt prompt stays within the provider limit with long descriptions', () => {
    const dangling = holdingAnalysis();
    dangling.elements[5].attachment.parent_id = 'nobody';
    expect(() => semanticPlan(dangling)).toThrow(/attachments/);
    const long = holdingAnalysis();
    for (const e of long.elements) e.description = `${e.id} ${'with a very long and detailed visual description of colors, edges and position '.repeat(12)}`;
    const plan = semanticPlan(long);
    expect(plan.semantic_protection.promptRebuilt).toBe(true);
    expect(plan.prompt.length).toBeLessThanOrEqual(2000);
    expect(plan.prompt.endsWith(PROTECTION_CLAUSE)).toBe(true);
  });
});

describe('grouping: what Seedream returned, made safe', () => {
  it('woman + phone + screen badge + finger fragments become one protected layer; the tiny chevron joins its pill; text stays', async () => {
    const parts = ['field', 'woman', 'phone', 'badge', 'fingers', 'headline', 'pill', 'get', 'chevron'].map(H);
    const input = await entries(parts), result = await grouped(parts, HOLDING_PARTS);
    expect(result.record).toMatchObject({ layersBefore: 9, layersAfter: 5, groups: 2 });
    const woman = groupOf(result.entries, 'Woman base')!;
    expect(woman.layer.grouping).toMatchObject({ groupedWithParent: true, protectedInteraction: 'hand_holding_object' });
    expect(woman.layer.grouping!.members.map(m => [m.name, m.role])).toEqual([['Woman base', 'parent'], ['Smartphone with white screen', 'held_object'],
      ['Green success badge on the screen', 'object_content'], ['Foreground gripping finger fragments', 'finger_fragment']]);
    expect(woman.layer.grouping!.members[1].reason).toMatch(/finger fragments cross it/);
    expect(groupOf(result.entries, 'White CTA chevron')!.layer.grouping!.members.map(m => [m.name, m.role])).toEqual([['Navy rounded CTA pill', 'parent'], ['White CTA chevron', 'attached_fragment']]);
    expect(names(result.entries).filter(n => /finger|chevron|Smartphone|badge/i.test(n!) && !/\+/.test(n!))).toEqual([]);
    expect(names(result.entries)).toEqual(expect.arrayContaining(['Bright yellow curved decorative field', 'Black headline text', 'Small white GET text']));
    // Visual integrity: the grouped stack looks exactly like the provider's stack.
    expect(fidelity(await stack(input), await stack(result.entries)).meanAbsDiff).toBeLessThan(0.5);
    // The group holds the whole hand: palm (behind the phone) and fingers (in front of it) are opaque in it.
    const alpha = (await sharp(woman.png).extractChannel(3).raw().toBuffer({ resolveWithObject: true })).data, at = (x: number, y: number) => alpha[Math.round(y * 1.024) * 1024 + Math.round(x * 1.024)];
    expect([at(410, 640), at(485, 549), at(455, 589)]).toEqual([255, 255, 255]);
  });

  it('without a fragment layer, fingers drawn into the woman but rendered behind the phone are caught by the interleave check', async () => {
    const parts = [WOMAN_WITH_FINGERS, H('phone'), H('badge')];
    const result = await grouped(parts, HOLDING_PARTS.filter(p => ['background', 'woman', 'phone', 'badge', 'fingers'].includes(p.key)));
    const woman = groupOf(result.entries, 'Smartphone with white screen')!;
    expect(woman.layer.grouping!.protectedInteraction).toBe('hand_holding_object');
    expect(woman.layer.grouping!.members[1].reason).toMatch(/the stack hides \d+ hand pixels the original shows in front of it/);
  });

  it('a bag held below the hand, with nothing across it, is a clean split and stays separate (recorded)', async () => {
    const parts = [H('woman'), BAG_PART];
    for (const semantic of [undefined, { ...holdingAnalysis(), elements: [...holdingAnalysis().elements.filter(e => e.id === 'woman_base'),
      { ...holdingAnalysis().elements[5], id: 'purple_shopping_bag', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'held_in_hand' as const, parent_id: 'woman_base', separation_risk: 'low' as const, keep_with_parent: false } }],
      relationships: [] }]) {
      const result = await grouped(parts, [H('background'), H('woman'), BAG_PART], { heldObjects: true }, semantic);
      expect(result.groups).toHaveLength(0);
      expect(result.record.decisions).toEqual([expect.objectContaining({ decision: 'kept-separate', role: 'clean_split', name: 'Purple shopping bag', parent: 'layer-01.png' })]);
    }
  });

  it('a hand and forearm returned on their own go back into the woman; the bag she holds cleanly stays separate', async () => {
    const parts = [WOMAN_BODY_PART, WOMAN_ARM_PART, BAG_PART];
    const input = await entries(parts), result = await grouped(parts, [H('background'), H('woman'), BAG_PART]);
    expect(result.entries.map(e => e.layer.name)).toEqual(['Woman base + Left hand and forearm', 'Purple shopping bag']);
    expect(groupOf(result.entries, 'Left hand and forearm')!.layer.grouping!.members.map(m => [m.name, m.role])).toEqual([['Woman base', 'parent'], ['Left hand and forearm', 'body_part']]);
    expect(result.record.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'kept-separate', role: 'clean_split', name: 'Purple shopping bag' })]));
    expect(fidelity(await stack(input), await stack(result.entries)).meanAbsDiff).toBeLessThan(0.5);
    // Pairs of hands with no whole person are never folded into each other.
    const hands = await grouped([part(BANGLE_PARTS, 'leftHands'), part(BANGLE_PARTS, 'centerHands')], BANGLE_PARTS);
    expect(hands.groups).toHaveLength(0);
  });

  it('a run that asked for a separate held object keeps the phone and its grip as they are', async () => {
    const result = await grouped(['woman', 'phone', 'fingers'].map(H), HOLDING_PARTS, { heldObjects: false });
    expect(result.groups).toHaveLength(0);
    expect(result.record.decisions.map(d => [d.name, d.decision])).toEqual(expect.arrayContaining([['Foreground gripping finger fragments', 'kept-separate'], ['Smartphone with white screen', 'kept-separate']]));
  });

  it('bangles worn on hands join their hands; the standalone bangle and the headline that names bangles stay; small flowers become one group', async () => {
    const parts = BANGLE_PARTS.filter(p => p.key !== 'background'), input = await entries(parts);
    const result = await grouped(parts, BANGLE_PARTS);
    expect(result.record).toMatchObject({ layersBefore: 11, layersAfter: 6, groups: 4 });
    for (const [hands, bangles] of [['Left paired hands', 'Left Coorgi gold bangle stack'], ['Center crossed hands', 'Center South-Indian gold bangle cluster'], ['Right paired hands', 'Right Bengali gold bangle stack']]) {
      expect(groupOf(result.entries, bangles)!.layer.grouping!.members.map(m => [m.name, m.role])).toEqual([[hands, 'parent'], [bangles, 'worn_ornament']]);
      expect(groupOf(result.entries, bangles)!.layer.grouping!.protectedInteraction).toBeUndefined();
    }
    expect(names(result.entries)).toEqual(expect.arrayContaining(['Standalone gold bangle product', '"BANGLES OF INDIA" headline']));
    expect(result.record.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'kept-separate', role: 'standalone_ornament', name: 'Standalone gold bangle product' })]));
    expect(groupOf(result.entries, 'Small red flower accent')!.layer.grouping!.members.map(m => m.role)).toEqual(['parent', 'decoration', 'decoration']);
    // No worn-ornament layer is left on its own, and the picture is unchanged.
    expect(names(result.entries).filter(n => /bangle (stack|cluster)/.test(n!) && !n!.includes('+'))).toEqual([]);
    expect(fidelity(await stack(input), await stack(result.entries)).meanAbsDiff).toBeLessThan(0.5);
  });
});

describe('runner with fake providers: planner, Seedream, recursion, background and provenance', () => {
  /** A semantic, refined run; the planner answers `analysis`, Seedream answers the scripted splits in turn. */
  async function run(original: Buffer, analysis: unknown, passes: { base: Part[]; layers: Part[] }[]) {
    const files: Record<string, Buffer> = {}, answers = new Map<string, unknown>(), submitted: Record<string, unknown>[] = [];
    const transport = {
      upload: vi.fn(async () => 'https://v3b.fal.media/files/test/upload.png'),
      submit: vi.fn<FalTransport['submit']>(async (_endpoint, input) => {
        const step = passes[submitted.length]; if (!step) throw new Error(`Unexpected Seedream submission #${submitted.length + 1}.`);
        const requestId = `req-${submitted.length}`; submitted.push(input);
        const layers: unknown[] = [];
        const add = async (name: string, png: Buffer) => { const url = `https://v3b.fal.media/files/test/${requestId}-${layers.length}.png`; files[url] = png; layers.push({ image: { url }, z_index: layers.length, name }); };
        await add('Background', await creative(step.base));
        for (const p of step.layers) await add(p.name, await partPng(p));
        answers.set(requestId, { layers });
        return { requestId };
      }),
      status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async (_e: string, id: string) => answers.get(id)), cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
    } satisfies FalTransport;
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(analysis) }));
    const reconstruct = vi.fn(async (request: { image: Buffer; mask: Buffer }) => ({ image: await rowFillEdit(request.image, request.mask) }));
    const deps: RunnerDeps = { planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined, backgroundReconstructor: { model: 'test-edit', reconstruct } };
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'protected-run-')), original, { mode: 'generated' }, { templateKey: 'template-b', semanticPlanning: true, refinement: true });
    await executeRun(dir, deps);
    return { dir, run: readRun(dir), submitted, reconstruct };
  }

  it('recharge creative: Seedream gets the protected prompt; its bad split still ends as one intact person-with-phone layer', async () => {
    const original = await creative(HOLDING_PARTS);
    const s = await run(original, holdingAnalysis('high'), [{ base: [H('background')], layers: ['field', 'woman', 'phone', 'badge', 'fingers', 'headline', 'pill', 'get', 'chevron'].map(H) }]);
    expect(s.run.stage).toBe('done');
    expect(String(s.submitted[0].prompt)).toMatch(/together with .* in the same layer.*Keep every person whole/);
    const layers = s.run.outputLayers!;
    expect(layers).toHaveLength(6);
    const woman = layers.find(l => l.name?.startsWith('Woman base + Smartphone with white screen + Green success badge on the screen + Foreground gripping'))!;
    expect(layers.filter(l => !l.grouping).map(l => l.name)).toEqual(['Background', 'Bright yellow curved decorative field', 'Black headline text', 'Small white GET text']);
    // "GET" lies between the pill and its chevron and on the pill: the pill group goes behind it, so the text stays visible.
    const pill = layers.find(l => l.name === 'Navy rounded CTA pill + White CTA chevron')!, get = layers.find(l => l.name === 'Small white GET text')!;
    expect(pill.zIndex).toBeLessThan(get.zIndex);
    expect(s.run.interactions!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'parent', reason: expect.stringMatching(/^Small white GET text lies between its members; placed at the back-most member's depth/) })]));
    expect(woman).toMatchObject({ file: 'group-01.png', grouping: { groupedWithParent: true, protectedInteraction: 'hand_holding_object', parent: 'layer-02.png' }, provenance: { sourcePass: 0, role: 'unknown' } });
    expect(s.run.interactions).toMatchObject({ layersBefore: 9, layersAfter: 5, groups: 2 });
    // No recursion was spent on the grip, and the person stays whole in the reconstruction.
    expect(s.run.refinement).toMatchObject({ passesExecuted: 1, stopReason: 'clean' });
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0 });
    expect(s.run.refinement!.fidelity!.after.meanAbsDiff).toBeLessThan(1);
    // layers.json and the debug file carry the grouping for tuning.
    const json = JSON.parse(readFileSync(join(s.dir, 'layers.json'), 'utf8'));
    expect(json.layers.find((l: LayerInfo) => l.file === woman.file).grouping.members.map((m: { role: string }) => m.role)).toEqual(['parent', 'held_object', 'object_content', 'finger_fragment']);
    expect(json.refinement.protectedGroups).toBe(2);
    expect(JSON.parse(readFileSync(join(s.dir, 'decomposition-debug.json'), 'utf8')).interactions.groups).toBe(2);
    expect(existsSync(join(s.dir, 'group-01.png'))).toBe(true);
  }, 60_000);

  it('jewelry creative: bangles a residual pass finds join their hands instead of becoming layers; the background is cleaned once', async () => {
    const original = await creative(BANGLE_PARTS);
    const bangles = ['leftBangles', 'centerBangles', 'rightBangles'].map(B);
    const s = await run(original, bangleAnalysis(), [
      // Seedream leaves the bangles baked into its base and returns the hands and the rest.
      { base: [B('background'), ...bangles], layers: ['leftHands', 'centerHands', 'rightHands', 'standalone', 'headline', 'flower1', 'flower2', 'flower3'].map(B) },
      { base: [B('background')], layers: bangles },
    ]);
    expect(String(s.submitted[0].prompt)).toContain('together with left bangles in the same layer');
    expect(s.run.refinement).toMatchObject({ passesExecuted: 2 });
    expect(s.run.refinement!.passes[0].accepted).toHaveLength(3);
    const layers = s.run.outputLayers!;
    expect(layers).toHaveLength(7);
    expect(layers.filter(l => /bangle (stack|cluster)/.test(l.name ?? '') && !l.grouping)).toEqual([]);
    for (const hands of ['Left paired hands', 'Center crossed hands', 'Right paired hands']) {
      const group = layers.find(l => l.grouping?.parent && l.name?.startsWith(hands))!;
      expect(group.grouping!.members.map(m => m.role)).toEqual(['parent', 'worn_ornament']);
      expect(group.grouping!.members[1].file).toMatch(/^pass-1-layer-0\d\.png$/);
    }
    expect(layers.map(l => l.name)).toEqual(expect.arrayContaining(['Standalone gold bangle product', '"BANGLES OF INDIA" headline']));
    // The bangles are in front of the forearms inside each group (stacking evidence across passes).
    const left = readFileSync(join(s.dir, layers.find(l => l.name?.startsWith('Left paired hands'))!.file));
    const { data } = await sharp(left).raw().toBuffer({ resolveWithObject: true }), px = (x: number, y: number) => Array.from(data.subarray((Math.round(y * 1.024) * 1024 + Math.round(x * 1.024)) * 4, (Math.round(y * 1.024) * 1024 + Math.round(x * 1.024)) * 4 + 3));
    expect(px(190, 548)).toEqual([0xd4, 0xa0, 0x17]);
    // Seedream's base still showed the bangles: judged per layer (not per hands+bangles group), so the background is rebuilt.
    expect(s.run.refinement!.background!.baseRetention.filter(r => /bangle (stack|cluster)/.test(r.name ?? '')).every(r => r.retainedPercent >= 90)).toBe(true);
    expect(s.run.refinement!.background).toMatchObject({ status: 'ai-reconstructed', needed: true, contaminated: false });
    expect(s.run.calls).toMatchObject({ seedreamResidual: 1, backgroundReconstruction: 1 });
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
  }, 60_000);
});
