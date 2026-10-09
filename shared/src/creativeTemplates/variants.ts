/**
 * "Generate creative template": new offer-creative scenes around the image's own main subjects. The subjects are NOT
 * redrawn: their original pixels are cut out with a validated segmentation mask and composited on top of each generated
 * scene, so their identity, markings and viewing angle are exactly the source's. Only the scenery around them is new.
 * A prompt alone never guarantees preservation; where no reliable cutout exists the set stops and asks for one.
 *
 * Every variant is text-free: its scene description may not ask for text, prices, logos or watermarks, and the locked
 * rules around it say so again. A user may edit a variant's scene description, never the rules around it.
 *
 * A set made for an aspect ratio composes each variant on that ratio's canvas: the product group, as one unit (its own
 * arrangement kept), is placed where the variant's concept puts it, scaled down when it must be but never enlarged, and
 * the scene is painted around it. Concepts are structured (setting, surface, props, palette, light, mood, camera,
 * composition) so that the variants of a set can be checked to differ, not just in colour.
 */
import type { ExecutionImage } from './execution.js';
import { LIGHT_DIRECTIONS, type SceneCorrection, type SceneLighting } from './scene.js';
import { sanitizeEditInstruction } from './editPrompt.js';
import { TEXT_FREE_RULE } from './changePlan.js';
import type { SemanticVerification } from './verification.js';

export const VARIANT_LIMITS = { min: 1, max: 5, direction: 300, scene: 600, title: 60 } as const;
/** The counts the form offers; the API accepts every count from 1 to 5 (sets made before offered 1–4). */
export const VARIANT_COUNTS = [1, 3, 5] as const;
/** The canvas ratios a set may ask for: the image model's sizes this app uses (9:16 waits for a live size check). */
export const VARIANT_RATIOS = ['1:1', '4:5', '16:9'] as const;
export type VariantRatio = typeof VARIANT_RATIOS[number];
export const CONCEPT_FAMILIES = ['studio', 'lifestyle', 'nature', 'architectural', 'abstract', 'festive', 'tech', 'luxury', 'minimal', 'outdoor'] as const;
export type ConceptFamily = typeof CONCEPT_FAMILIES[number];
export const CAMERA_ANGLES = ['eye-level', 'low-angle', 'high-angle', 'top-down'] as const;
/** Where a concept leaves calm, open space (for copy added later in the editor), if anywhere. */
export const COPY_SPACES = ['none', 'top', 'bottom', 'left', 'right'] as const;
export type CopySpace = typeof COPY_SPACES[number];
/** Where the product group sits: its centre as canvas fractions, and how much of the canvas it may fill (0–1). */
export interface ConceptComposition { x: number; y: number; scale: number; copySpace: CopySpace }
/** One art direction, as a creative director would brief it. */
export interface VariantConcept {
  title: string; family: ConceptFamily; theme: string; environment: string; surface: string; props: string[]; palette: string[];
  lighting: string; mood: string; camera: typeof CAMERA_ANGLES[number]; composition: ConceptComposition;
}
/** The composition bounds every concept is held to: products stay in frame and keep a share of it. */
export const COMPOSITION_LIMITS = { x: [0.2, 0.8], y: [0.25, 0.8], scale: [0.35, 0.85] } as const;
export type CreativeVariantStatus = 'pending' | 'generating' | 'done' | 'failed';
/** A layer of a variant, placed on the source canvas (pixels). */
export interface VariantLayer extends ExecutionImage { placement: { x: number; y: number; width: number; height: number } }
/** One protected product's own layer (its source pixels) or its own contact shadow. */
export interface VariantSubjectLayer extends VariantLayer { subjectId: string; label: string }
/**
 * How exactly the protected products' source pixels survive in a composite, measured on the result:
 *   checkedPixels/maxDifference  fully opaque product pixels compared with the source (any difference rejects it)
 *   edgePixels/edgeMaxError      soft edge pixels compared with the expected blend of source and new scenery
 *   outsideAlphaPixels           product layer pixels outside every product mask (must be 0: nothing of the old background)
 * Variants made before these were measured carry only the first two.
 */
