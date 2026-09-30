import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecompositionJobSummary } from '@frameflow/shared';
import { EdgesStep, RefineStep } from './workspace/RefineStep';
import { EDGE_DRAFTS, REFINE_DRAFTS, draftKey, loadObjectDrafts, markDraftSubmitted, persistObjectDraft, type ObjectDraft } from './workspace/refineDrafts';

afterEach(() => vi.unstubAllGlobals());
function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), key: (i: number) => [...map.keys()][i] ?? null, get length() { return map.size; } };
}
type Candidate = NonNullable<DecompositionJobSummary['candidates']>[number];
const candidate = (id: string, revisionId: string): Candidate => ({ id, label: id === 'jhula' ? 'Jhula' : 'Title', source: 'sam3', maskArtifactId: `${id}-mask`, revisionId, qualityTier: 'REVIEW', qualityChecks: [], warnings: [] });
const job = (revision: number, candidates: Candidate[], patch: Partial<DecompositionJobSummary> = {}) =>
  ({ id: 'job', state: 'needs_review', revision, sourceWidth: 256, sourceHeight: 256, sourcePreviewArtifactId: 'source', warnings: [], artifacts: [], candidates, ...patch }) as DecompositionJobSummary;
const stroke = (x: number) => ({ mode: 'add' as const, radius: 8, points: [{ x, y: 90 }] });
const fallback = (candidates: Candidate[]): Record<string, ObjectDraft> => Object.fromEntries(candidates.map(c => [c.id, { selected: true, strokes: [] }]));

it('a failed manual save keeps the strokes, even though the job revision moved on', () => {
  const storage = memoryStorage(), jhula = candidate('jhula', 'rev-1'), draft = { selected: true, strokes: [stroke(80)], points: [{ x: 10, y: 10, label: 1 as const }], box: { x: 5, y: 5, width: 20, height: 20 } };
  persistObjectDraft(storage, job(4, [jhula]), jhula, draft);
  markDraftSubmitted(storage, job(4, [jhula]), jhula);
  // Validation failed server-side: revision 4 → 6, but Jhula's saved mask revision is unchanged.
  const { drafts, invalidated } = loadObjectDrafts(storage, job(6, [jhula]), [jhula], fallback([jhula]));
  expect(drafts.jhula).toEqual(draft);
  expect(invalidated).toEqual([]);
  // Once back at review the draft is no longer "in flight", so a later unrelated change would be reported, not hidden.
  expect(JSON.parse(storage.map.get(draftKey('job', 'jhula'))!).submitted).toBe(false);
  vi.stubGlobal('sessionStorage', storage);
  const html = renderToStaticMarkup(createElement(RefineStep, { job: job(6, [jhula]), onSubmit: async () => {}, busy: false }));
  expect(html).toContain('Unsaved edits');
  expect(html).toContain('<polyline points="80,90"');
});

it('switching objects keeps a separate draft for each object', () => {
  const storage = memoryStorage(), jhula = candidate('jhula', 'rev-1'), title = candidate('title', 'rev-7'), value = job(4, [jhula, title]);
  persistObjectDraft(storage, value, jhula, { selected: true, strokes: [stroke(80)] });
  persistObjectDraft(storage, value, title, { selected: true, strokes: [stroke(150)] });
  const { drafts } = loadObjectDrafts(storage, job(5, [jhula, title]), [jhula, title], fallback([jhula, title]));
  expect(drafts.jhula.strokes).toEqual([stroke(80)]);
  expect(drafts.title.strokes).toEqual([stroke(150)]);
  storage.setItem('frameflow:refine-active:job', 'title');
  vi.stubGlobal('sessionStorage', storage);
  const html = renderToStaticMarkup(createElement(RefineStep, { job: job(5, [jhula, title]), onSubmit: async () => {}, busy: false }));
  expect(html).toContain('Selection for Title');
  expect(html).toContain('<polyline points="150,90"');
  expect(html).not.toContain('<polyline points="80,90"');
  expect(html.match(/Unsaved edits/g)).toHaveLength(2);
});

