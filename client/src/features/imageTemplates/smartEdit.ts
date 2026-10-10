/**
 * The smart edit's decisions without React: which detected items the form offers and how they are grouped, the user's
 * draft (explicit actions only: an item without one is inherited, never "an empty field"), when a resolution is stale,
 * which variant subjects are protected by default, and the cost lines of smart and variant executions.
 *
 * The server owns analysis, resolution and generation; everything here is local and free.
 */
import { allowedActions, applyConflictOption, applySceneCorrections, attachedTo, canonicalDraft, compileResolvedEdit, draftChanges, editStrategy, holderOf, isForeground, mainIsAmbiguous, mainObjects, SCENE_MARK_LABELS, SCENE_PROPERTY_LABELS,
  type ChangePlan, type ConflictOption, type ObjectAction, type ObjectEdit, type SceneCorrection, type SceneDescription, type SceneDraft, type SceneSlotMapping, type ScenePropertyKey, type SemanticVerification,
  type TemplateExecution, type VariantSet } from '@frameflow/shared';

export interface SmartFeatures {
  smartEdit: { available: boolean; reason?: string; analysisModel?: string; resolverModel?: string };
  variants: { available: boolean; reason?: string; cutout?: string; maxVariants: number };
  verification: { available: boolean; reason?: string; model?: string };
}
export interface SceneAnalysis {
  id: string; state: 'analyzing' | 'ready' | 'failed'; createdAt: string;
  binding: { imageSha256: string; templateId: string; templateVersion: number; config: string };
  model: string; calls: number; durationMs?: number;
  /** The analyzed image's size (the server sends it with every analysis). */
  upload?: { width: number; height: number };
  scene?: SceneDescription; mapping?: SceneSlotMapping; error?: { code: string; message: string };
}
export interface Resolution {
  id: string; analysisId: string; state: 'resolving' | 'ready' | 'failed';
  binding: { draft: string; referenceSha256?: string };
  /** The draft it resolved (what a reopened smart edit restores). */
  draft?: SceneDraft;
  plan?: ChangePlan; rejected?: string[]; prompt?: string; summary?: string;
  resolver: { called: boolean; model?: string; reusedFrom?: string };
  /** The plan rules it was made with: an older one is resolved again (rebuilt on the server, no call) before generating. */
  rules?: string;
  error?: { code: string; message: string };
}
export type ShownVariantSet = VariantSet;

