/**
 * Corrections to a protected template's word analysis (protectedWords.ts), as the review screen holds it: the whole list of
 * words, phrases and logo slots. Structure is checked here (a malformed request is refused); what is incomplete or
 * doubtful is reported by analysisProblems and does not block saving.
 *
 * Server-owned fields are never taken from a request: what the recognizer read and its confidence, a slot's original
 * crop and its replacement file, and the review history (written here, from the differences).
 */
import { normalizeBox, PROTECTED_ROLES, readingOrder, validLogoSlotId, validWordGroupId, validWordId, validWordLineId, withHistory, WORD_LIMITS, WORD_ROLE_LABELS, isCatalogFont,
  type AnalysisEvent, type DetectedWord, type LogoSlot, type ProtectedTemplate, type SourceBox, type TextAnalysis, type WordGroup, type WordRole, type WordStyle } from '@frameflow/shared';
import { RunError } from '../layerizeExperiment.js';

function fail(message: string): never { throw new RunError('INVALID_TEXT_ANALYSIS', message); }
const num = (v: unknown, min = -1e6, max = 1e6): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function cleanBox(b: unknown, what: string): SourceBox {
  const x = b as Partial<SourceBox>;
  if (!x || typeof x !== 'object' || !num(x.x) || !num(x.y) || !num(x.width, WORD_LIMITS.minBoxPx) || !num(x.height, WORD_LIMITS.minBoxPx) || !num(x.rotation, -180, 180)) fail(`${what}: its box is not valid.`);
  return { x: x.x, y: x.y, width: x.width, height: x.height, rotation: x.rotation };
}
function cleanStyle(s: unknown, what: string): WordStyle {
  const x = s as Partial<WordStyle>;
  if (!x || typeof x !== 'object' || !isCatalogFont(x.fontFamily) || !['estimated', 'admin'].includes(x.fontMatch as string) || !num(x.fontSize, 1, 4096) || ![400, 600, 700].includes(x.fontWeight as number)
    || !['normal', 'italic'].includes(x.fontStyle as string) || !str(x.color, 7) || !/^#[\da-f]{6}$/i.test(x.color!) || !num(x.opacity, 0, 1) || !num(x.lineHeight, 0.5, 4) || !num(x.letterSpacing, -200, 200)
    || !num(x.baseline, -4096, 4096) || !['left', 'center', 'right'].includes(x.align as string) || (x.originDx !== undefined && !num(x.originDx, -4096, 4096))) fail(`${what}: its style is malformed (fonts must come from the font catalogue).`);
  return { fontFamily: x.fontFamily!, fontMatch: x.fontMatch!, fontSize: x.fontSize!, fontWeight: x.fontWeight!, fontStyle: x.fontStyle!, color: x.color!.toLowerCase(), opacity: x.opacity!, lineHeight: x.lineHeight!, letterSpacing: x.letterSpacing!, baseline: x.baseline!, align: x.align!,
    ...(x.originDx !== undefined ? { originDx: x.originDx } : {}) };
}
const review = (v: unknown, old: DetectedWord['review'] | undefined, at: string): DetectedWord['review'] => {
  const status = (v as { status?: unknown })?.status;
  if (!['needs-review', 'approved', 'rejected'].includes(status as string)) fail('A review status must be needs-review, approved or rejected.');
  return status === 'needs-review' ? { status: 'needs-review' } : { status: status as 'approved' | 'rejected', at: old?.status === status ? old?.at ?? at : at };
};

export interface AnalysisChange { next: TextAnalysis; recut: string[] }
/**
 * The analysis after a correction. `recut`: logo slots whose box changed or that are new, whose exact crop must be cut from
 * the source again (the caller does it, then saves).
 */
