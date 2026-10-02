import { compactVisualFact, normalizeImageAnalysis, type ImageVisualAnalysis } from './imageTemplateAnalysis.js';
import { IMAGE_TEMPLATE_LIMITS, resolveImageTemplatePrompt } from './imageTemplateGeneration.js';

/** Plain, bounded merchant choices. No provider calls, markup, asset URLs or generated geometry. */
export const REFERENCE_BLUEPRINT_VERSION = 1;
export const REFERENCE_CHANGE_FIELDS = {
  product: 'Product / Object', background: 'Background', mood: 'Theme / Mood', festival: 'Festival',
  decorations: 'Decorative elements', offer: 'Offer intent', cta: 'CTA intent', instructions: 'Other changes',
} as const;
export const REFERENCE_PRESERVE_FIELDS = {
  layout: 'Layout, hierarchy and spacing', lighting: 'Lighting style', framing: 'Product framing and relative scale',
  panels: 'Card / panel geometry', typography: 'Typography mood and text zones', camera: 'Camera / perspective',
} as const;
export type ReferenceChanges = Record<keyof typeof REFERENCE_CHANGE_FIELDS, string>;
export type ReferencePreserve = Record<keyof typeof REFERENCE_PRESERVE_FIELDS, boolean>;
export type ReferenceCreativeDraft = { version: 1; mode: 'guided' | 'custom'; changes: ReferenceChanges; preserve: ReferencePreserve; prompt: string };
export const REFERENCE_CHANGE_LIMIT = 140;
export const blankReferenceChanges = (): ReferenceChanges => ({ product: '', background: '', mood: '', festival: '', decorations: '', offer: '', cta: '', instructions: '' });
export const defaultReferencePreserve = (): ReferencePreserve => ({ layout: true, lighting: true, framing: true, panels: true, typography: true, camera: true });
export function assertPlainReferenceText(text: string): string {
  // A bare '>' is ordinary hierarchy punctuation (product > headline > CTA), not a tag.
  // Keep rejecting tag openers, remote links, executable schemes/code and control characters.
  if (/<|https?:\/\/|data:|javascript:|\beval\s*\(/iu.test(text) || [...text].some(char => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))) throw new Error('Use plain visual descriptions without markup, code or links.');
  return text;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reference creative settings.');
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown reference creative setting.'); };
export function parseReferenceCreative(value: unknown): ReferenceCreativeDraft {
  const v = record(value); exact(v, ['version', 'mode', 'changes', 'preserve', 'prompt']);
  if (v.version !== 1 || !['guided', 'custom'].includes(String(v.mode))) throw new Error('Unsupported reference draft version or prompt mode.');
  const changes = record(v.changes), preserve = record(v.preserve);
  exact(changes, Object.keys(REFERENCE_CHANGE_FIELDS)); exact(preserve, Object.keys(REFERENCE_PRESERVE_FIELDS));
  for (const key of Object.keys(REFERENCE_CHANGE_FIELDS)) {
    if (typeof changes[key] !== 'string' || changes[key].length > REFERENCE_CHANGE_LIMIT) throw new Error(`${REFERENCE_CHANGE_FIELDS[key as keyof ReferenceChanges]} must be at most ${REFERENCE_CHANGE_LIMIT} characters.`);
    assertPlainReferenceText(changes[key]);
  }
  for (const key of Object.keys(REFERENCE_PRESERVE_FIELDS)) if (typeof preserve[key] !== 'boolean') throw new Error('Every preserve choice must be checked or unchecked.');
  if (typeof v.prompt !== 'string' || v.prompt.length > IMAGE_TEMPLATE_LIMITS.prompt) throw new Error(`Prompt must be at most ${IMAGE_TEMPLATE_LIMITS.prompt} characters.`);
  assertPlainReferenceText(v.prompt);
  return { version: 1, mode: v.mode as ReferenceCreativeDraft['mode'], changes: { ...changes } as ReferenceChanges, preserve: { ...preserve } as ReferencePreserve, prompt: v.prompt };
}

/** A versioned view of the existing analysis, not a second analysis or model. Older analyses have unknown design zones. */
export function referenceBlueprint(input: ImageVisualAnalysis) {
  const analysis = normalizeImageAnalysis(input);
  return { version: REFERENCE_BLUEPRINT_VERSION, summary: analysis.design?.summary || analysis.sceneType,
    subjectMode: analysis.design?.subjectMode ?? 'unclear', subject: analysis.hero.identity || 'No clear product detected',
    analysis, zones: analysis.design?.zones, preservation: analysis.preservationRules };
}

/** User changes occupy the budget first and are never truncated. Compact evidence is secondary; the image carries detail. */
export function buildReferenceCreativePrompt(analysis: ImageVisualAnalysis, changes: ReferenceChanges, preserve: ReferencePreserve): string {
  parseReferenceCreative({ version: 1, mode: 'guided', changes, preserve, prompt: '' });
  const selected = Object.entries(REFERENCE_CHANGE_FIELDS).filter(([key]) => changes[key as keyof ReferenceChanges].trim());
  const parts = ['Adapt the original reference as one offer campaign. Explicit changes override preservation; otherwise retain the reference design family.',
    ...selected.map(([key, label]) => `${label}: ${changes[key as keyof ReferenceChanges].trim()}.`),
    `Preserve: ${Object.entries(REFERENCE_PRESERVE_FIELDS).filter(([key]) => preserve[key as keyof ReferencePreserve]).map(([, label]) => label).join('; ') || 'only traits not explicitly changed'}.`,
    ...Object.entries(REFERENCE_PRESERVE_FIELDS).filter(([key]) => !preserve[key as keyof ReferencePreserve]).map(([, label]) => `May adapt ${label.toLowerCase()} to the requested changes.`),
    'Leave usable space for headline, offer, CTA and logo. Do not invent branding, phone numbers or labels. Exact business copy will be added in the editor.',
  ];
  const facts: [string, string | undefined][] = [
    ['Reference style', analysis.design?.summary || analysis.sceneType],
    ...(!changes.product.trim() ? [['Keep subject', analysis.hero.identity] as [string, string]] : []),
    ['Composition', preserve.layout ? analysis.composition.visualHierarchy : ''],
    ['Panels', preserve.panels ? analysis.design?.panelGeometry : ''],
    ['Framing', preserve.framing ? `${analysis.hero.position}; ${analysis.hero.relativeScale}` : ''],
    ['Lighting', preserve.lighting ? analysis.lighting : ''],
    ['View', preserve.camera ? analysis.hero.cameraAngle : ''],
    ['Type mood', preserve.typography ? analysis.design?.typographyMood : ''],
    ['Copy zones', preserve.typography && analysis.design ? Object.entries(analysis.design.zones).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; ') : ''],
    ['Background', !changes.background.trim() && !changes.festival.trim() ? analysis.backgroundTreatment : ''],
  ];
  for (const [label, fact] of facts) {
    if (!fact?.trim()) continue;
    const section = `${label}: ${compactVisualFact(fact, 150)}.`;
    if ([...parts, section].join(' ').length <= IMAGE_TEMPLATE_LIMITS.prompt) parts.push(section);
  }
  const prompt = parts.join(' '), error = resolveImageTemplatePrompt(prompt).error;
  if (error) throw new Error(`${error} Shorten the change fields or enable more preserve choices.`);
  return assertPlainReferenceText(prompt);
}
export function createReferenceCreative(analysis: ImageVisualAnalysis): ReferenceCreativeDraft {
  const changes = blankReferenceChanges(), preserve = defaultReferencePreserve();
  return { version: 1, mode: 'guided', changes, preserve, prompt: buildReferenceCreativePrompt(analysis, changes, preserve) };
}
export function editReferenceChoices(draft: ReferenceCreativeDraft, analysis: ImageVisualAnalysis, update: { changes?: Partial<ReferenceChanges>; preserve?: Partial<ReferencePreserve> }): ReferenceCreativeDraft {
  const changes = { ...draft.changes, ...update.changes }, preserve = { ...draft.preserve, ...update.preserve };
  return { ...draft, changes, preserve, prompt: draft.mode === 'custom' ? draft.prompt : buildReferenceCreativePrompt(analysis, changes, preserve) };
}
export const rebuildReferencePrompt = (draft: ReferenceCreativeDraft, analysis: ImageVisualAnalysis): ReferenceCreativeDraft =>
  ({ ...draft, mode: 'guided', prompt: buildReferenceCreativePrompt(analysis, draft.changes, draft.preserve) });
export function validateReferenceGeneration(value: unknown, analysis: ImageVisualAnalysis): ReferenceCreativeDraft {
  const draft = parseReferenceCreative(value), error = resolveImageTemplatePrompt(draft.prompt).error;
  if (error) throw new Error(error);
  if (draft.mode === 'guided' && buildReferenceCreativePrompt(analysis, draft.changes, draft.preserve) !== draft.prompt) throw new Error('Guided prompt does not match its fields. Rebuild from fields before generating.');
  return draft;
}
