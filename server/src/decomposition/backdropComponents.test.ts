import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateStructure, TemplateVersion } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { createRun, executeRun, type RunnerDeps } from './layerizeExperiment.js';
import type { Planner } from './layerizePlanner.js';
import { gridFor, layerShape } from './backgroundContamination.js';
import { backdropComponents, keepShapesFree, planRoles, type BackdropDecision, type BackdropItem } from './backdropComponents.js';
import { plannedLayerIssues } from './recursiveDecomposition.js';
import { compileTemplatePlan, templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './creativeTemplates/compile.js';
import type { LayerInfo } from './layerizeArtifacts.js';

// Synthetic creatives (no provider): a base canvas, backdrop shapes placed on it, and a person in front. Colours vary on
// purpose: nothing in the rule may depend on white or orange.
const W = 600, H = 750, grid = gridFor({ width: W, height: H }, 640);
const svg = (body: string, background?: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${background ? `<rect width="${W}" height="${H}" fill="${background}"/>` : ''}${body}</svg>`);
const png = (body: string, background?: string) => sharp(svg(body, background)).png().toBuffer();
const PANEL = (fill: string) => `<rect x="40" y="190" width="520" height="450" rx="36" fill="${fill}"/>`;
const GRADIENT_PANEL = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6913f"/><stop offset="1" stop-color="#f0561a"/></linearGradient></defs><rect x="40" y="190" width="520" height="450" rx="36" fill="url(#g)"/>';
const SHADOW = '<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="12"/></filter></defs><rect x="48" y="204" width="520" height="450" rx="36" fill="#000" opacity="0.35" filter="url(#s)"/>';
/** A person: a striped torso and a head, textured (photographic-ish), overlapping the panel and the base below it. */
const PERSON = '<defs><pattern id="st" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a3401d"/><rect width="4" height="8" fill="#7d2c12"/></pattern></defs><ellipse cx="330" cy="560" rx="120" ry="190" fill="url(#st)"/><circle cx="330" cy="300" r="70" fill="#e0b39a"/>';

const layer = (file: string, name: string, semantic?: { id: string }): BackdropItem['layer'] =>
  ({ file, name, placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H }, ...(semantic ? { semantic: { ...semantic, type: 'x', editableIndependently: true } } : {}) });
const item = async (file: string, name: string, image: Buffer, semantic?: { id: string }): Promise<BackdropItem> => {
  const l = layer(file, name, semantic);
  return { layer: l, shape: await layerShape(image, l as LayerInfo, grid), kind: 'background' };
};
const componentsOf = (decisions: ReturnType<typeof backdropComponents>) => decisions.filter(d => d.component).map(d => d.name);

describe('backdrop components: which large scene layers are their own layer', () => {
  const roles = planRoles({ elements: [{ id: 'canvas', type: 'background' }, { id: 'panel', type: 'backdrop' }] } as never);

  it('white base + orange panel: the plan\'s backdrop is a component, the base canvas never is', async () => {
    const decisions = backdropComponents([
      await item('base.png', 'Global canvas background', await png(PANEL('#fafafa')), { id: 'canvas' }),
      await item('panel.png', 'Wide rounded orange gradient backdrop', await png(GRADIENT_PANEL), { id: 'panel' }),
    ], grid, roles);
    expect(decisions.map(d => [d.name, d.component, d.basis])).toEqual([['Global canvas background', false, 'plan'], ['Wide rounded orange gradient backdrop', true, 'plan']]);
  });

  it('any colours, without a plan: a solid inset panel is a component by its shape alone', async () => {
    for (const fill of ['#1aa39a', '#2b2d6e', '#f2c94c', '#ffffff']) {
      const decisions = backdropComponents([await item('panel.png', 'Rounded backdrop', await png(PANEL(fill)))], grid);
      expect(decisions[0], fill).toMatchObject({ component: true, basis: 'shape', edges: 0 });
    }
  });

  it('several backdrop shapes are each their own layer: a panel, a circle and a corner wedge', async () => {
    const decisions = backdropComponents([
      await item('panel.png', 'Rounded panel backdrop', await png('<rect x="60" y="420" width="480" height="260" rx="30" fill="#7c3aed"/>')),
      await item('circle.png', 'Circular gradient backdrop', await png('<circle cx="300" cy="250" r="190" fill="#22c55e"/>')),
      await item('wedge.png', 'Corner wedge background shape', await png(`<path d="M${W} 0 L${W} 380 L320 0Z" fill="#f43f5e"/>`)),
    ], grid);
    expect(componentsOf(decisions)).toEqual(['Rounded panel backdrop', 'Circular gradient backdrop', 'Corner wedge background shape']);
    expect(decisions.find(d => d.name?.startsWith('Corner'))!.edges).toBe(2);
  });

  it('a simple background stays the base: a full-canvas gradient plate, a wall and floor that tile the canvas, a soft glow', async () => {
    const plate = backdropComponents([await item('plate.png', 'Studio gradient background', await png('<defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect width="600" height="750" fill="url(#b)"/>'))], grid);
    expect(plate[0]).toMatchObject({ component: false, reason: expect.stringContaining('base canvas') });
    // A wall (3 edges) and a floor (3 edges): regions of the scene, never shapes placed on it.
    const scene = backdropComponents([
      await item('wall.png', 'Blue wall background', await png('<rect width="600" height="470" fill="#3b82f6"/>')),
      await item('floor.png', 'Wooden floor background', await png('<rect y="470" width="600" height="280" fill="#a16207"/>')),
    ], grid);
    expect(componentsOf(scene)).toEqual([]);
    expect(scene.every(d => d.reason.includes('3 canvas edges'))).toBe(true);
    const glow = backdropComponents([await item('glow.png', 'Soft glow background', await png('<defs><radialGradient id="r"><stop offset="0" stop-color="#fde68a" stop-opacity="0.7"/><stop offset="1" stop-color="#fde68a" stop-opacity="0"/></radialGradient></defs><circle cx="300" cy="380" r="260" fill="url(#r)"/>'))], grid);
    expect(glow[0]).toMatchObject({ component: false, reason: expect.stringContaining('soft') });
  });

  it('a reused plan names roles, not content: a backdrop it asks for that no layer matched is the largest solid scene layer left', async () => {
    // A curved field reaching three edges is part of the scene by its shape alone, but the plan asks for a backdrop.
    const field = await item('field.png', 'Bright yellow curved decorative field', await png('<path d="M600 0 L600 750 L312 750 C420 570 456 315 600 0Z" fill="#facc15"/>'));
    expect(backdropComponents([field], grid)[0]).toMatchObject({ component: false, edges: 3 });
    expect(backdropComponents([field], grid, roles, ['backdrop'])[0]).toMatchObject({ component: true, basis: 'plan', role: 'backdrop', reason: expect.stringContaining('asks for its own backdrop') });
    // Never the base: a layer the plan matched to its canvas, a soft glow, or one covering the canvas cannot take the slot.
    const base = await item('base.png', 'Global canvas background', await png(PANEL('#fafafa')), { id: 'canvas' });
    const soft = await item('glow.png', 'Soft glow', await png('<circle cx="300" cy="380" r="200" fill="#fde68a" fill-opacity="0.4"/>'));
    expect(componentsOf(backdropComponents([base, soft], grid, roles, ['backdrop']))).toEqual([]);
    // One slot, one layer: the largest unmatched one.
    const small = await item('small.png', 'Small decorative field', await png('<rect x="420" y="20" width="160" height="120" fill="#22c55e"/>'));
    expect(componentsOf(backdropComponents([small, field], grid, roles, ['backdrop']))).toEqual(['Small decorative field', 'Bright yellow curved decorative field']);
    expect(backdropComponents([small, field], grid, roles, ['backdrop']).find(d => d.name === 'Small decorative field')).toMatchObject({ basis: 'shape' });
  });

  it('a photographic or textured surface without a plan is part of the scene, and shapes covering the canvas together are the scene', async () => {
    const noise = await sharp({ create: { width: 520, height: 450, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
    const textured = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: noise, left: 40, top: 190 }]).png().toBuffer();
    expect(backdropComponents([await item('photo.png', 'Photo backdrop', textured)], grid)[0]).toMatchObject({ component: false, basis: 'shape', reason: expect.stringContaining('textured') });
    // Two plan backdrops that between them cover 90% of the canvas leave no base to reveal.
    const both = backdropComponents([
      await item('left.png', 'Left panel backdrop', await png('<rect width="300" height="700" fill="#0ea5e9"/>'), { id: 'panel' }),
      await item('right.png', 'Right panel backdrop', await png('<rect x="300" width="300" height="700" fill="#f97316"/>'), { id: 'panel' }),
    ], grid, roles);
    expect(componentsOf(both)).toEqual([]);
    expect(both[0].reason).toContain('they are the scene itself');
  });
});

describe('incidental shapes never add a paid rebuild', () => {
  const decision = (file: string, basis: BackdropDecision['basis']): BackdropDecision => ({ file, component: true, basis, reason: '', areaPercent: 20, edges: 0, solidPercent: 99, smoothness: 1 });
  it('a shape-only component stays in the base when separating it would make a free rebuild paid; planned ones never do', () => {
    const decisions = [decision('circle.png', 'shape'), decision('panel.png', 'plan')];
    // Trusted without the circle, untrusted with it: the circle stays in the base, the planned panel is still separate.
    const kept = keepShapesFree(decisions, shapes => !shapes.length);
    expect(kept.map(d => [d.file, d.component])).toEqual([['circle.png', false], ['panel.png', true]]);
    expect(kept[0].reason).toContain('paid edit');
    // Free either way, or paid either way (one edit in both cases): separated.
    expect(keepShapesFree(decisions, () => true).every(d => d.component)).toBe(true);
    expect(keepShapesFree(decisions, () => false).every(d => d.component)).toBe(true);
  });
});

describe('requested versus returned layers', () => {
  const semantic = { elements: [
    { id: 'background', type: 'background', editable_independently: true, attachment: { keep_with_parent: false } },
    { id: 'backdrop', type: 'backdrop', editable_independently: true, attachment: { keep_with_parent: false } },
    { id: 'primary_subject', type: 'primary_subject', editable_independently: true, attachment: { keep_with_parent: false } },
    { id: 'held_object', type: 'held_object', editable_independently: false, attachment: { keep_with_parent: true } },
  ] } as never;
  const roleOf = planRoles(semantic);
  it('a requested backdrop that was returned but left out, or never returned, is a quality issue; one that is an editor layer is not', () => {
    const raw = [{ file: 'panel.png', name: 'Orange panel', semantic: { id: 'backdrop', type: 'backdrop', editableIndependently: true } }, { file: 'person.png', name: 'Person', semantic: { id: 'primary_subject', type: 'primary_subject', editableIndependently: true } }];
    const person = raw[1];
    expect(plannedLayerIssues(semantic, roleOf, [], raw, [person, raw[0]], [])).toEqual([]);
    expect(plannedLayerIssues(semantic, roleOf, [], raw, [person], [{ file: 'panel.png', category: 'scene', kept: false, reason: 'merged-into-background', detail: 'a full background plate' }]))
      .toEqual(['PLANNED_LAYER_MERGED: the plan\'s backdrop was returned ("Orange panel") but is not a layer of its own: a full background plate.']);
    expect(plannedLayerIssues(semantic, roleOf, [], [person], [person], []))
      .toEqual(['PLANNED_LAYER_MISSING: the plan\'s backdrop has no layer of its own: the provider merged it into another layer or did not return it.']);
    // A held object kept with its person, and an element merged by protection, are not expected as layers.
    expect(plannedLayerIssues(semantic, roleOf, ['backdrop'], [person], [person], [])).toEqual([]);
  });
});

/** The base, the panel and the person, as one creative and as the layers a fake Seedream returns. */
type Look = { base: string; panel: string; shadow?: boolean; seedreamBase?: 'clean' | 'with-panel'; returnPanel?: boolean };
async function decompose(look: Look, plan: 'template' | 'none') {
  const panelBody = `${look.shadow ? SHADOW : ''}${look.panel === 'gradient' ? GRADIENT_PANEL : PANEL(look.panel)}`;
  const original = await png(`${panelBody}${PERSON}`, look.base);
  const answers: { name: string; png: Buffer }[] = [
    { name: 'Background', png: await png(look.seedreamBase === 'with-panel' ? panelBody : '', look.base) },
    { name: 'Global canvas background', png: await png(PANEL(look.base)) },
    ...(look.returnPanel === false ? [] : [{ name: 'Rounded decorative panel backdrop', png: await png(panelBody) }]),
    { name: 'Person', png: await png(PERSON) },
  ];
  const files: Record<string, Buffer> = {}, submitted: unknown[] = [];
  const transport = {
    upload: vi.fn(async () => 'https://v3b.fal.media/files/test/upload.png'),
    submit: vi.fn<FalTransport['submit']>(async (_e, input) => { submitted.push(input); return { requestId: `req-${submitted.length}` }; }),
    status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async (_e: string, id: string) => ({ layers: answers.map((a, z) => { const url = `https://v3b.fal.media/files/test/${id}-${z}.png`; files[url] = a.png; return { image: { url }, z_index: z, name: a.name }; }) })),
    cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
  } satisfies FalTransport;
  const reconstruct = vi.fn(async () => { throw new Error('No background edit is expected here.'); });
  const planner: Planner = async () => ({ plan: { prompt: 'Separate the person, the panel and the background.', planned_layers: [], warnings: [] }, model: 'test-planner', raw: {}, request: {} });
  const deps: RunnerDeps = { planner: plan === 'template' ? async () => { throw new Error('A reused plan never calls the planner.'); } : planner, transport: () => transport, sleep: async () => undefined, backgroundReconstructor: { model: 'test-image-edit', reconstruct } };
  const structure: TemplateStructure = { relationships: [], layers: [
    { id: 'background', role: 'background', zone: 'full-canvas', order: 0, independent: true, required: false },
    { id: 'backdrop', role: 'backdrop', zone: 'center', order: 1, independent: true, required: false },
    { id: 'primary_subject', role: 'primary_subject', zone: 'center', order: 2, independent: true, required: true }] };
  const version: TemplateVersion = { templateId: 'tpl-aaaaaaaaaaaa', version: 1, createdAt: new Date().toISOString(), name: 'Subject on a panel', description: 'A person in front of a panel on a canvas', structure,
    plan: { prompt: templatePlanPrompt(structure), strategy: templatePlanStrategy(structure), recommendedLayers: 3 }, generationPrompt: { text: templateEditPrompt(structure) },
    decomposition: { refinement: true, expectedEditorLayers: { min: 2, max: 5 } }, source: { runId: 'learned', executionId: 'learned', plannerModel: 'offline' } };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'backdrop-')), original, plan === 'template' ? compileTemplatePlan(version) : { mode: 'generated' }, { refinement: true,
    ...(plan === 'template' ? { templateExecution: { executionId: 'reuse', mode: 'REUSE_TEMPLATE_ORIGINAL' as const, template: { id: version.templateId, version: 1, name: version.name } } } : {}) });
  const run = await executeRun(dir, deps);
  const raw = async (file: string) => sharp(join(dir, file)).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  /** The editor's layers composited (optionally without one, or with one moved) on a transparent canvas, as raw RGBA. */
  const compose = async (skip?: string, move?: { file: string; dx: number; dy: number }) => sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(await Promise.all(run.outputLayers!.filter(l => l.file !== skip).map(async l => {
      const p = l.placement, input = await sharp(join(dir, l.file)).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer();
      return { input, left: p.x + (move?.file === l.file ? move.dx : 0), top: p.y + (move?.file === l.file ? move.dy : 0) };
    }))).raw().toBuffer();
  return { dir, run, original: await sharp(original).ensureAlpha().raw().toBuffer(), raw, compose, reconstruct, submitted };
}
const at = (rgba: Buffer, x: number, y: number) => [0, 1, 2, 3].map(c => rgba[(y * W + x) * 4 + c]);
const hex = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const near = (pixel: number[], rgb: number[], tolerance = 14) => rgb.every((v, c) => Math.abs(pixel[c] - v) <= tolerance);
const meanDiff = (a: Buffer, b: Buffer) => { let sum = 0, n = 0; for (let i = 0; i < a.length; i += 4) { for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]); n += 3; } return sum / n; };
/** Points inside the panel that the person never covers, and outside the panel on the base. */
const PANEL_POINTS: [number, number][] = [[80, 230], [520, 230], [90, 600], [150, 400]], BASE_POINTS: [number, number][] = [[20, 20], [300, 120], [580, 700], [300, 720]];

