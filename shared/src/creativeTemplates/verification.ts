/**
 * Semantic verification of a generated creative: a vision model compares the result with the original against what the
 * plan expected (the replacement happened, the old brand's references are gone, unrelated marks and objects stayed, no
 * text was added, nothing is duplicated, hands still hold what they held). It is fallible and never a guarantee: every
 * answer is pass, fail or uncertain, a checker that did not run is "unchecked" — never a pass — and a confirmed
 * contradiction stops the result from being treated as ready until a person decides.
 */
import { holderOf, isForeground, type SceneDescription } from './scene.js';
import { markPhrase, objectPhrase, overlayPhrase, type ChangePlan } from './changePlan.js';

export const SEMANTIC_CHECKS = ['replacement-done', 'brand-consistent', 'old-references-absent', 'protected-kept', 'subject-count', 'relationships', 'no-added-text', 'no-duplicates', 'interactions-intact', 'layout-kept'] as const;
export type SemanticCheckId = typeof SEMANTIC_CHECKS[number];
export interface SemanticExpectation { id: SemanticCheckId; expectation: string }
export interface SemanticCheck { id: SemanticCheckId; status: 'pass' | 'fail' | 'uncertain'; message: string }
export interface SemanticVerification {
  /** passed: every check passed; contradiction: one failed; uncertain: some could not be told; unchecked: the checker did not run. */
  status: 'passed' | 'contradiction' | 'uncertain' | 'unchecked';
  checks: SemanticCheck[];
  model?: string; requestFile?: string; responseFile?: string; durationMs?: number;
  /** Why nothing was checked (not configured, or the checker failed). */
  reason?: string;
  note: string;
}
export const SEMANTIC_NOTE = 'An AI vision check, not a guarantee: it can miss or misjudge details. Look at the image yourself.';
export const verificationStatus = (checks: SemanticCheck[]): SemanticVerification['status'] =>
  checks.some(c => c.status === 'fail') ? 'contradiction' : checks.length && checks.every(c => c.status === 'pass') ? 'passed' : 'uncertain';
export const uncheckedVerification = (reason: string): SemanticVerification => ({ status: 'unchecked', checks: [], reason, note: SEMANTIC_NOTE });

