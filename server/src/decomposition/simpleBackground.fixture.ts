/**
 * Deterministic simple-background creatives for the clean-background and layer-usefulness tests, in the shapes offer
 * creatives take: a person in front of a plain blue-purple wall (with a soft shadow), a lavender gradient product shot
 * with soft circles and a platform, and a flat yellow offer with a product, a price badge, text and a button. Each part
 * renders on its own; a creative is its parts painted back to front. `refinedRun` runs the real runner with every provider
 * faked (planner, Seedream, the image edit) and counts the calls.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { createRun, executeRun, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';
import { rowFillEdit } from './complexOffer.fixture.js';
import { ghostEdit } from './peopleShadow.fixture.js';

export type Part = { key: string; name: string; svg: string };
const SKIN = '#d99a6c';
const blur = (id: string, std: number) => `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${std}"/></filter></defs>`;
export const render = (body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`)).png().toBuffer();
export const creative = (parts: Part[]) => render(parts.map(p => p.svg).join(''));
export const partPng = (part: Part) => render(part.svg);
export const part = (parts: Part[], key: string) => parts.find(p => p.key === key)!;

const WOMAN_SHAPE = '<rect x="400" y="400" width="220" height="600" rx="60"/><circle cx="510" cy="300" r="82"/>';
/** A woman in front of a plain blue-purple wall, a soft shadow beside her, a headline. */
export const BLUE_PARTS: Part[] = [
  { key: 'wall', name: 'Plain blue-purple wall', svg: '<rect width="1000" height="1000" fill="#4f46e5"/>' },
  { key: 'shadow', name: 'Soft shadow of the woman', svg: `${blur('blue-drop', 20)}<g filter="url(#blue-drop)" fill="#000" fill-opacity="0.4" transform="translate(-50 20)">${WOMAN_SHAPE}</g>` },
  { key: 'woman', name: 'Woman in yellow top', svg: `<rect x="400" y="400" width="220" height="600" rx="60" fill="#fde047"/><circle cx="510" cy="300" r="82" fill="${SKIN}"/><path d="M430 270 Q510 190 590 270 L588 240 Q510 170 432 240Z" fill="#1f1308"/>` },
  { key: 'headline', name: 'White NEW ARRIVALS headline text', svg: '<rect x="620" y="80" width="320" height="44" fill="#ffffff"/><rect x="680" y="140" width="260" height="34" fill="#ffffff"/>' },
];
/** A blurred darker silhouette where she was: Seedream's inpainting left a ghost in its base. */
export const BLUE_GHOST: Part = { key: 'ghost', name: 'ghost', svg: `${blur('blue-ghost', 14)}<g filter="url(#blue-ghost)" fill="#000" fill-opacity="0.3">${WOMAN_SHAPE}</g>` };
/** A lighter wall panel behind her (a real element of the design). */
export const BLUE_PANEL: Part = { key: 'panel', name: 'Light blue wall panel', svg: '<rect x="160" y="140" width="680" height="860" fill="#818cf8"/>' };
/** The same panel as Seedream returned it: a grey slab where she stood, hidden behind her. */
export const BLUE_PANEL_WITH_SLAB: Part = { ...BLUE_PANEL, svg: `${BLUE_PANEL.svg}<rect x="420" y="320" width="180" height="660" fill="#9ca3af"/>` };

/** A lavender product shot: a soft gradient with circles and a white platform, a phone standing on it. */
export const LAVENDER_PARTS: Part[] = [
  { key: 'backdrop', name: 'Lavender studio background', svg: '<defs><linearGradient id="lav" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1e9fa"/><stop offset="1" stop-color="#e2d6f2"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#lav)"/><circle cx="190" cy="230" r="75" fill="#ddd0ed"/><circle cx="800" cy="500" r="110" fill="#e1d7ed"/><ellipse cx="500" cy="820" rx="320" ry="65" fill="#c6b6dc"/><ellipse cx="500" cy="790" rx="320" ry="60" fill="#faf7ff"/>' },
  { key: 'phone', name: 'Lavender phone', svg: '<rect x="345" y="190" width="310" height="570" rx="45" fill="#514661"/><rect x="357" y="202" width="286" height="546" rx="37" fill="#b294d2"/><circle cx="405" cy="255" r="20" fill="#292431"/><circle cx="447" cy="305" r="20" fill="#292431"/>' },
];

