import { IMAGE_TEMPLATE_LIMITS } from './imageTemplateGeneration.js';

/** Analysis is evidence, not a generation prompt. Limits also describe the strict provider schema. */
const HERO_FIELDS = { identity: 120, appearance: 320, color: 60, orientation: 100, cameraAngle: 100, position: 100, relativeScale: 60 };
const OBJECT_FIELDS = { kind: 60, appearance: 120, position: 120, relativeScale: 60, relationshipToHero: 120 };
const COMPOSITION_FIELDS = { framing: 120, crop: 100, foreground: 120, midground: 120, background: 120, negativeSpace: 100, visualHierarchy: 120 };
export const IMAGE_ANALYSIS_LIMITS = { sceneType: 80, objects: 12, palette: 6, materials: 6, preservationRules: 6, fact: 160 } as const;
type TextFields<T> = { [K in keyof T]: string };
export type ReferenceDesignEvidence = {
  summary: string; subjectMode: 'single' | 'collection' | 'none' | 'unclear'; panelGeometry: string;
  typographyMood: string; treatment: string; shadows: string; depth: string; focalPoint: string; theme: string; decorations: string;
  zones: { headline: string; offer: string; cta: string; logo: string; product: string };
};
const DESIGN_FIELDS = { summary: 160, panelGeometry: 160, typographyMood: 120, treatment: 100, shadows: 120, depth: 120, focalPoint: 120, theme: 100, decorations: 160 };
const ZONE_FIELDS = { headline: 80, offer: 80, cta: 80, logo: 80, product: 80 };
export type ImageVisualAnalysis = {
  sceneType: string; hero: TextFields<typeof HERO_FIELDS>;
  objects: (TextFields<typeof OBJECT_FIELDS> & { count: number | null })[];
  composition: TextFields<typeof COMPOSITION_FIELDS>; palette: string[]; lighting: string; materials: string[];
  backgroundTreatment: string; visibleText: { present: boolean | null; description: string }; preservationRules: string[];
  additionalObjects: boolean; design?: ReferenceDesignEvidence;
};
const string = (maxLength: number) => ({ type: 'string', maxLength });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const strings = (fields: Record<string, number>) => Object.fromEntries(Object.entries(fields).map(([key, max]) => [key, string(max)]));
const list = (maxItems: number) => ({ type: 'array', maxItems, items: string(IMAGE_ANALYSIS_LIMITS.fact) });
export const IMAGE_ANALYSIS_SCHEMA = object({
  analysis: object({
    sceneType: string(IMAGE_ANALYSIS_LIMITS.sceneType), hero: object(strings(HERO_FIELDS)),
    objects: { type: 'array', maxItems: IMAGE_ANALYSIS_LIMITS.objects, items: object({ ...strings(OBJECT_FIELDS), count: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }) },
    composition: object(strings(COMPOSITION_FIELDS)), palette: list(IMAGE_ANALYSIS_LIMITS.palette), lighting: string(IMAGE_ANALYSIS_LIMITS.fact),
    materials: list(IMAGE_ANALYSIS_LIMITS.materials), backgroundTreatment: string(IMAGE_ANALYSIS_LIMITS.fact),
    visibleText: object({ present: { type: ['boolean', 'null'] }, description: string(IMAGE_ANALYSIS_LIMITS.fact) }),
    preservationRules: list(IMAGE_ANALYSIS_LIMITS.preservationRules),
    design: object({ ...strings(DESIGN_FIELDS), subjectMode: { type: 'string', enum: ['single', 'collection', 'none', 'unclear'] }, zones: object(strings(ZONE_FIELDS)) }),
  }),
  suggested_name: string(IMAGE_TEMPLATE_LIMITS.name),
});

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Whole phrases/words only, including CJK word boundaries and intact emoji. No character slicing. */
export function compactVisualFact(value: unknown, budget: number): string {
  if (typeof value !== 'string') return '';
  const clauses = [...new Set(value.replace(/\s+/gu, ' ').replace(/(\b[\p{L}]+)(?:\s+\1\b)+/giu, '$1').trim().split(/[;\n]+/u).map(part => part.trim()).filter(Boolean))];
  const text = clauses.join('; ');
  if (text.length <= budget) return text.replace(/[\s,;:.!?]+$/u, '');
  let result = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'word' }).segment(text)) {
    if ((result + segment).length > budget) break;
    result += segment;
  }
  const compact = result.replace(/[\s,;:.!?]+$/u, '').replace(/\s+(?:and|or|with|of|the|a|an|to|in|on|at|from)$/iu, '').trim();
  // An unbroken identifier longer than the whole field cannot be shortened safely. Keep the image as authority.
  return compact || (budget >= 'as in reference'.length ? 'as in reference' : '');
}
function fields<T extends Record<string, number>>(value: unknown, limits: T): TextFields<T> {
  const input = record(value);
  return Object.fromEntries(Object.entries(limits).map(([key, max]) => [key, compactVisualFact(input[key], max)])) as TextFields<T>;
}
function facts(value: unknown, count: number): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map(item => compactVisualFact(item, IMAGE_ANALYSIS_LIMITS.fact)).filter(Boolean))].slice(0, count);
}
/** Tolerate absent optional evidence, unknown keys and excess verbosity; reject uninterpretable core evidence. */
export function normalizeImageAnalysis(value: unknown): ImageVisualAnalysis {
  const input = record(value), hero = fields(input.hero, HERO_FIELDS), composition = fields(input.composition, COMPOSITION_FIELDS);
  const objects: ImageVisualAnalysis['objects'] = [], seen = new Set<string>();
  let additionalObjects = input.additionalObjects === true;
  for (const item of Array.isArray(input.objects) ? input.objects : []) {
    const source = record(item), detail = fields(source, OBJECT_FIELDS);
    if (!detail.kind) continue;
    const count = source.count ?? null;
    if (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)) throw new Error('An object count in the visual analysis is invalid.');
    const normalized = { ...detail, count }, key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    if (objects.length < IMAGE_ANALYSIS_LIMITS.objects) objects.push(normalized); else additionalObjects = true;
  }
  const sceneType = compactVisualFact(input.sceneType, IMAGE_ANALYSIS_LIMITS.sceneType);
  if (!hero.identity && !hero.appearance && !objects.length && !sceneType) throw new Error('The visual analysis contains no usable subject or scene evidence.');
  const text = record(input.visibleText), rawDesign = record(input.design);
  let design: ReferenceDesignEvidence | undefined;
  if (input.design !== undefined) {
    if (!['single', 'collection', 'none', 'unclear'].includes(String(rawDesign.subjectMode))) throw new Error('Invalid product structure in reference analysis.');
    // New design instructions are plain descriptions. Existing visible-text evidence may legitimately name a website;
    // it stays escaped text and is never used as an asset URL or executable content.
    for (const value of [...Object.values(rawDesign), ...Object.values(record(rawDesign.zones))]) {
      // '>' can express visual priority; '<' still blocks every HTML/SVG tag opener.
      if (typeof value === 'string' && /<|https?:\/\/|data:|javascript:|\beval\s*\(/iu.test(value)) throw new Error('Design evidence must contain plain descriptions, not markup, code or links.');
    }
    design = { ...fields(rawDesign, DESIGN_FIELDS), subjectMode: rawDesign.subjectMode as ReferenceDesignEvidence['subjectMode'], zones: fields(rawDesign.zones, ZONE_FIELDS) };
  }
  return { sceneType, hero, objects, composition, additionalObjects, ...(design ? { design } : {}),
    palette: facts(input.palette, IMAGE_ANALYSIS_LIMITS.palette), materials: facts(input.materials, IMAGE_ANALYSIS_LIMITS.materials),
    lighting: compactVisualFact(input.lighting, IMAGE_ANALYSIS_LIMITS.fact), backgroundTreatment: compactVisualFact(input.backgroundTreatment, IMAGE_ANALYSIS_LIMITS.fact),
    visibleText: { present: typeof text.present === 'boolean' ? text.present : null, description: compactVisualFact(text.description, IMAGE_ANALYSIS_LIMITS.fact) },
    preservationRules: facts(input.preservationRules, IMAGE_ANALYSIS_LIMITS.preservationRules) };
}
export function parseImageAnalysisResponse(value: unknown): { analysis: ImageVisualAnalysis } {
  return { analysis: normalizeImageAnalysis(record(value).analysis) };
}