export interface VariantPreservation {
  /** exact: the source's pixels at their own size; resampled: the source's pixels scaled down once (scale), never redrawn. */
  method: 'exact-source-pixels' | 'resampled-source-pixels';
  checkedPixels: number; maxDifference: number; edgePixels?: number; edgeMaxError?: number; outsideAlphaPixels?: number; scale?: number;
}
export interface CreativeVariant {
  /** v1…v4. */
  id: string;
  title: string;
  /** The editable creative direction: the scene only. The protective rules are added around it when sent. */
  scene: string;
  /** Exactly what was sent for the current image. */
  prompt?: string;
  status: CreativeVariantStatus;
  /** Image requests sent for this variant (each one paid; never resent automatically). */
  attempts: number;
  model?: string; size?: string; requestFile?: string; responseFile?: string; durationMs?: number; startedAt?: string; finishedAt?: string;
  /** The composite: the exact subject over the new scenery, at the source's resolution. */
  image?: ExecutionImage;
  /**
   * Kept separately editable: the generated scenery, a clean plate of it, and the protected products. `subject` and
   * `shadow` are all products together (every variant has them); `subjects` and `shadows` are each product's own layer
   * and contact shadow (variants made since products were separated).
   */
  layers?: { scenery: ExecutionImage; plate: ExecutionImage; shadow?: VariantLayer; subject: VariantLayer; subjects?: VariantSubjectLayer[]; shadows?: VariantSubjectLayer[] };
  /** How exactly the products' source pixels survive in the composite (measured, not assumed). */
  preservation?: VariantPreservation;
  /** The art direction it was made from (sets made for an aspect ratio). */
  concept?: VariantConcept;
  /** Where the product group was placed on the canvas, and at what scale of its source pixels (≤ 1: never enlarged). */
  layout?: { scale: number; box: { x: number; y: number; width: number; height: number } };
  verification?: SemanticVerification;
  error?: { code: string; message: string };
  /** Earlier results of this variant: a regeneration never throws a finished image away. */
  history: { at: string; scene: string; prompt?: string; image?: ExecutionImage; error?: { code: string; message: string } }[];
  /** The execution made when this variant was chosen for review and decomposition. */
  executionId?: string;
}
export interface VariantCutout {
  status: 'pending' | 'segmenting' | 'ready' | 'needs-cutout';
  provider?: string;
  /** mask.png: white = subject; subject.png: the source pixels with that mask as alpha (full canvas). */
  mask?: string; subject?: string;
  /** Each protected product's own mask (white = that product), in the set's protected order. Sets made before have only `mask`. */
  masks?: { subjectId: string; label: string; file: string }[];
  /** The mask's bounding box in source pixels. */
  box?: { x: number; y: number; width: number; height: number };
  coveragePercent?: number;
  /** What was verified about it, and what it cannot do (overlapping text, uncertain edges). */
  checks: string[]; limitations: string[];
  error?: { code: string; message: string };
  requestIds?: string[];
}
export interface VariantSet {
  id: string; createdAt: string; updatedAt: string; idempotencyKey: string;
  template: { id: string; name: string; version: number };
  analysisId: string;
  source: ExecutionImage & { originalName?: string };
  /** The confirmed protected subjects (with what must stay attached to them). */
  protectedIds: string[]; protectedLabels: string[];
  direction?: string; surprise: boolean; count: number;
  state: 'cutout' | 'concepts' | 'generating' | 'ready' | 'needs-cutout' | 'failed';
  cutout: VariantCutout;
  concepts?: { status: 'done' | 'failed' | 'skipped'; model?: string; requestFile?: string; responseFile?: string; error?: { code: string; message: string } };
  variants: CreativeVariant[];
  usage: { segmentationCalls: number; conceptCalls: number; imageGenerationCalls: number; verificationCalls: number; models: Record<string, string> };
  verify: boolean;
  /** The user's corrections of the analysis this set was made with. */
  corrections?: Record<string, SceneCorrection>;
  /** What the set was asked for (its submission key may not be reused for anything else). */
  signature?: string;
  /** The canvas ratio its variants are composed on (sets made before keep the source's own canvas). */
  aspectRatio?: VariantRatio;
  /** How the kept products were chosen: automatically (with the reason for each) or by the user. */
  selection?: { ids: string[]; reasons: Record<string, string>; basis: 'analysis' | 'rules' | 'user'; fallback: boolean };
  /** The last concept call: how many concepts came back, how many were used, and why the others were not. */
  conceptReport?: { candidates: number; chosen: number; minDistance: number | null; rejected: { title: string; reason: string }[] };
  error?: { code: string; message: string };
}