describe('backdrop separation through the real refinement (fake Seedream, no calls)', () => {
  it('white base + orange gradient panel (reused plan): base, panel and person are separate; hiding or moving the panel reveals the clean base', async () => {
    const s = await decompose({ base: '#fbfbfa', panel: 'gradient' }, 'template');
    expect(s.run.stage).toBe('done');
    expect(s.run.outputLayers!.map(l => l.name)).toEqual(['Background', 'Rounded decorative panel backdrop', 'Person']);
    expect(s.run.refinement!.backdrops!.find(d => d.component)).toMatchObject({ basis: 'plan', role: 'backdrop' });
    expect(s.run.refinement!.background).toMatchObject({ method: 'provider-base', status: 'provider-clean' });
    expect(s.run.calls).toMatchObject({ planner: 0, seedreamResidual: 0, backgroundReconstruction: 0 });
    // The base is the white canvas everywhere, including under the panel; the panel is transparent outside its shape.
    const background = await s.raw(s.run.outputLayers![0].file), panel = await s.raw(s.run.outputLayers![1].file);
    for (const [x, y] of [...PANEL_POINTS, ...BASE_POINTS]) expect(near(at(background, x, y), hex('#fbfbfa')), `base at ${x},${y}`).toBe(true);
    for (const [x, y] of BASE_POINTS) expect(at(panel, x, y)[3], `panel alpha at ${x},${y}`).toBe(0);
    // Reconstruction keeps the approved look; without the panel the base shows, with no orange left behind.
    expect(meanDiff(await s.compose(), s.original)).toBeLessThan(2);
    const hidden = await s.compose(s.run.outputLayers![1].file);
    for (const [x, y] of PANEL_POINTS) expect(near(at(hidden, x, y), hex('#fbfbfa')), `hidden panel at ${x},${y}`).toBe(true);
    const moved = await s.compose(undefined, { file: s.run.outputLayers![1].file, dx: 0, dy: 100 });
    expect(near(at(moved, 80, 230), hex('#fbfbfa'))).toBe(true);
    expect(s.run.warnings.filter(w => w.startsWith('PLANNED_LAYER_'))).toEqual([]);
  }, 60_000);

  it('another colour pair without any plan (navy base, teal panel): separated by shape, not by colour', async () => {
    const s = await decompose({ base: '#1e2a5a', panel: '#19a59b' }, 'none');
    expect(s.run.outputLayers!.map(l => l.name)).toEqual(['Background', 'Rounded decorative panel backdrop', 'Person']);
    expect(s.run.refinement!.backdrops!.find(d => d.component)).toMatchObject({ basis: 'shape' });
    const hidden = await s.compose(s.run.outputLayers![1].file);
    for (const [x, y] of PANEL_POINTS) expect(near(at(hidden, x, y), hex('#1e2a5a')), `hidden panel at ${x},${y}`).toBe(true);
    expect(meanDiff(await s.compose(), s.original)).toBeLessThan(2);
  }, 60_000);

  it('a base that still shows the panel is never kept: the plain base continues under it with no paid edit', async () => {
    const s = await decompose({ base: '#ffffff', panel: '#ef6c2a', seedreamBase: 'with-panel' }, 'template');
    expect(s.run.outputLayers!.map(l => l.name)).toEqual(['Background', 'Rounded decorative panel backdrop', 'Person']);
    expect(s.run.refinement!.background!.method).not.toBe('provider-base');
    expect(s.reconstruct).not.toHaveBeenCalled();
    const background = await s.raw(s.run.outputLayers![0].file);
    for (const [x, y] of PANEL_POINTS) expect(near(at(background, x, y), hex('#ffffff'), 20), `base under the panel at ${x},${y}`).toBe(true);
  }, 60_000);

  it('a panel with a soft drop shadow keeps its shadow in its own layer; the base under it is clean', async () => {
    const s = await decompose({ base: '#ffffff', panel: '#f2c94c', shadow: true }, 'template');
    expect(s.run.outputLayers!.map(l => l.name)).toEqual(['Background', 'Rounded decorative panel backdrop', 'Person']);
    const panel = await s.raw(s.run.outputLayers![1].file), background = await s.raw(s.run.outputLayers![0].file);
    // The shadow's soft edge below the panel is partly transparent in the panel layer, not baked into the base.
    const edge = at(panel, 300, 652);
    expect(edge[3]).toBeGreaterThan(10); expect(edge[3]).toBeLessThan(200);
    expect(near(at(background, 300, 652), hex('#ffffff'), 10)).toBe(true);
    expect(meanDiff(await s.compose(), s.original)).toBeLessThan(2.5);
  }, 60_000);

  it('a provider that returns no panel layer is reported, never read as a complete decomposition', async () => {
    const s = await decompose({ base: '#ffffff', panel: '#ef6c2a', seedreamBase: 'with-panel', returnPanel: false }, 'template');
    expect(s.run.stage).toBe('done');
    expect(s.run.outputLayers!.map(l => l.name)).not.toContain('Rounded decorative panel backdrop');
    expect(s.run.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^PLANNED_LAYER_MISSING: the plan's backdrop has no layer of its own/)]));
  }, 60_000);
});
