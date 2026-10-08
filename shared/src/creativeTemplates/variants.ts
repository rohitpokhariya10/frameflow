/**
 * "Generate creative template": new offer-creative scenes around the image's own main subjects. The subjects are NOT
 * redrawn: their original pixels are cut out with a validated segmentation mask and composited on top of each generated
 * scene, so their identity, markings and viewing angle are exactly the source's. Only the scenery around them is new.
 * A prompt alone never guarantees preservation; where no reliable cutout exists the set stops and asks for one.
 *
 * Every variant is text-free: its scene description may not ask for text, prices, logos or watermarks, and the locked
 * rules around it say so again. A user may edit a variant's scene description, never the rules around it.
 */
import type { ExecutionImage } from './execution.js';
import { LIGHT_DIRECTIONS, type SceneCorrection, type SceneLighting } from './scene.js';
import { sanitizeEditInstruction } from './editPrompt.js';
import { TEXT_FREE_RULE } from './changePlan.js';
import type { SemanticVerification } from './verification.js';

export const VARIANT_LIMITS = { min: 1, max: 4, direction: 300, scene: 600, title: 60 } as const;
export type CreativeVariantStatus = 'pending' | 'generating' | 'done' | 'failed';
/** A layer of a variant, placed on the source canvas (pixels). */
export interface VariantLayer extends ExecutionImage { placement: { x: number; y: number; width: number; height: number } }
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
  /** Kept separately editable: the generated scenery, a clean plate of it, a soft contact shadow, the exact subject. */
  layers?: { scenery: ExecutionImage; plate: ExecutionImage; shadow?: VariantLayer; subject: VariantLayer };
  /** How exactly the subject's source pixels survive in the composite (measured, not assumed). */
  preservation?: { method: 'exact-source-pixels'; checkedPixels: number; maxDifference: number };
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
/**
 * The exact prompt of one variant: the locked preservation and text-free rules around the user's (or the concept
 * writer's) scene description. The subject itself is restored from source pixels after generation either way.
 */
export function compileVariantPrompt(input: { protectedLabels: string[]; lighting: SceneLighting; scene: string; people: boolean }): string {
  const problems = scenePromptProblems(input.scene);
  if (problems.length) throw new Error(problems.join(' '));
  const subjects = input.protectedLabels.map(l => sanitizeEditInstruction(l).replace(/["“”]/g, '\'').slice(0, 60)).filter(Boolean).join(', ') || 'the main subject';
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
