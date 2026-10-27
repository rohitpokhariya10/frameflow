/**
 * The client of protected templates (server/src/decomposition/protectedTemplates/). Every request goes to the app's own
 * server; only `decompose` spends anything (one Seedream request), and only when the administrator confirms it.
 */
import type { ProtectedCheck, ProtectedElement, ProtectedReconstruction, ProtectedSourceOrigin, ProtectedTemplateView, ProtectedRunSummary, ProtectedStatus, SourceSize, TextAnalysis } from '@frameflow/shared';
import type { ExperimentRun } from '../decomposition/layerizeExperiment';

const BASE = '/api/layerize-experiment/protected-templates';
export const protectedFileUrl = (id: string, file: string) => `${BASE}/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;

/** A refused request: the server's own code and message, and its details (problems, preflight checks) when it sent them. */
export class ProtectedApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly details: { problems?: { message: string }[]; checks?: ProtectedCheck[]; revision?: number } = {}) { super(message); this.name = 'ProtectedApiError'; }
}
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new ProtectedApiError(response.status === 404 && !body?.error ? 'Protected templates need the server\'s layerize experiment (LAYERIZE_EXPERIMENT=1).' : error.message ?? `Request failed (${response.status}).`, error.code ?? 'HTTP_ERROR', response.status, error);
  }
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (file: Blob, fields: Record<string, string>, name?: string) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('image', file, name ?? (file instanceof File ? file.name : 'image.png'));
  return { method: 'POST', body: form };
};

export type ProtectedListItem = { id: string; name: string; createdAt: string; updatedAt: string; status: ProtectedStatus; elements: number; source: ProtectedTemplateView['source']; approval?: ProtectedTemplateView['approval']; latestRun?: ProtectedRunSummary };
export type SeedreamEstimate = { endpoint: string; perLayerUsd: number; maxLayers: number; maxUsd: number; maxInr: number; fx: number; pricingVersion: string; note: string };
export type Preflight = { checks: ProtectedCheck[]; ok: boolean; estimate?: SeedreamEstimate };
/** What the region editor sends: everything but the server-owned fields (normalized, sourceAsset, raster). */
export type ElementDraft = Omit<ProtectedElement, 'normalized' | 'sourceAsset' | 'raster'> & Partial<Pick<ProtectedElement, 'normalized' | 'sourceAsset' | 'raster'>>;

export const protectedApi = {
  list: () => call<{ templates: ProtectedListItem[] }>(''),
  get: (id: string) => call<ProtectedTemplateView>(`/${encodeURIComponent(id)}`),
  create: (file: File | Blob, name: string, origin?: ProtectedSourceOrigin) => call<ProtectedTemplateView>('', upload(file, { ...(name.trim() ? { name } : {}), ...(origin ? { origin: JSON.stringify(origin) } : {}) })),
  fromRun: (runId: string, name?: string) => call<ProtectedTemplateView>('/from-run', json('POST', { runId, ...(name ? { name } : {}) })),
  rename: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, change: { name?: string; layerInstructions?: string }) => call<ProtectedTemplateView>(`/${t.id}`, json('PATCH', { expectedRevision: t.revision, ...change })),
  setElements: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, elements: ElementDraft[]) =>
    call<ProtectedTemplateView>(`/${t.id}/elements`, json('PUT', { expectedRevision: t.revision, elements: elements.map(({ normalized: _n, sourceAsset: _s, raster: _r, ...rest }) => { void _n; void _s; void _r; return rest; }) })),
  attachAsset: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, elementId: string, file: File) => call<ProtectedTemplateView>(`/${t.id}/elements/${elementId}/asset`, upload(file, { expectedRevision: String(t.revision) })),
  confirmRegions: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>) => call<ProtectedTemplateView>(`/${t.id}/confirm-regions`, json('POST', { expectedRevision: t.revision })),
  uploadBase: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, file: File | Blob, method: 'clean-upload' | 'structured-scene' = 'clean-upload') => call<ProtectedTemplateView>(`/${t.id}/base`, upload(file, { expectedRevision: String(t.revision), method })),
  localFill: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>) => call<ProtectedTemplateView>(`/${t.id}/base/local-fill`, json('POST', { expectedRevision: t.revision })),
  approveBase: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, acknowledgeUncertain: boolean) => call<ProtectedTemplateView>(`/${t.id}/base/approve`, json('POST', { expectedRevision: t.revision, acknowledgeUncertain })),
  preflight: (id: string) => call<Preflight>(`/${id}/preflight`),
  /** The paid step: one Seedream request. The key makes a repeated click return the same run. */
  decompose: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, idempotencyKey: string, confirmRepeat = false) =>
    call<{ run: ExperimentRun; existing: boolean; template: ProtectedTemplateView }>(`/${t.id}/decompose`, json('POST', { expectedRevision: t.revision, idempotencyKey, ...(confirmRepeat ? { confirmRepeat: true } : {}) })),
  /** Reads a stopped run's saved Seedream request: no new paid request. */
  resume: (id: string, runId: string) => call<{ run: ExperimentRun }>(`/${id}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }),
  reconstruct: (id: string, runId: string) => call<ProtectedReconstruction>(`/${id}/runs/${encodeURIComponent(runId)}/reconstruct`, { method: 'POST' }),
  approve: (t: Pick<ProtectedTemplateView, 'id' | 'revision'>, runId: string, acknowledge: string[]) => call<ProtectedTemplateView>(`/${t.id}/approve`, json('POST', { expectedRevision: t.revision, runId, acknowledge })),
};

