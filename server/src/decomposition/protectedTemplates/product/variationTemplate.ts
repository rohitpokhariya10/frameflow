/**
 * A generated variation made into a template of its own, decomposed by the same pipeline as an uploaded creative
 * (Review → Choose → Decompose → Inspect → Save → editor). Free: no provider is asked anything.
 *
 *   picture     the variation drawn at full size as one image (the new template's source, never changed)
 *   detection   the variation's composition as the detection's answer (compositionAnalyzer): every element at its place in
 *               this variation (not the master's), under its master's name and kind, every word with its box and role,
 *               every logo — the AI's answer format, read by the same detection code
 *   known       the variation's native background, objects and overlay-free composition are references. Explicit AI
 *               preparation still calls the planner and Seedream for object masks; native backgrounds retain their
 *               provenance and cannot be reported as new Seedream output. Creating this handoff itself is free.
 */
import sharp from 'sharp';
import type { CreativeTextStyle, PixelRect, ProductCreative, ProductObjectKind, ProductSnapshot } from '@frameflow/shared';
import type { SceneAnalyzer } from '../../creativeTemplates/smartProviders.js';
import { textInk } from '../../../templateStudio/masterCreatives/render.js';
import { inSourcePixels, productAnalysisImage, productSceneFromResponse } from './analyzer.js';
import { flatten, productLayers } from './creativeRun.js';

export interface VariationLayer { objectId: string; label: string; kind: ProductObjectKind; box: PixelRect; png: Buffer }
export interface VariationComposition {
  png: Buffer; clean?: Buffer; background: Buffer; layers: VariationLayer[];
  /** Its text plates (a pill behind a line of text): part of the picture without its text, as in the master. */
  plates: { png: Buffer; box: PixelRect }[];
  /** The detection's answer (the AI's format, in the pixels of the picture analysed). */
  answer: object;
  /** Each word as drawn (its exact face, size and colour), to match the detected words to. */
  words: { text: string; box: PixelRect; style: CreativeTextStyle; groupId: string }[];
}

