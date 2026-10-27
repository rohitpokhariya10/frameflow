/**
 * The client of Text & Graphics master templates and their creatives (server/src/decomposition/protectedTemplates/master/).
 * Every request goes to the app's own server. Nothing here spends anything: the scan is local OCR, the clean background is
 * made locally, creatives read stored files only. A master's optional decomposition is the protected template's own
 * confirmed request (protectedTemplates/api.ts `decompose`).
 */
import type { CreativeAsset, CreativeInstance, LogoSlot, MasterInfo, MasterRescan, MasterRescanProposal, MasterRevisionRef, MasterSnapshot, MasterStage, ProtectedSourceOrigin, ProtectedTemplate, ProtectedTemplateView, RescanChanges, TextAnalysis, TextPlate, DetectedWord, WordGroup } from '@frameflow/shared';
import { ProtectedApiError, protectedFileUrl } from '../protectedTemplates/api';

const BASE = '/api/layerize-experiment/master-templates';
export { protectedFileUrl as masterFileUrl, ProtectedApiError as MasterApiError };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new ProtectedApiError(response.status === 404 && !body?.error ? 'Offer templates need the server\'s layerize experiment (LAYERIZE_EXPERIMENT=1).' : error.message ?? `Request failed (${response.status}).`, error.code ?? 'HTTP_ERROR', response.status, error);
  }
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (file: Blob, fields: Record<string, string>, name?: string): RequestInit => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('image', file, name ?? (file instanceof File ? file.name : 'image.png'));
  return { method: 'POST', body: form };
};

export interface MasterView {
  template: ProtectedTemplateView & Pick<ProtectedTemplate, 'textAnalysis'>;
  master: MasterInfo; stage: MasterStage;
  review: { pending: number; uncertain: number; total: number };
  /** olderCleanup: made by an older local clean-up (may keep leftovers); make it again, approve and save to publish a repaired revision. */
  background: { ready: boolean; approved: boolean; method?: string; reliability?: string; stale: boolean; olderCleanup: boolean };
  latestRevision: MasterRevisionRef | null; changedSincePublish: boolean; creatives: number;
  activity: MasterInfo['activity'] & { seedreamRequests: number; imageGenerations: 0 };
}
export interface MasterListItem { id: string; name: string; createdAt: string; updatedAt: string; stage: MasterStage; source: ProtectedTemplate['source']; words: number; logos: number; revisions: number; latestRevision: number | null; creatives: number }
export interface CreativeSummary { id: string; name: string; masterRevision: number; createdAt: string; updatedAt: string; revision: number; texts: number; images: number; editorSavedAt: string | null }
/** A finished "Scan again" compared with the current elements (nothing is applied yet). */
export interface MasterRescanResult { rescan: MasterRescan; found: MasterRescanProposal['found']; analysisRevision: number; changes: RescanChanges }
/** What the review screen sends back: the whole list (server-owned fields are recomputed there). */
export interface ReviewDraft { words: DetectedWord[]; groups: WordGroup[]; logoSlots: LogoSlot[]; plates: TextPlate[] }
type Ref = { id: string; revision: number };
const ref = (v: MasterView): Ref => ({ id: v.template.id, revision: v.template.revision });

