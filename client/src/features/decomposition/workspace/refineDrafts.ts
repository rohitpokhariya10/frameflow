import type { DecompositionJobSummary } from '@frameflow/shared';
import type { PaintEdits } from './PaintCanvas';

/**
 * Unsaved Refine Selection and edge drafts, one per job + step + object, bound to the saved revision they were painted on.
 * A draft survives remounts and failed saves; it is never applied to another object or to a different revision.
 * Persistence is local only: nothing here submits a review or calls a provider.
 */
export type ObjectDraft = PaintEdits & { selected: boolean };
type Job = Pick<DecompositionJobSummary, 'id' | 'state' | 'sourceWidth' | 'sourceHeight'>;
/** A selection candidate (refine) or a refined cut-out (edges). */
type Candidate = { id: string; label: string; revisionId?: string; maskArtifactId?: string; alphaArtifactId?: string };
export type DraftStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; key?(index: number): string | null; length?: number };
type StoredDraft<T extends PaintEdits = ObjectDraft> = { v: 1; jobId: string; objectId: string; label: string; base: string; width?: number; height?: number; draft: T; submitted?: boolean };

/** Each step keeps its own drafts: a selection stroke is never replayed as an edge stroke, or the reverse. */
export type DraftScope = { prefix: string; base: (item: Candidate) => string };
/** Selection strokes are painted on the saved ownership mask. */
export const REFINE_DRAFTS: DraftScope = { prefix: 'frameflow:refine-draft:', base: item => item.revisionId ?? item.maskArtifactId ?? '' };
/** Edge strokes are painted on the saved alpha. */
export const EDGE_DRAFTS: DraftScope = { prefix: 'frameflow:edge-draft:', base: item => item.revisionId ?? item.alphaArtifactId ?? '' };
export const draftKey = (jobId: string, objectId: string, scope = REFINE_DRAFTS) => `${scope.prefix}${jobId}:${objectId}`;
export const hasEdits = (draft?: PaintEdits) => !!(draft?.strokes?.length || draft?.points?.length || draft?.box);

export function sessionDraftStorage(): DraftStorage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
}
function read<T extends PaintEdits>(storage: DraftStorage, key: string): StoredDraft<T> | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null') as StoredDraft<T> | null;
    return value?.v === 1 && typeof value.base === 'string' && typeof value.draft === 'object' && value.draft ? value : undefined;
  } catch { return undefined; }
}
function write<T extends PaintEdits>(storage: DraftStorage, key: string, value: StoredDraft<T> | undefined) {
  try { if (value) storage.setItem(key, JSON.stringify(value)); else storage.removeItem(key); } catch { /* optional */ }
}

/**
 * Restores each object's draft if it was painted on that object's current revision of the same source.
 * A draft whose save succeeded (it was submitted and the revision moved on) is cleared silently; any other draft
 * whose object changed or disappeared is cleared and reported, so the user knows their edits were not applied.
 */
export function loadObjectDrafts<T extends PaintEdits = ObjectDraft>(storage: DraftStorage | undefined, job: Job, candidates: Candidate[], fallback: Record<string, T>, scope = REFINE_DRAFTS) {
  const drafts = { ...fallback }, invalidated: string[] = [];
  if (!storage) return { drafts, invalidated };
  const drop = (key: string, stored: StoredDraft<T> | undefined) => { write(storage, key, undefined); if (stored && !stored.submitted && hasEdits(stored.draft)) invalidated.push(stored.label); };
  for (const candidate of candidates) {
    const key = draftKey(job.id, candidate.id, scope), stored = read<T>(storage, key);
    if (!stored) continue;
    const compatible = stored.jobId === job.id && stored.objectId === candidate.id && stored.base === scope.base(candidate) && stored.width === job.sourceWidth && stored.height === job.sourceHeight;
    if (!compatible) { drop(key, stored); continue; }
    drafts[candidate.id] = stored.draft;
    // The step only renders once the job is back at review: a submitted draft on an unchanged revision was not saved.
    if (stored.submitted && job.state === 'needs_review') write(storage, key, { ...stored, submitted: false });
  }
  const jobPrefix = `${scope.prefix}${job.id}:`, ids = new Set(candidates.map(c => c.id)), orphans: string[] = [];
  try { for (let i = 0; i < (storage.length ?? 0); i++) { const key = storage.key?.(i); if (key?.startsWith(jobPrefix) && !ids.has(key.slice(jobPrefix.length))) orphans.push(key); } } catch { /* optional */ }
  for (const key of orphans) drop(key, read<T>(storage, key));
  return { drafts, invalidated: [...new Set(invalidated)] };
}

/** Saves one object's draft against its current revision; an unchanged draft keeps its submitted mark. */
export function persistObjectDraft<T extends PaintEdits & { selected?: boolean }>(storage: DraftStorage | undefined, job: Job, candidate: Candidate, draft: T, scope = REFINE_DRAFTS) {
  if (!storage) return;
  const key = draftKey(job.id, candidate.id, scope);
  if (!hasEdits(draft) && draft.selected !== false) { write(storage, key, undefined); return; }
  const previous = read<T>(storage, key), base = scope.base(candidate);
  const unchanged = previous?.base === base && JSON.stringify(previous.draft) === JSON.stringify(draft);
  write(storage, key, { v: 1, jobId: job.id, objectId: candidate.id, label: candidate.label, base, width: job.sourceWidth, height: job.sourceHeight, draft, ...(unchanged && previous?.submitted ? { submitted: true } : {}) });
}

/** Marks a draft as sent for saving, so a successful save can clear it without warning. */
export function markDraftSubmitted(storage: DraftStorage | undefined, job: Job, candidate: Candidate, scope = REFINE_DRAFTS) {
  if (!storage) return;
  const key = draftKey(job.id, candidate.id, scope), stored = read(storage, key);
  if (stored?.base === scope.base(candidate)) write(storage, key, { ...stored, submitted: true });
}