/** Where an item is offered: what the creative is about first, the scene and its marks and text after. */
export type ControlGroup = 'main' | 'attached' | 'supporting' | 'scene' | 'marks' | 'decoration';
export const CONTROL_GROUP_LABELS: Record<ControlGroup, string> = { main: 'Main products & subjects', attached: 'Held & worn objects', supporting: 'Supporting objects', scene: 'Background & scene', marks: 'Logos & text in the image', decoration: 'Decorations & effects' };
export interface SceneControl {
  id: string; type: 'object' | 'mark' | 'overlay'; label: string; group: ControlGroup;
  /** What the analysis says it is now (a detected value, never a request). */
  current: string; details: string[];
  /** Detected brand and how sure the analysis is (or the user's correction). */
  identity?: string; uncertain: boolean; corrected: boolean;
  actions: readonly ObjectAction[];
  properties: { key: ScenePropertyKey; label: string; value: string }[];
  /** A product's brand may be given with its change. */
  brandable: boolean;
  /** Relations shown with it: "held by Man", "holds Football", "printed on Smartphone". */
  relation?: string;
  /** The saved template field it fills, when it fills one. */
  slotId?: string;
}
const capital = (t: string) => t ? t[0].toLocaleUpperCase() + t.slice(1) : t;
/** The form's controls for a scene (with the user's corrections), grouped and in a stable order. */
export function sceneControls(scene: SceneDescription, mapping?: SceneSlotMapping): SceneControl[] {
  const label = (id: string) => scene.objects.find(o => o.id === id)?.label ?? id;
  const objects = scene.objects.filter(o => !o.ignored).map((o): SceneControl => {
    const holder = holderOf(scene, o.id), holds = attachedTo(scene, o.id);
    const group: ControlGroup = o.kind === 'scenery' && o.importance === 'background' ? 'scene' : holder ? 'attached' : o.importance === 'main' && isForeground(o) ? 'main'
      : o.kind === 'decoration' || o.kind === 'effect' || o.importance === 'decoration' ? 'decoration' : o.kind === 'scenery' ? 'scene' : 'supporting';
    return { id: o.id, type: 'object', label: o.label, group, current: o.description, details: o.properties.map(p => `${SCENE_PROPERTY_LABELS[p.key]}: ${p.value}`),
      ...(o.identity?.brand ? { identity: `${o.identity.brand}${o.identity.model ? ` ${o.identity.model}` : ''}` } : {}), uncertain: o.confidence < 0.6 || (!!o.identity && o.identity.confidence < 0.6 && !o.corrected), corrected: !!o.corrected,
      actions: allowedActions(scene, o.id), properties: o.properties.map(p => ({ key: p.key, label: SCENE_PROPERTY_LABELS[p.key], value: p.value })), brandable: ['product', 'object', 'furniture'].includes(o.kind),
      ...(holder ? { relation: `${scene.relations.some(r => r.relation === 'wears' && r.target === o.id) ? 'worn' : 'held'} by ${label(holder)}` } : holds.length ? { relation: `holds or wears ${holds.map(label).join(', ')}` } : {}),
      ...(mapping?.slots[o.id] ? { slotId: mapping.slots[o.id] } : {}) };
  });
  const marks = scene.marks.map((m): SceneControl => ({ id: m.id, type: 'mark', label: m.label, group: 'marks', current: m.text ? `${SCENE_MARK_LABELS[m.kind]} (${m.text})` : SCENE_MARK_LABELS[m.kind], details: [],
    uncertain: false, corrected: false, actions: ['keep', 'remove'], properties: [], brandable: false, ...(m.ownerId ? { relation: `printed on ${label(m.ownerId)}` } : { relation: 'placed on the artwork' }), ...(mapping?.slots[m.id] ? { slotId: mapping.slots[m.id] } : {}) }));
  const overlays = scene.overlays.map((t): SceneControl => ({ id: t.id, type: 'overlay', label: t.label, group: 'marks', current: `${capital(t.role)} text`, details: t.text ? [`Reads: ${t.text}`] : [],
    uncertain: false, corrected: false, actions: ['keep', 'remove'], properties: [], brandable: false, ...(t.refersTo.length ? { relation: `about ${t.refersTo.map(label).join(', ')}` } : {}), ...(mapping?.slots[t.id] ? { slotId: mapping.slots[t.id] } : {}) }));
  const order: ControlGroup[] = ['main', 'attached', 'supporting', 'scene', 'marks', 'decoration'];
  return [...objects, ...marks, ...overlays].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
export const groupedControls = (controls: SceneControl[]) => (Object.keys(CONTROL_GROUP_LABELS) as ControlGroup[]).map(group => ({ group, label: CONTROL_GROUP_LABELS[group], controls: controls.filter(c => c.group === group) })).filter(g => g.controls.length);

/** The draft with one item's action set (keep is explicit; undefined clears it back to inherited). */
export function setEdit(draft: SceneDraft, id: string, edit: ObjectEdit | undefined): SceneDraft {
  const edits = { ...draft.edits };
  if (edit) edits[id] = edit; else delete edits[id];
  const next: SceneDraft = { ...draft, edits };
  // A product photo goes with a replaced object only.
  if (next.referenceFor && next.edits[next.referenceFor]?.action !== 'replace') delete next.referenceFor;
  return next;
}
export function setCorrection(draft: SceneDraft, id: string, correction: SceneCorrection | undefined): SceneDraft {
  const corrections = { ...draft.corrections };
  if (correction && Object.values(correction).some(v => v !== undefined && v !== '')) corrections[id] = correction; else delete corrections[id];
  return { ...draft, corrections };
}
export const answerConflict = (draft: SceneDraft, option: ConflictOption) => applyConflictOption(draft, option);
/** The scene as the user now sees it (their corrections applied). */
export const correctedScene = (analysis: SceneAnalysis | undefined, draft: SceneDraft) => analysis?.scene ? applySceneCorrections(analysis.scene, draft.corrections) : undefined;
/** The draft's explicit changes, as the "Draft changes" list shows them (not resolved yet). */
export function draftChangeList(scene: SceneDescription, draft: SceneDraft): { id: string; label: string; action: ObjectAction; text: string }[] {
  const name = (id: string) => scene.objects.find(o => o.id === id)?.label ?? scene.marks.find(m => m.id === id)?.label ?? scene.overlays.find(t => t.id === id)?.label ?? id;
  return Object.entries(draft.edits).filter(([id]) => name(id) !== id).map(([id, e]) => ({ id, label: name(id), action: e.action,
    text: e.action === 'keep' ? 'keep as it is' : e.action === 'remove' ? 'remove' : `${e.property ? `${SCENE_PROPERTY_LABELS[e.property].toLowerCase()} → ` : ''}${[e.brand, e.value].filter(Boolean).join(' ') || (draft.referenceFor === id ? 'the product in your photo' : '')}` }));
}
export const hasDraftChanges = (draft: SceneDraft) => draftChanges(draft);
/** Everything a resolution is bound to, as one key: an edit to any of it makes a resolution stale. */
export const resolutionKey = (analysisId: string | undefined, draft: SceneDraft, reference?: { name: string; size: number; lastModified: number }) =>
  `${analysisId ?? ''}|${canonicalDraft(draft)}|${reference ? `${reference.name}:${reference.size}:${reference.lastModified}` : ''}`;
export type ResolutionStatus = 'none' | 'stale' | 'failed' | 'needs-input' | 'ready';
export function resolutionStatus(resolution: (Resolution & { key: string }) | undefined, currentKey: string): ResolutionStatus {
  if (!resolution) return 'none';
  if (resolution.key !== currentKey) return 'stale';
  if (resolution.state === 'failed' || !resolution.plan) return 'failed';
  return resolution.plan.status === 'needs-input' ? 'needs-input' : 'ready';
}
/** The resolved prompt as the preview shows it: the same compiler and inputs as the server, so it equals the persisted prompt. */
export const resolvedPreview = (scene: SceneDescription | undefined, resolution: Resolution | undefined, productReference: boolean) =>
  scene && resolution?.plan && resolution.plan.status !== 'needs-input' ? compileResolvedEdit(scene, resolution.plan, { productReference }) : undefined;
/** Subjects protected by default in a variant set: the one main subject, or none when it is ambiguous (the user picks). */
export const defaultProtected = (scene: SceneDescription) => mainIsAmbiguous(scene) ? [] : mainObjects(scene).map(o => o.id);
export const protectableObjects = (scene: SceneDescription) => scene.objects.filter(o => !o.ignored && isForeground(o));

/** Smart and variant executions' cost lines: each kind of call counted apart, as recorded. */
export function smartCostRows(execution: Pick<TemplateExecution, 'resolution' | 'variant' | 'variantSource' | 'usage'> | undefined): { label: string; value: string }[] | undefined {
  if (!execution?.resolution && !execution?.variant && !execution?.variantSource) return undefined;
  const n = (count: number | undefined, word: string) => `${count ?? 0} ${word}${count === 1 ? '' : 's'}`;
  return execution.resolution
    ? [{ label: 'Image analysis', value: `${n(execution.usage.analysisCalls, 'call')} · shared by edits of this image` }, { label: 'Change resolution', value: n(execution.usage.resolutionCalls, 'call') },
      ...(execution.usage.segmentationCalls ? [{ label: 'Product cutouts', value: `${n(execution.usage.segmentationCalls, 'mask request')} · the products a restyled background keeps` }] : [])]
    : [{ label: 'Creative variant', value: 'subject cutout and scene concepts made in its set' }];
}
/** How a resolved smart edit will be made (the server decides the same way from the same plan), and its extra paid calls. */
export function strategyPreview(scene: SceneDescription, plan: ChangePlan, cutout?: string): { kind: string; text: string; extra?: string } {
  const s = editStrategy(scene, plan), title = { none: 'No image request', local: 'Edits only the changed areas', background: 'Restyles around your products', layered: 'New background, then each changed product in its own place', global: 'Edits the whole image' }[s.kind];
  const masks = s.kind === 'background' || s.kind === 'layered' ? cutout === 'birefnet' ? 1 : s.protectIds.length : 0;
  return { kind: s.kind, text: `${title}. ${s.reasons.join(' ')}${s.kind === 'none' ? '' : ' The result keeps your image\'s own size.'}`,
    ...(masks ? { extra: `${masks} mask request${masks === 1 ? '' : 's'} to cut the products out before the image request (if the cutout is not reliable, the whole image is edited and you are asked to check it).` } : {}) };
}
/** What a generated smart edit kept of the original, as recorded with it. */
export function strategyResult(edit: TemplateExecution['edit']): string | undefined {
  const s = edit?.strategy, p = edit?.preservation;
  if (!s) return undefined;
  const pixels = (count: number, percent: number) => `${count.toLocaleString('en-IN')} pixels (${percent}% of the image)`;
  if (s.kind === 'local') return `Edited only ${[...new Set(s.regions.map(r => r.label))].join(', ')}${p ? `: ${pixels(p.unchangedPixels, p.unchangedPercent)} are your image's own, unchanged` : ''}.`;
  if (s.kind === 'background') return `Background restyled around ${s.protectIds.length} kept product${s.protectIds.length === 1 ? '' : 's'}${p?.products ? `: their own pixels, ${p.products.checkedPixels.toLocaleString('en-IN')} identical${p.products.edgePixels ? `, ${p.products.edgePixels.toLocaleString('en-IN')} soft edge pixels blended` : ''}` : ''}.`;
  return s.fallback ?? 'The whole image was edited (its size and aspect kept).';
}
export const semanticLabel = (v: SemanticVerification | undefined) => !v ? undefined : ({ passed: 'AI check passed', contradiction: 'AI check found a problem', uncertain: 'AI check is unsure', unchecked: 'Not checked by AI' } as const)[v.status];
export const VARIANT_STATUS: Record<string, string> = { pending: 'Waiting', generating: 'Generating…', done: 'Ready', failed: 'Failed' };
export const SET_STATUS: Record<VariantSet['state'], string> = { cutout: 'Preparing your products…', concepts: 'Writing scene ideas…', generating: 'Generating scenes…', ready: 'Ready', 'needs-cutout': 'Needs a cutout', failed: 'Stopped' };