export const masterApi = {
  list: () => call<{ masters: MasterListItem[] }>(''),
  get: (id: string) => call<MasterView>(`/${encodeURIComponent(id)}`),
  create: (file: File | Blob, name: string, origin?: ProtectedSourceOrigin) => call<MasterView>('', upload(file, { ...(name.trim() ? { name: name.trim() } : {}), ...(origin ? { origin: JSON.stringify(origin) } : {}) })),
  rename: (v: MasterView, name: string) => call<MasterView>(`/${ref(v).id}`, json('PATCH', { expectedRevision: ref(v).revision, name })),
  /** Asks for the scan; it is saved per source, so this returns the saved result unless `force`. */
  scan: (v: MasterView, force = false) => call<{ started: boolean; master: MasterView }>(`/${ref(v).id}/scan`, json('POST', { force })),
  /** Scan again: reads the upload again into suggestions; nothing changes until some are applied. */
  rescan: (v: MasterView) => call<{ started: boolean; master: MasterView }>(`/${ref(v).id}/rescan`, json('POST', {})),
  rescanResult: (id: string) => call<MasterRescanResult>(`/${encodeURIComponent(id)}/rescan`),
  applyRescan: (v: MasterView, analysisRevision: number, change: { mode: 'selected'; wordIds: string[]; addWordIds: string[]; addPlateIds: string[] } | { mode: 'replace' }) =>
    call<MasterView>(`/${ref(v).id}/rescan/apply`, json('POST', { expectedRevision: ref(v).revision, expectedAnalysisRevision: analysisRevision, ...change })),
  discardRescan: (v: MasterView) => call<MasterView>(`/${ref(v).id}/rescan?expectedRevision=${ref(v).revision}`, { method: 'DELETE' }),
  saveReview: (v: MasterView, draft: ReviewDraft) => call<MasterView>(`/${ref(v).id}/review`, json('PUT', { expectedRevision: ref(v).revision, expectedAnalysisRevision: v.template.textAnalysis?.revision, ...draft })),
  approveAll: (v: MasterView, includeUncertain: boolean) => call<MasterView>(`/${ref(v).id}/review/approve-all`, json('POST', { expectedRevision: ref(v).revision, includeUncertain })),
  prepare: (v: MasterView) => call<MasterView>(`/${ref(v).id}/prepare`, json('POST', { expectedRevision: ref(v).revision })),
  uploadBackground: (v: MasterView, file: File) => call<MasterView>(`/${ref(v).id}/background`, upload(file, { expectedRevision: String(ref(v).revision) })),
  approveBackground: (v: MasterView, acknowledgeEstimate: boolean) => call<MasterView>(`/${ref(v).id}/background/approve`, json('POST', { expectedRevision: ref(v).revision, acknowledgeEstimate })),
  chooseArtwork: (v: MasterView, mode: 'background' | 'seedream', runId?: string) => call<MasterView>(`/${ref(v).id}/artwork`, json('POST', { expectedRevision: ref(v).revision, mode, ...(runId ? { runId } : {}) })),
  publish: (v: MasterView) => call<MasterView>(`/${ref(v).id}/publish`, json('POST', { expectedRevision: ref(v).revision })),
  snapshot: (id: string, revision: number) => call<MasterSnapshot>(`/${encodeURIComponent(id)}/revisions/${revision}`),
  creatives: (id: string) => call<{ creatives: CreativeSummary[] }>(`/${encodeURIComponent(id)}/creatives`),
  createCreative: (id: string, name?: string) => call<CreativeInstance>(`/${encodeURIComponent(id)}/creatives`, json('POST', name ? { name } : {})),
  getCreative: (id: string, cid: string) => call<CreativeInstance>(`/${encodeURIComponent(id)}/creatives/${encodeURIComponent(cid)}`),
  saveCreative: (c: CreativeInstance, from: 'content' | 'editor' = 'content', designId?: string) =>
    call<CreativeInstance>(`/${c.masterId}/creatives/${c.id}`, json('PUT', { expectedRevision: c.revision, from, ...(designId ? { designId } : {}), creative: { name: c.name, groups: c.groups, texts: c.texts, images: c.images, shapes: c.shapes, ...(c.backgroundColor ? { backgroundColor: c.backgroundColor } : {}) } })),
  uploadAsset: (c: Pick<CreativeInstance, 'masterId' | 'id'>, file: Blob, name?: string) => call<{ asset: CreativeAsset; hasAlpha: boolean }>(`/${c.masterId}/creatives/${c.id}/assets`, upload(file, {}, name)),
  /** The creative on the newest revision when only the background changed there (a repaired clean background). */
  /** The creative as a decomposition run (made from its own layers on the server, free; the same revision returns its run). */
  decompose: (c: Pick<CreativeInstance, 'masterId' | 'id'>) => call<{ runId: string; created: boolean }>(`/${c.masterId}/creatives/${c.id}/decomposition`, json('POST', {})),
  rebase: (c: Pick<CreativeInstance, 'masterId' | 'id' | 'revision'>) => call<CreativeInstance>(`/${c.masterId}/creatives/${c.id}/rebase`, json('POST', { expectedRevision: c.revision })),
  duplicate: (c: Pick<CreativeInstance, 'masterId' | 'id'>, name?: string) => call<CreativeInstance>(`/${c.masterId}/creatives/${c.id}/duplicate`, json('POST', name ? { name } : {})),
  recordExport: (c: Pick<CreativeInstance, 'masterId' | 'id'>, width: number, height: number) => call<CreativeInstance>(`/${c.masterId}/creatives/${c.id}/exports`, json('POST', { width, height })),
  deleteCreative: (c: Pick<CreativeInstance, 'masterId' | 'id'>) => call<{ deleted: string }>(`/${c.masterId}/creatives/${c.id}`, { method: 'DELETE' }),
};
/** What the clean background would remove now, tinted over the poster (changes with each saved review). */
export const removalPreviewUrl = (v: MasterView) => `${BASE}/${encodeURIComponent(v.template.id)}/removal-preview?rev=${v.template.textAnalysis?.revision ?? 0}-${v.template.revision}`;
/** The analysis a view carries (the scan's words, logo slots and plates). */
export const analysisOf = (v: MasterView): TextAnalysis | undefined => v.template.textAnalysis;