/** What to check for a resolved smart edit: one expectation per check, in words about this scene. */
export function planExpectations(scene: SceneDescription, plan: ChangePlan): SemanticExpectation[] {
  const out: SemanticExpectation[] = [], changed = plan.entries.filter(e => e.operation !== 'keep');
  const replaced = changed.filter(e => e.operation === 'replace' && e.targetType === 'object');
  const removed = changed.filter(e => e.operation === 'remove');
  if (replaced.length || removed.some(e => e.source === 'explicit')) out.push({ id: 'replacement-done', expectation: [
    ...replaced.map(e => `${objectPhrase(scene, scene.objects.find(o => o.id === e.targetId)!)} is now ${JSON.stringify(e.to ?? 'something else')} and no part of the original remains`),
    ...removed.filter(e => e.source === 'explicit' && e.targetType === 'object').map(e => `${objectPhrase(scene, scene.objects.find(o => o.id === e.targetId)!)} is gone`)].join('; ') || 'the requested objects changed' });
  const branded = replaced.filter(e => e.brand);
  if (branded.length) out.push({ id: 'brand-consistent', expectation: branded.map(e => `the new product shows only ${e.brand} branding, if any, and no other brand's logo or name`).join('; ') });
  const goneMarks = removed.filter(e => e.targetType !== 'object');
  if (goneMarks.length) out.push({ id: 'old-references-absent', expectation: `these are absent: ${goneMarks.map(e => e.targetType === 'mark' ? markPhrase(scene, scene.marks.find(m => m.id === e.targetId)!) : (scene.overlays.find(t => t.id === e.targetId) ? overlayPhrase(scene.overlays.find(t => t.id === e.targetId)!, scene) : 'that text block')).join('; ')}` });
  const touched = new Set(changed.map(e => e.targetId));
  const keptMarks = scene.marks.filter(m => !touched.has(m.id)), keptObjects = scene.objects.filter(o => !o.ignored && isForeground(o) && !touched.has(o.id));
  if (keptMarks.length || keptObjects.length) out.push({ id: 'protected-kept', expectation: `these are still present and unchanged: ${[...keptObjects.map(o => objectPhrase(scene, o)), ...keptMarks.map(m => markPhrase(scene, m))].join('; ')}` });
  const people = scene.objects.filter(o => !o.ignored && (o.kind === 'person' || o.kind === 'character') && !removed.some(e => e.targetId === o.id));
  out.push({ id: 'subject-count', expectation: `exactly ${people.length} ${people.length === 1 ? 'person or character is' : 'people or characters are'} visible` });
  const held = scene.objects.filter(o => !o.ignored && holderOf(scene, o.id) && !removed.some(e => e.targetId === o.id || e.targetId === holderOf(scene, o.id)));
  if (held.length) out.push({ id: 'interactions-intact', expectation: held.map(o => `${objectPhrase(scene, scene.objects.find(h => h.id === holderOf(scene, o.id))!)} still holds or wears ${replaced.some(e => e.targetId === o.id) ? 'the new object' : objectPhrase(scene, o)} naturally, with an intact hand`).join('; ') });
  out.push({ id: 'no-added-text', expectation: 'no new text, letters, numbers, prices, badges with lettering or watermarks were added (text that was already there and kept does not count)' });
  out.push({ id: 'no-duplicates', expectation: 'no object, product or person appears twice by mistake' });
  // Feature 2 keeps the template's structure: a re-composed result is a failure, not a style choice.
  const objectChanges = changed.some(e => e.targetType === 'object' && (e.operation === 'replace' || e.operation === 'modify'));
  if (plan.intent) out.push({ id: 'layout-kept', expectation: 'the new product sits in the area the original products occupied and is fully inside the image (not cut off by any edge), and the rest of the layout (text areas, logos, decorations, framing) is where it was' });
  else if (objectChanges || changed.some(e => e.targetType === 'object')) out.push({ id: 'layout-kept', expectation: 'every product and object is in the same place as in the original, at the same size, with the same tilt and front-to-back order (the original arrangement is kept), and nothing is cut off by the image edge or enlarged; the canvas framing is unchanged' });
  return out;
}
/** What to check for a new creative variant: its protected subjects appear once, intact, with no added text. */
export function variantExpectations(scene: SceneDescription, protectedIds: string[]): SemanticExpectation[] {
  const subjects = protectedIds.map(id => scene.objects.find(o => o.id === id)).filter((o): o is NonNullable<typeof o> => !!o);
  const people = subjects.filter(o => o.kind === 'person' || o.kind === 'character');
  return [
    { id: 'protected-kept', expectation: `${subjects.map(o => objectPhrase(scene, o)).join('; ')} ${subjects.length === 1 ? 'appears' : 'appear'} unchanged in the new scene` },
    { id: 'subject-count', expectation: `exactly ${people.length} ${people.length === 1 ? 'person or character is' : 'people or characters are'} visible, and no extra product or hand was added` },
    ...(subjects.some(o => holderOf(scene, o.id)) ? [{ id: 'interactions-intact' as const, expectation: 'hands still hold or wear their objects naturally' }] : []),
    { id: 'no-added-text', expectation: 'the new scene contains no text, letters, numbers, prices, badges with lettering, watermarks or logos (markings printed on the protected product itself are allowed)' },
    { id: 'no-duplicates', expectation: 'the protected subject appears exactly once; there is no ghost, second copy or outline of it in the scenery' },
  ];
}
/** A checker's answer: exactly the asked checks, each once, with a known status. Anything else is a failed checker. */
export function parseVerificationAnswer(value: unknown, asked: SemanticExpectation[]): SemanticCheck[] {
  const v = value as { checks?: unknown } | undefined;
  if (!v || !Array.isArray(v.checks)) throw new Error('The checker returned no checks.');
  const out: SemanticCheck[] = [];
  for (const raw of v.checks as Record<string, unknown>[]) {
    if (!raw || !asked.some(a => a.id === raw.id) || out.some(c => c.id === raw.id) || !['pass', 'fail', 'uncertain'].includes(raw.status as string) || typeof raw.message !== 'string') throw new Error('The checker answered a check it was not asked, or in an unknown form.');
    // Model text is data: control characters and markup are removed before it is shown.
    // eslint-disable-next-line no-control-regex
    out.push({ id: raw.id as SemanticCheckId, status: raw.status as SemanticCheck['status'], message: raw.message.replace(/[\u0000-\u001f<>{}`]/g, ' ').slice(0, 240).trim() });
  }
  if (out.length !== asked.length) throw new Error('The checker skipped a check.');
  return out;
}