export const newKey = () => `pt-${crypto.randomUUID().replace(/-/g, '')}`;
/** A new element id in the server's format, unique for the template's life. */
export const newElementId = () => `pe-${Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('')}`;
export const STATUS_LABELS: Record<ProtectedStatus, string> = { annotating: 'Mark protected content', 'preparing-base': 'Prepare the base', ready: 'Ready to decompose', decomposing: 'Decomposing…',
  interrupted: 'Interrupted', failed: 'Decomposition failed', review: 'Review the result', approved: 'Approved template' };
export const sizeOf = (t: { source: SourceSize }) => ({ width: t.source.width, height: t.source.height });

// --- Words and logo slots (local recognizer on the server; nothing paid) ---------------------------------------------
type Revisioned = Pick<ProtectedTemplateView, 'id' | 'revision'>;
export const wordsApi = {
  /** Reads the words and logos of the confirmed regions on the server, with its local recognizer. Free. */
  analyse: (t: Revisioned) => call<ProtectedTemplateView>(`/${t.id}/text-analysis`, json('POST', { expectedRevision: t.revision })),
  /** The administrator's corrections: the whole list of words, phrases and logo slots. */
  correct: (t: Revisioned, a: Pick<TextAnalysis, 'revision' | 'words' | 'groups' | 'logoSlots'>) =>
    call<ProtectedTemplateView>(`/${t.id}/text-analysis`, json('PUT', { expectedRevision: t.revision, expectedAnalysisRevision: a.revision, words: a.words, groups: a.groups, logoSlots: a.logoSlots })),
  replaceLogo: (t: Revisioned, slotId: string, file: File) => call<ProtectedTemplateView>(`/${t.id}/text-analysis/logos/${slotId}/asset`, upload(file, { expectedRevision: String(t.revision) })),
  restoreLogo: (t: Revisioned, slotId: string) => call<ProtectedTemplateView>(`/${t.id}/text-analysis/logos/${slotId}/asset`, json('DELETE', { expectedRevision: t.revision })),
};
const hex10 = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('');
export const newWordId = () => `pw-${hex10()}`, newGroupId = () => `pg-${hex10()}`, newLineId = () => `pn-${hex10()}`, newLogoSlotId = () => `pl-${hex10()}`;