/** Asking a scene for words, prices, logos or signs would add text; the creative stays text-free. */
const TEXT_REQUEST = /["“”«»]|\b(?:text|texts|word|words|letter|letters|lettering|typography|font|fonts|headline|caption|captions|slogan|tagline|says|saying|written|writing|logo|logos|watermark|price|prices|pricing|discount|offer|offers|sale|coupon|cashback|emi|percent|sign|signs|signage|signboard|banner text|label that)\b|₹|\$|%|टेक्स्ट|लिख|शब्द|कीमत|छूट|ऑफ़र|ऑफर|सेल/i;
export function scenePromptProblems(text: unknown): string[] {
  const clean = sanitizeEditInstruction(text);
  if (!clean) return ['Describe the scene, for example "soft studio light on a marble plinth".'];
  if (clean.length > VARIANT_LIMITS.scene) return [`A scene description is at most ${VARIANT_LIMITS.scene} characters.`];
  if (TEXT_REQUEST.test(clean)) return ['A scene cannot ask for text, quotes, prices, offers, logos or signs: new creatives stay text-free. Describe the setting, light and objects instead.'];
  return [];
}
export const cleanScenePrompt = (text: unknown) => sanitizeEditInstruction(text).slice(0, VARIANT_LIMITS.scene);
export function directionProblems(text: unknown): string[] {
  const clean = sanitizeEditInstruction(text);
  if (!clean) return [];
  if (clean.length > VARIANT_LIMITS.direction) return [`A direction is at most ${VARIANT_LIMITS.direction} characters.`];
  return TEXT_REQUEST.test(clean) ? ['A direction cannot ask for text, quotes, prices, offers, logos or signs: new creatives stay text-free.'] : [];
}
const LIGHT: Record<SceneLighting['direction'], string> = { left: 'from the left', right: 'from the right', top: 'from above', front: 'from the front', back: 'from behind', diffuse: 'soft and even', unclear: 'as it falls on the subject' };
export const lightingSentence = (l: SceneLighting) => `the light comes ${LIGHT[(LIGHT_DIRECTIONS as readonly string[]).includes(l.direction) ? l.direction : 'unclear']}${l.quality !== 'unclear' ? `, ${l.quality}` : ''}${l.color !== 'unclear' ? `, ${l.color} in tone` : ''}`;
const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, n));
const text = (value: unknown, limit: number) => sanitizeEditInstruction(typeof value === 'string' ? value : '').replace(/["“”]/g, '\'').slice(0, limit).trim();
/**
 * A concept writer's answer for one variant, checked: every text field plain, bounded and text-free (a concept may not
 * ask for words, prices, offers, logos or signs), enums known, and the composition held to COMPOSITION_LIMITS.
 */
export function parseConcept(raw: unknown): { concept?: VariantConcept; problems: string[] } {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const c = (r.composition && typeof r.composition === 'object' ? r.composition : {}) as Record<string, unknown>;
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).map(v => text(v, 40)).filter(Boolean).slice(0, max);
  const num = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const concept: VariantConcept = {
    title: text(r.title, VARIANT_LIMITS.title), family: (CONCEPT_FAMILIES as readonly unknown[]).includes(r.family) ? r.family as ConceptFamily : 'studio',
    theme: text(r.theme, 120), environment: text(r.environment, 200), surface: text(r.surface, 100), props: list(r.props, 4), palette: list(r.palette, 4),
    lighting: text(r.lighting, 100), mood: text(r.mood, 60), camera: (CAMERA_ANGLES as readonly unknown[]).includes(r.camera) ? r.camera as VariantConcept['camera'] : 'eye-level',
    composition: { x: clamp(num(c.x, 0.5), COMPOSITION_LIMITS.x), y: clamp(num(c.y, 0.58), COMPOSITION_LIMITS.y), scale: clamp(num(c.scale, 0.6), COMPOSITION_LIMITS.scale),
      copySpace: (COPY_SPACES as readonly unknown[]).includes(c.copy_space ?? c.copySpace) ? (c.copy_space ?? c.copySpace) as CopySpace : 'none' },
  };
  const problems: string[] = [];
  if (!concept.environment || !concept.surface) problems.push('A concept needs a setting and a surface for the products.');
  const words = [concept.title, concept.theme, concept.environment, concept.surface, ...concept.props, ...concept.palette, concept.lighting, concept.mood].join(' ');
  if (TEXT_REQUEST.test(words)) problems.push('This concept asks for text, prices, offers, logos or signs: new creatives stay text-free.');
  return problems.length ? { problems } : { concept, problems };
}
/** A concept as the editable scene description its variant is generated from (the locked rules are added around it). */
export function conceptScene(c: VariantConcept): string {
  const open = c.composition.copySpace === 'none' ? '' : ` Leave the ${c.composition.copySpace} part of the frame calm and open, a plain softly lit area.`;
  return cleanScenePrompt(`${c.theme ? `${c.theme}. ` : ''}${c.environment}; the products rest on ${c.surface}${c.props.length ? `, with ${c.props.join(', ')} around them` : ''}. Palette: ${c.palette.join(', ') || 'harmonious'}. Lighting: ${c.lighting || 'soft and natural'}; mood: ${c.mood || 'premium'}; ${c.camera} view.${open}`);
}
const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => { const both = [...a].filter(w => b.has(w)).length; return both / Math.max(1, new Set([...a, ...b]).size); };
/**
 * How different two concepts are, 0 (the same) to about 4: another family of setting, other places, surfaces and props,
 * another palette, another composition (where the products stand, how large, where the open space is), another view.
 * Two variants that differ only in colour score below MIN_CONCEPT_DISTANCE.
 */
export function conceptDistance(a: VariantConcept, b: VariantConcept): number {
  const setting = (c: VariantConcept) => words(`${c.theme} ${c.environment} ${c.surface} ${c.props.join(' ')}`);
  const placed = Math.min(1, (Math.abs(a.composition.x - b.composition.x) + Math.abs(a.composition.y - b.composition.y) + Math.abs(a.composition.scale - b.composition.scale)) * 2);
  return (a.family !== b.family ? 1 : 0) + (1 - jaccard(setting(a), setting(b))) + 0.5 * (1 - jaccard(new Set(a.palette.map(p => p.toLowerCase())), new Set(b.palette.map(p => p.toLowerCase()))))
    + 0.8 * placed + (a.camera !== b.camera ? 0.3 : 0) + (a.composition.copySpace !== b.composition.copySpace ? 0.3 : 0);
}
export const MIN_CONCEPT_DISTANCE = 1.2;
const TOO_CLOSE = 'too close to another concept (only colours or details differ)';
/**
 * The n most different concepts: greedily, each next one the farthest from those already chosen (and from the set's
 * existing variants). A concept too close to a chosen one is left out rather than used: fewer variants beat near-copies.
 */
export function selectDiverseConcepts(candidates: VariantConcept[], n: number, existing: VariantConcept[] = []): { chosen: VariantConcept[]; rejected: { title: string; reason: string }[]; minDistance: number | null } {
  const chosen: VariantConcept[] = [], rejected: { title: string; reason: string }[] = [], pool = [...candidates];
  const nearest = (c: VariantConcept) => Math.min(Infinity, ...[...existing, ...chosen].map(x => conceptDistance(c, x)));
  while (chosen.length < n && pool.length) {
    // The writer's first concept leads when nothing is chosen yet; after that, the farthest from what is.
    const ranked = pool.map((c, i) => ({ c, i, d: existing.length + chosen.length ? nearest(c) : Infinity })).sort((a, b) => b.d - a.d || a.i - b.i);
    const best = ranked[0];
    pool.splice(best.i, 1);
    if (best.d < MIN_CONCEPT_DISTANCE) { rejected.push({ title: best.c.title, reason: TOO_CLOSE }); continue; }
    chosen.push(best.c);
  }
  for (const c of pool) rejected.push({ title: c.title, reason: nearest(c) < MIN_CONCEPT_DISTANCE ? TOO_CLOSE : 'not needed: enough different concepts were chosen' });
  const all = [...existing, ...chosen], pairs: number[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pairs.push(conceptDistance(all[i], all[j]));
  return { chosen, rejected, minDistance: pairs.length ? Math.round(Math.min(...pairs) * 100) / 100 : null };
}
/**
 * The exact prompt of one variant: the locked preservation and text-free rules around the user's (or the concept
 * writer's) scene description. The subject itself is restored from source pixels after generation either way.
 * `placed`: the products were placed on a new canvas for this variant (a set made for an aspect ratio).
 */
export function compileVariantPrompt(input: { protectedLabels: string[]; lighting: SceneLighting; scene: string; people: boolean; placed?: boolean }): string {
  const problems = scenePromptProblems(input.scene);
  if (problems.length) throw new Error(problems.join(' '));
  const subjects = input.protectedLabels.map(l => sanitizeEditInstruction(l).replace(/["“”]/g, '\'').slice(0, 60)).filter(Boolean).join(', ') || 'the main subject';
  if (input.placed) return [`Create a premium advertising photograph around the products already placed in the attached image (the unmasked area: ${subjects}); paint everything else as new artwork: ${cleanScenePrompt(input.scene)}`,
    'The products are final: keep them exactly where and as they are, with the same size, viewing angle, outline, colors, logos, screens, buttons and markings. Do not redraw, move, resize, restyle or duplicate them, and do not paint a second copy, ghost or outline of them anywhere.',
    `Light the scene to match the products: ${lightingSentence(input.lighting)}. Ground each product with a soft, natural contact shadow directly beneath it on the surface it rests on; cast no other shadows away from the products.`,
    `Keep the area right around the products clean so they stay the focus.${input.people ? ' Do not add other people, hands or body parts.' : ' Do not add people or hands.'} Do not add other products.`,
    `${TEXT_FREE_RULE} The scene must contain no lettering of any kind.`].join(' ');
  return [`Create a new offer-creative scene. The unmasked area of the attached image is the protected subject (${subjects}); paint only the masked area with new artwork: ${cleanScenePrompt(input.scene)}.`,
    'The protected subject stays exactly as it is: same position, size, viewing angle, outline, colors and markings. Do not redraw, move, resize, rotate or restyle it, and do not paint a second copy, ghost or outline of it anywhere.',
    `Light the new scene to match the subject: ${lightingSentence(input.lighting)}. Ground the subject with natural contact shadows and reflections on the new surfaces it touches.`,
    `Keep the area right around the subject calm and uncluttered so it stays the focus.${input.people ? ' Do not add other people, hands or body parts.' : ' Do not add people or hands.'} Do not add other products.`,
    `${TEXT_FREE_RULE} The scene must contain no lettering of any kind.`].join(' ');
}
/** Word overlap of two scene descriptions (Jaccard): concepts that say nearly the same thing are not different variants. */
export function sceneSimilarity(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const x = words(a), y = words(b), both = [...x].filter(w => y.has(w)).length;
  return both / Math.max(1, new Set([...x, ...y]).size);
}