const INTRO = 'Faithfully preserve the uploaded reference.';
const CONSTRAINTS = 'Keep product design and camera-module details, object counts, arrangement and visual hierarchy. Do not add/remove objects, redesign products, or invent text/logos/branding.';
const sentence = (label: string, text: string) => text ? `${label}${text.replace(/[\s.;:!?]+$/u, '')}.` : '';
const join = (parts: string[]) => [...new Set(parts.filter(Boolean))].join('; ');
/**
 * Reserve a compact representation of EVERY P0 section and fixed constraints first. Upgrade those sections before
 * admitting P1, then P2. Whole optional sections are omitted if they don't fit. The output is never cut to length.
 * Twelve bounded objects keep the compact core below the budget; residual canvas detail stays in the original image.
 */
export function buildImageTemplatePrompt(analysis: ImageVisualAnalysis): string {
  const h = analysis.hero, c = analysis.composition;
  const section = (label: string, text: string, minimum: number) => ({ short: sentence(label, compactVisualFact(text, minimum)), full: sentence(label, text) });
  const core = [
    section('Subject: ', h.identity || analysis.sceneType || 'subjects shown in reference', 65),
    section('Appearance: ', h.appearance, 110), section('Orientation: ', h.orientation, 45), section('View: ', h.cameraAngle, 45), section('Position: ', h.position, 45),
    ...analysis.objects.map(o => {
      // Counts and each spatial relationship get their own guaranteed slots, even in a dense scene.
      const label = `${o.count ?? 'Visible'} ${compactVisualFact(o.kind, 24) || 'objects'}: `;
      const short = join([compactVisualFact(o.position, 24), compactVisualFact(o.relationshipToHero, 24)]) || 'as in reference';
      return { short: sentence(label, short), full: sentence(`${o.count ?? 'Visible'} ${o.kind}: `, join([o.position, o.relationshipToHero]) || 'as in reference') };
    }),
  ].filter(s => s.short);
  const fixed = [INTRO, CONSTRAINTS, ...(analysis.additionalObjects ? ['Preserve all additional objects as in the reference.'] : [])];
  const parts = core.map(s => s.short);
  const length = () => [...fixed, ...parts].join(' ').length;
  // Reserve all core slots; upgrades cannot consume another object's count or position.
  for (let i = 0; i < core.length; i++) if (length() + core[i].full.length - parts[i].length <= IMAGE_TEMPLATE_LIMITS.prompt) parts[i] = core[i].full;
  const optional = [
    sentence('Framing: ', join([c.framing, c.crop])), sentence('Scale: ', h.relativeScale),
    ...analysis.objects.filter(o => o.relativeScale).map(o => sentence(`Scale of ${o.kind}: `, o.relativeScale)),
    sentence('Palette: ', join([h.color, ...analysis.palette])), sentence('Background: ', analysis.backgroundTreatment), sentence('Hierarchy: ', c.visualHierarchy),
    analysis.visibleText.present === false ? 'No visible text or branding.' : sentence('Visible text/marks: ', analysis.visibleText.description),
    sentence('Lighting: ', analysis.lighting), sentence('Materials: ', join(analysis.materials)),
    ...analysis.objects.filter(o => o.appearance).map(o => sentence(`${o.kind} appearance: `, o.appearance)),
    sentence('Depth: ', join([c.foreground, c.midground, c.background])), sentence('Negative space: ', c.negativeSpace),
    ...analysis.preservationRules.map(rule => sentence('Preserve: ', rule)),
  ].filter(Boolean);
  for (const part of optional) if (length() + part.length + 1 <= IMAGE_TEMPLATE_LIMITS.prompt) parts.push(part);
  const prompt = [INTRO, ...parts, ...fixed.slice(1)].join(' ');
  if (prompt.length > IMAGE_TEMPLATE_LIMITS.prompt) throw new Error('The visual-analysis core exceeds the configured editable budget.');
  return prompt;
}