const SCENE_KIND: Record<ProductObjectKind, string> = { character: 'character', product: 'product', 'brand-logo': 'object', podium: 'furniture', frame: 'decoration', decoration: 'decoration' };
const WORD_ROLE = (category?: string) => (category === 'headline' || category === 'offer' || category === 'legal' || category === 'cta' ? category : 'supporting');
const BLOCK_ROLE = (category?: string) => (category === 'headline' || category === 'offer' || category === 'legal' || category === 'cta' ? category : 'other');
/** An id of the answer's alphabet (lowercase letters, digits and "_"). */
const sid = (prefix: string, id: string) => `${prefix}_${id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
const MARK_KIND = (category: string) => (category === 'brand-logo' ? 'product_brand' : category === 'partner-logo' ? 'bank_logo' : 'other_logo');

export async function variationComposition(read: (file: string) => Buffer, snapshot: ProductSnapshot, c: ProductCreative): Promise<VariationComposition> {
  const { ordered } = await productLayers(read, snapshot, c), png = await flatten(ordered);
  const W = c.canvas.width, H = c.canvas.height, picture = await productAnalysisImage(png), k = picture.width / W;
  const frac = (b: PixelRect) => ({ x: Math.max(0, b.x / W), y: Math.max(0, b.y / H), w: Math.min(1, b.width / W), h: Math.min(1, b.height / H), certainty: 'tight' as const });
  const objects = c.objects.filter(o => !o.hidden), layers: VariationLayer[] = [];
  for (const l of ordered) { const o = objects.find(x => x.id === l.semantic?.id); if (o) layers.push({ objectId: o.id, label: o.label, kind: o.kind, box: { ...l.placement }, png: l.png }); }
  const answerObjects = layers.map(l => ({ id: sid('el', l.objectId), kind: SCENE_KIND[l.kind], importance: l.kind === 'character' || l.kind === 'product' ? 'main' : l.kind === 'podium' ? 'supporting' : 'decoration',
    category: l.label, description: `${l.label} (from the master template, at its place in this variation)`, box: frac(l.box), occluded: false, properties: [],
    identity: { brand: '', model: '', evidence: 'From the master template', confidence: 1, markings: 'none' }, confidence: 0.99 }));
  // (Its name without "logo": the detection names a logo "<text> logo".)
  const marks = c.images.filter(i => !i.hidden).map(i => ({ id: sid('mk', i.id), kind: MARK_KIND(i.category), text: i.label.replace(/\s+logo$/i, ''), owner_id: '', overlay: true, box: frac(i.box) }));
  // Words: each text's ink box (in the picture analysed), in its block and line.
  const words: VariationComposition['words'] = [], answerWords: object[] = [];
  for (const g of c.groups) for (const t of c.texts.filter(x => x.groupId === g.id && x.text.trim() && !x.hidden && !/\s/.test(x.text.trim())).sort((a, b) => a.line - b.line || a.x - b.x)) {
    const ink = textInk(t); if (!ink) continue;
    const box = { x: Math.max(0, Math.round(ink.x)), y: Math.max(0, Math.round(ink.y)), width: Math.max(1, Math.round(ink.width)), height: Math.max(1, Math.round(ink.height)) };
    if (box.x + box.width > W || box.y + box.height > H) continue;
    words.push({ text: t.text.trim(), box, style: t.style, groupId: g.id });
    answerWords.push({ id: sid('w', t.id), text: t.text.trim(), group: sid('tx', g.id), line: `${sid('tx', g.id)}_${t.line}`, role: WORD_ROLE(g.category),
      box: { x: Math.min(picture.width - 1, box.x * k), y: Math.min(picture.height - 1, box.y * k), width: Math.max(1, Math.min(picture.width - box.x * k, box.width * k)), height: Math.max(1, Math.min(picture.height - box.y * k, box.height * k)), rotation: 0 }, confidence: 0.99, z: 10 });
  }
  const overlays = c.groups.map(g => { const ws = words.filter(w => w.groupId === g.id); if (!ws.length) return undefined;
    const x = Math.min(...ws.map(w => w.box.x)), y = Math.min(...ws.map(w => w.box.y)), b = { x, y, width: Math.max(...ws.map(w => w.box.x + w.box.width)) - x, height: Math.max(...ws.map(w => w.box.y + w.box.height)) - y };
    return { id: sid('tx', g.id), role: BLOCK_ROLE(g.category), text: ws.map(w => w.text).join(' '), refers_to: [], box: frac(b) }; }).filter(Boolean);
  const answer = { summary: `${c.name}: a variation of the master template “${snapshot.name}” (its composition, read from its own layers)`, objects: answerObjects, relations: [], marks, text_overlays: overlays,
    lighting: { direction: 'front', quality: 'soft', color: 'neutral' }, main_candidates: answerObjects.filter(o => o.importance === 'main').map(o => o.id), advertised_ids: answerObjects.filter(o => o.kind === 'product').map(o => o.id), uncertainties: [], words: answerWords };
  const plates = ordered.filter(l => l.semantic?.type === 'shape').map(l => ({ png: l.png, box: { ...l.placement } }));
  return { png, clean: await flatten(ordered.filter(l => l.meta.kind !== 'text' && l.meta.kind !== 'image')), background: await flatten(ordered.filter(l => l.meta.kind === 'background')), layers, plates, answer, words };
}

/** The detection's analyzer for a variation: its composition (saved with the template), read as an AI answer would be. */
export function compositionAnalyzer(answer: object): SceneAnalyzer {
  const model = 'variation composition (exact, from its own layers)';
  return { model, async analyze(image: Buffer) {
    const picture = await productAnalysisImage(image);
    const scene = inSourcePixels(productSceneFromResponse({ status: 'completed', output_text: JSON.stringify(answer), output: [], usage: undefined, incomplete_details: null } as never, { width: picture.width, height: picture.height }, model, () => undefined), picture);
    return { ...scene, analysisUsage: undefined } as never;
  } };
}

/** The clean picture of a variation (its background, plates and elements, without its text and logos), at full size. */
export async function variationClean(c: Pick<VariationComposition, 'background' | 'layers' | 'plates'>, size: { width: number; height: number }): Promise<Buffer> {
  if ('clean' in c && Buffer.isBuffer(c.clean)) return c.clean;
  return sharp(c.background).resize(size.width, size.height).composite([...c.plates.map(p => ({ input: p.png, left: p.box.x, top: p.box.y })), ...c.layers.map(l => ({ input: l.png, left: l.box.x, top: l.box.y }))]).png().toBuffer();
}