it('a successful save clears only the saved object\'s draft, silently', () => {
  const storage = memoryStorage(), jhula = candidate('jhula', 'rev-1'), title = candidate('title', 'rev-7'), value = job(4, [jhula, title]);
  persistObjectDraft(storage, value, jhula, { selected: true, strokes: [stroke(80)] });
  persistObjectDraft(storage, value, title, { selected: true, strokes: [stroke(150)] });
  markDraftSubmitted(storage, value, jhula);
  const saved = candidate('jhula', 'rev-2');
  const { drafts, invalidated } = loadObjectDrafts(storage, job(6, [saved, title]), [saved, title], fallback([saved, title]));
  expect(drafts.jhula.strokes).toEqual([]);
  expect(storage.map.has(draftKey('job', 'jhula'))).toBe(false);
  expect(drafts.title.strokes).toEqual([stroke(150)]);
  expect(invalidated).toEqual([]);
});

it('never applies a stale or incompatible draft, and tells the user when unsaved edits were dropped', () => {
  const storage = memoryStorage(), jhula = candidate('jhula', 'rev-1'), title = candidate('title', 'rev-7');
  persistObjectDraft(storage, job(4, [jhula, title]), jhula, { selected: true, strokes: [stroke(80)] });
  // Another object's draft copied under Title's key, a draft from another job, and a draft for a different source size.
  storage.setItem(draftKey('job', 'title'), JSON.stringify({ v: 1, jobId: 'job', objectId: 'jhula', label: 'Jhula', base: 'rev-7', width: 256, height: 256, draft: { selected: true, strokes: [stroke(30)] } }));
  storage.setItem(draftKey('other-job', 'jhula'), JSON.stringify({ v: 1, jobId: 'other-job', objectId: 'jhula', label: 'Jhula', base: 'rev-1', width: 256, height: 256, draft: { selected: true, strokes: [stroke(40)] } }));
  // Jhula's selection changed without this draft being saved (e.g. an edge edit or another tab).
  const changed = candidate('jhula', 'rev-9');
  const { drafts, invalidated } = loadObjectDrafts(storage, job(7, [changed, title]), [changed, title], fallback([changed, title]));
  expect(drafts.jhula.strokes).toEqual([]);
  expect(drafts.title.strokes).toEqual([]);
  expect(invalidated).toContain('Jhula');
  expect(storage.map.has(draftKey('other-job', 'jhula'))).toBe(true);
  // A different source size, and an object that no longer exists (merged away), are also rejected.
  persistObjectDraft(storage, job(7, [changed]), changed, { selected: true, strokes: [stroke(80)] });
  persistObjectDraft(storage, job(7, [title]), title, { selected: true, strokes: [stroke(150)] });
  const resized = loadObjectDrafts(storage, job(8, [changed], { sourceWidth: 512, sourceHeight: 512 }), [changed], fallback([changed]));
  expect(resized.drafts.jhula.strokes).toEqual([]);
  expect(resized.invalidated).toEqual(['Jhula', 'Title']);
  expect(storage.map.has(draftKey('job', 'title'))).toBe(false);
});