export function correctAnalysis(t: ProtectedTemplate, current: TextAnalysis, input: { words?: unknown; groups?: unknown; logoSlots?: unknown }, at: string): AnalysisChange {
  if (!Array.isArray(input.words) || !Array.isArray(input.groups) || !Array.isArray(input.logoSlots)) fail('Send the words, phrases and logo slots.');
  if (input.words.length > WORD_LIMITS.maxWords || input.logoSlots.length > WORD_LIMITS.maxLogoSlots) fail(`At most ${WORD_LIMITS.maxWords} words and ${WORD_LIMITS.maxLogoSlots} logo slots.`);
  const size = { width: t.source.width, height: t.source.height }, elements = new Set(t.elements.map(e => e.id)), events: AnalysisEvent[] = [];
  const oldWords = new Map(current.words.map(w => [w.id, w])), oldSlots = new Map(current.logoSlots.map(l => [l.id, l]));
  const groups: WordGroup[] = (input.groups as Partial<WordGroup>[]).map(g => {
    if (!validWordGroupId(g?.id) || !elements.has(g.elementId as string) || !str(g.label, 120) || !Array.isArray(g.lines) || !['left', 'center', 'right'].includes(g.align as string)) fail('A phrase is malformed.');
    return { id: g.id!, elementId: g.elementId!, label: g.label!, align: g.align!, lines: g.lines.map(l => {
      if (!validWordLineId(l?.id) || !Array.isArray(l.wordIds) || l.wordIds.some(id => !validWordId(id))) fail('A line is malformed.');
      return { id: l.id, wordIds: [...l.wordIds] };
    }) };
  });
  const placement = new Map<string, { groupId: string; lineId: string }>();
  for (const g of groups) for (const l of g.lines) for (const id of l.wordIds) { if (placement.has(id)) fail('A word can be on one line only.'); placement.set(id, { groupId: g.id, lineId: l.id }); }
  const words: DetectedWord[] = (input.words as Partial<DetectedWord>[]).map(w => {
    if (!validWordId(w?.id)) fail('Each word needs an id like pw-0123456789.');
    const old = oldWords.get(w.id!), name = `“${old?.text ?? w.text ?? w.id}”`;
    if (!str(w.text, WORD_LIMITS.maxWordChars) || !w.text.trim()) fail(`${name}: enter the word (up to ${WORD_LIMITS.maxWordChars} characters).`);
    if (!elements.has(w.elementId as string)) fail(`${name}: its protected region does not exist.`);
    const at2 = placement.get(w.id!) ?? fail(`${name}: it is on no line of a phrase.`);
    if (groups.find(g => g.id === at2.groupId)!.elementId !== w.elementId) fail(`${name}: its phrase is in another region.`);
    const role = w.role as WordRole;
    if (!(role in WORD_ROLE_LABELS)) fail(`${name}: unknown role.`);
    const box = cleanBox(w.box, name), style = cleanStyle(w.style, name), text = w.text.trim();
    const next: DetectedWord = {
      id: w.id!, text, recognized: old?.recognized ?? { text, confidence: 1, mode: 'admin' }, box, normalized: normalizeBox(box, size),
      elementId: w.elementId!, groupId: at2.groupId, lineId: at2.lineId, order: 0, style, confidence: old?.confidence ?? 1, styleConfidence: old && JSON.stringify(old.style) === JSON.stringify(style) ? old.styleConfidence : 1,
      role, review: review(w.review, old?.review, at), locked: w.locked === true, protected: w.protected === true || PROTECTED_ROLES.includes(role), origin: old?.origin ?? 'admin',
    };
    if (!old) events.push({ at, action: 'added', targetId: next.id, detail: `Added “${text}”.` });
    else {
      if (old.text !== text) events.push({ at, action: 'corrected', targetId: next.id, detail: `Text “${old.text}” → “${text}” (read as “${old.recognized.text}”).` });
      if (JSON.stringify(old.box) !== JSON.stringify(box)) events.push({ at, action: 'corrected', targetId: next.id, detail: `Box of “${text}” moved or resized.` });
      if (JSON.stringify(old.style) !== JSON.stringify(style)) events.push({ at, action: 'corrected', targetId: next.id, detail: `Style of “${text}” changed.` });
      if (old.role !== role || old.protected !== next.protected) events.push({ at, action: 'corrected', targetId: next.id, detail: `“${text}”: ${WORD_ROLE_LABELS[role]}${next.protected ? ', protected' : ''}.` });
      if (old.review.status !== next.review.status) events.push({ at, action: next.review.status === 'approved' ? 'approved' : next.review.status === 'rejected' ? 'rejected' : 'reopened', targetId: next.id, detail: `“${text}”.` });
      if (old.locked !== next.locked) events.push({ at, action: next.locked ? 'locked' : 'unlocked', targetId: next.id, detail: `“${text}”.` });
    }
    return next;
  });
  const ids = new Set(words.map(w => w.id));
  if (ids.size !== words.length) fail('Word ids must be unique.');
  if ([...placement.keys()].some(id => !ids.has(id))) fail('A phrase lists a word that does not exist.');
  for (const old of current.words) if (!ids.has(old.id)) events.push({ at, action: 'removed', targetId: old.id, detail: `Removed “${old.text}”.` });
  const recut: string[] = [];
  const logoSlots: LogoSlot[] = (input.logoSlots as Partial<LogoSlot>[]).map((l, i) => {
    if (!validLogoSlotId(l?.id)) fail('Each logo slot needs an id like pl-0123456789.');
    const old = oldSlots.get(l.id!), name = old?.label ?? l.label ?? l.id!;
    if (!str(l.label, 120) || !l.label.trim()) fail(`${name}: give it a name.`);
    if (!elements.has(l.elementId as string)) fail(`${name}: its protected region does not exist.`);
    const box = cleanBox(l.box, name);
    const moved = !old || JSON.stringify(old.box) !== JSON.stringify(box);
    if (moved) recut.push(l.id!);
    const next: LogoSlot = { id: l.id!, label: l.label.trim(), elementId: l.elementId!, box, normalized: normalizeBox(box, size),
      // Placeholder until the caller cuts the new crop (moved or new slots).
      original: old?.original ?? { file: '', sha256: '', mime: 'image/png', width: 0, height: 0, bytes: 0, hasAlpha: true, placement: { x: 0, y: 0, width: 0, height: 0 } },
      ...(old?.replacement ? { replacement: old.replacement } : {}), detection: old ? (moved ? 'admin' : old.detection) : 'admin', confidence: old?.confidence ?? 1, order: i,
      locked: l.locked === true, replaceable: l.replaceable !== false, review: review(l.review, old?.review, at) };
    if (!old) events.push({ at, action: 'added', targetId: next.id, detail: `Added logo slot ${next.label}.` });
    else {
      if (moved) events.push({ at, action: 'corrected', targetId: next.id, detail: `Box of ${next.label} corrected; its pixels were cut again from the source.` });
      if (old.review.status !== next.review.status) events.push({ at, action: next.review.status === 'approved' ? 'approved' : next.review.status === 'rejected' ? 'rejected' : 'reopened', targetId: next.id, detail: next.label });
      if (old.locked !== next.locked) events.push({ at, action: next.locked ? 'locked' : 'unlocked', targetId: next.id, detail: next.label });
    }
    return next;
  });
  if (new Set(logoSlots.map(l => l.id)).size !== logoSlots.length || logoSlots.some(l => ids.has(l.id))) fail('Logo slot ids must be unique.');
  for (const old of current.logoSlots) if (!logoSlots.some(l => l.id === old.id)) events.push({ at, action: 'removed', targetId: old.id, detail: `Removed logo slot ${old.label}.` });
  const regrouped = JSON.stringify(current.groups) !== JSON.stringify(groups);
  if (regrouped) events.push({ at, action: 'regrouped', detail: 'Phrases or lines changed.' });
  const changed = events.length > 0;
  return {
    next: changed ? { ...current, revision: current.revision + 1, updatedAt: at, words: readingOrder(words, groups.filter(g => g.lines.some(l => l.wordIds.length))), groups: groups.filter(g => g.lines.some(l => l.wordIds.length)).map(g => ({ ...g, lines: g.lines.filter(l => l.wordIds.length) })), logoSlots, history: withHistory(current.history, ...events) } : current,
    recut,
  };
}
/** Every file an analysis refers to (logo crops and replacements). */
export const analysisFiles = (a: TextAnalysis | undefined) => a ? a.logoSlots.flatMap(l => [l.original.file, l.replacement?.file]).filter((f): f is string => !!f) : [];