/** A flat yellow offer: product, price badge, headline and button, as offer creatives are laid out. */
export const OFFER_PARTS: Part[] = [
  { key: 'yellow', name: 'Flat yellow background', svg: '<rect width="1000" height="1000" fill="#fde047"/>' },
  { key: 'product', name: 'Purple gift box product', svg: '<rect x="520" y="420" width="330" height="330" rx="18" fill="#7c3aed"/><rect x="668" y="420" width="34" height="330" fill="#f472b6"/>' },
  { key: 'badge', name: 'Red 50% OFF price badge', svg: '<circle cx="820" cy="400" r="85" fill="#dc2626"/><rect x="770" y="385" width="100" height="30" fill="#ffffff"/>' },
  { key: 'headline', name: 'Black MEGA DEAL headline text', svg: '<rect x="70" y="120" width="380" height="60" fill="#111111"/><rect x="70" y="200" width="300" height="40" fill="#111111"/>' },
  { key: 'cta', name: 'Black SHOP NOW button', svg: '<rect x="70" y="820" width="260" height="70" rx="35" fill="#111111"/><rect x="110" y="848" width="150" height="14" fill="#fde047"/>' },
];
/** Background noise Seedream split off as its own layers: near-invisible speckles and a faint patch of the same yellow. */
export const OFFER_SPECKLES: Part = { key: 'speckles', name: 'Background texture dots', svg: [[150, 450], [260, 620], [400, 300], [930, 130], [120, 700], [460, 930], [900, 900], [300, 520]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#fce14b"/>`).join('') };
export const OFFER_PATCH: Part = { key: 'patch', name: 'Soft yellow background shape', svg: '<rect x="110" y="400" width="200" height="160" rx="40" fill="#fbe04a"/>' };

const element = (id: string, type: string, z: number): SemanticElement => ({ id, type, description: `${id.replace(/_/g, ' ')} as seen in the creative`, editable_independently: true,
  approximate_region: 'see image', z_order: z, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
  attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } });
/** A planner answer listing these [id, type] elements back to front. */
export const plannedAnalysis = (summary: string, list: [string, string][]): SemanticAnalysis => ({ image_type: 'offer creative', scene_summary: summary, relationships: [], ambiguities: [],
  elements: list.map(([id, type], z) => element(id, type, z)), recommended_layer_count: list.length, decomposition_strategy: 'Separate the editable elements from the background.',
  downstream_decomposition_prompt: `Create ${list.length} layers back-to-front: ${list.map(([id]) => id.replace(/_/g, ' ')).join('; ')}.` });

/** A mottled plaster wall: a texture no local fill continues (it would smear it), and not a plain field or flat colors. */
export const PLASTER_WALL: Part = { key: 'plaster', name: 'Textured lavender plaster wall', svg: '<defs><filter id="plaster" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="7"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.6 0 0 0 -0.55"/></filter></defs><rect width="1000" height="1000" fill="#9f8cc9"/><rect width="1000" height="1000" filter="url(#plaster)"/>' };

/** ghost: the edit leaves a dark silhouette; rowfill: a row-wise continuation; { truth }: it returns the true background; none: no edit. */
export type Edit = 'ghost' | 'rowfill' | 'none' | { truth: Buffer };
/**
 * One refined, image-aware run through the real runner with every provider faked: the planner answers `analysis`,
 * Seedream answers each scripted pass in turn (its base, then the layers), the image edit answers `edit`. A Seedream
 * submission beyond the script throws.
 */
export async function refinedRun(original: Buffer, analysis: SemanticAnalysis, passes: { base: Part[]; layers: Part[] }[], edit: Edit = 'ghost', refinement: boolean | { deterministicBackground: boolean } = true) {
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
  const reconstruct = vi.fn(async (request: { image: Buffer; mask: Buffer }) => {
    if (typeof edit === 'object') { const { width, height } = await sharp(request.image).metadata(); return { image: await sharp(edit.truth).resize(width!, height!, { fit: 'fill' }).png().toBuffer() }; }
    return { image: edit === 'ghost' ? await ghostEdit(request.image, request.mask) : await rowFillEdit(request.image, request.mask) };
  });
  const deps: RunnerDeps = { planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined,
    ...(edit === 'none' ? {} : { backgroundReconstructor: { model: 'test-edit', reconstruct } }) };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'simple-background-')), original, { mode: 'generated' }, { refinement });
  await executeRun(dir, deps);
  return { dir, run: readRun(dir), submitted, reconstruct, plannerCalls: create };
}