it('shows why a draft was cleared, and restoring drafts never submits a review or calls a provider', () => {
  const storage = memoryStorage(), jhula = candidate('jhula', 'rev-1');
  persistObjectDraft(storage, job(4, [jhula]), jhula, { selected: true, strokes: [stroke(80)] });
  vi.stubGlobal('sessionStorage', storage);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const onSubmit = vi.fn(async () => {});
  const html = renderToStaticMarkup(createElement(RefineStep, { job: job(9, [candidate('jhula', 'rev-3')]), onSubmit, busy: false }));
  expect(html).toContain('Your unsaved edits on “Jhula” were cleared because the selection changed.');
  expect(html).not.toContain('<polyline points="80,90"');
  renderToStaticMarkup(createElement(RefineStep, { job: job(9, [jhula]), onSubmit, busy: false }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

type Refined = NonNullable<DecompositionJobSummary['refined']>[number];
const cutout = (id: string, revisionId: string): Refined => ({ id, label: id === 'jhula' ? 'Jhula' : 'Title', maskArtifactId: `${id}-mask`, alphaArtifactId: `${id}-alpha-${revisionId}`, overlayArtifactId: `${id}-overlay`, revisionId, maskRevisionId: revisionId, alphaRevisionId: revisionId, overlayRevisionId: revisionId, warnings: [] });
const edgesJob = (revision: number, refined: Refined[]) => job(revision, [], { refined, review: { code: 'REFINEMENT_VISUAL_REVIEW', message: 'x', actions: ['approve-result', 'manual-alpha'], artifactIds: [], gate: 'alpha-review' } });
const renderEdges = (value: DecompositionJobSummary, onSubmit = async () => {}) => renderToStaticMarkup(createElement(EdgesStep, { job: value, onSubmit, busy: false }));

it('edge step: a rejected alpha save keeps the strokes and still blocks "Looks good"', () => {
  const storage = memoryStorage(), jhula = cutout('jhula', 'rev-1');
  persistObjectDraft(storage, edgesJob(10, [jhula]), jhula, { strokes: [stroke(80)] }, EDGE_DRAFTS);
  markDraftSubmitted(storage, edgesJob(10, [jhula]), jhula, EDGE_DRAFTS);
  vi.stubGlobal('sessionStorage', storage);
  // ALPHA_REVIEW_REQUIRED bumps the job revision but keeps Jhula's saved alpha revision.
  const html = renderEdges(edgesJob(12, [jhula]));
  expect(html).toContain('<polyline points="80,90"');
  expect(html).toContain('Unsaved edits');
  expect(html).toContain('Save your edge changes before continuing.');
  expect(html).toMatch(/<button class="ws-btn ws-btn-primary" disabled="">Looks good<\/button>/);
  expect(JSON.parse(storage.map.get(draftKey('job', 'jhula', EDGE_DRAFTS))!).submitted).toBe(false);
});

it('edge step: each object keeps its own edge draft, separate from its selection draft', () => {
  const storage = memoryStorage(), jhula = cutout('jhula', 'rev-1'), title = cutout('title', 'rev-2'), value = edgesJob(10, [jhula, title]);
  persistObjectDraft(storage, value, jhula, { strokes: [stroke(80)] }, EDGE_DRAFTS);
  persistObjectDraft(storage, value, title, { strokes: [stroke(150)] }, EDGE_DRAFTS);
  // A selection draft for the same object and revision is never replayed as edge strokes, or the reverse.
  persistObjectDraft(storage, value, jhula, { selected: true, strokes: [stroke(30)] }, REFINE_DRAFTS);
  const { drafts } = loadObjectDrafts(storage, edgesJob(11, [jhula, title]), [jhula, title], {}, EDGE_DRAFTS);
  expect(drafts).toEqual({ jhula: { strokes: [stroke(80)] }, title: { strokes: [stroke(150)] } });
  expect(loadObjectDrafts(storage, edgesJob(11, [jhula]), [jhula], {}, REFINE_DRAFTS).drafts.jhula.strokes).toEqual([stroke(30)]);
  storage.setItem('frameflow:edges-active:job', 'title');
  vi.stubGlobal('sessionStorage', storage);
  const html = renderEdges(edgesJob(11, [jhula, title]));
  expect(html).toContain('Edges of Title');
  expect(html).toContain('<polyline points="150,90"');
  expect(html).not.toContain('<polyline points="30,90"');
  expect(html.match(/Unsaved edits/g)).toHaveLength(2);
});

it('edge step: a saved alpha edit clears only that object\'s draft; a restore that changes the cut-out reports the dropped edits', () => {
  const storage = memoryStorage(), jhula = cutout('jhula', 'rev-1'), title = cutout('title', 'rev-2'), value = edgesJob(10, [jhula, title]);
  persistObjectDraft(storage, value, jhula, { strokes: [stroke(80)] }, EDGE_DRAFTS);
  persistObjectDraft(storage, value, title, { strokes: [stroke(150)] }, EDGE_DRAFTS);
  markDraftSubmitted(storage, value, jhula, EDGE_DRAFTS);
  const saved = cutout('jhula', 'rev-3');
  const afterSave = loadObjectDrafts(storage, edgesJob(12, [saved, title]), [saved, title], {}, EDGE_DRAFTS);
  expect(afterSave.drafts.jhula).toBeUndefined();
  expect(afterSave.drafts.title).toEqual({ strokes: [stroke(150)] });
  expect(afterSave.invalidated).toEqual([]);
  // "Restore trimmed areas" on Title creates a new alpha: strokes painted on the old cut-out are not applied to it.
  vi.stubGlobal('sessionStorage', storage);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const onSubmit = vi.fn(async () => {});
  storage.setItem('frameflow:edges-active:job', 'title');
  const html = renderEdges(edgesJob(14, [saved, cutout('title', 'rev-4')]), onSubmit);
  expect(html).toContain('Your unsaved edits on “Title” were cleared because the cut-out changed.');
  expect(html).not.toContain('<polyline points="150,90"');
  expect(storage.map.has(draftKey('job', 'title', EDGE_DRAFTS))).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
