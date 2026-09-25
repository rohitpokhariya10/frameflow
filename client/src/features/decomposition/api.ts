import type { DecompositionCapabilities, DecompositionClientContext, DecompositionJobSummary, DecompositionManifest, DecompositionOptions, DecompositionReview } from '@frameflow/shared';

const base = '/api/decomposition';
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, { credentials: 'same-origin', ...init });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `Request failed (${response.status}).`);
  return value as T;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FrameFlow-CSRF': '1' }, body: JSON.stringify(body) });
export const decompositionApi = {
  capabilities: () => request<DecompositionCapabilities>('/capabilities'),
  login: (password: string) => request('/session', json({ password })),
  logout: () => request('/logout', json({})),
  upload: async (blob: Blob) => { const form = new FormData(); form.append('image', blob, 'source'); return request<{ id: string }>('/assets', { method: 'POST', headers: { 'X-FrameFlow-CSRF': '1' }, body: form }); },
  create: (sourceId: string, options: DecompositionOptions, context: DecompositionClientContext, key: string) => request<DecompositionJobSummary>('/jobs', { ...json({ sourceId, options, context }), headers: { 'Content-Type': 'application/json', 'X-FrameFlow-CSRF': '1', 'Idempotency-Key': key } }),
  job: (id: string) => request<DecompositionJobSummary>(`/jobs/${encodeURIComponent(id)}`),
  jobs: async () => (await request<{ jobs: DecompositionJobSummary[] }>('/jobs')).jobs,
  review: (id: string, body: DecompositionReview) => request<DecompositionJobSummary>(`/jobs/${encodeURIComponent(id)}/review`, json(body)),
  cancel: (id: string) => request<DecompositionJobSummary>(`/jobs/${encodeURIComponent(id)}/cancel`, json({})),
  retry: (id: string, expectedRevision: number) => request<DecompositionJobSummary>(`/jobs/${encodeURIComponent(id)}/retry`, json({ expectedRevision })),
  remove: (id: string) => request(`/jobs/${encodeURIComponent(id)}/delete`, json({})),
  result: (id: string) => request<DecompositionManifest>(`/jobs/${encodeURIComponent(id)}/result`),
};
export const artifactUrl = (id: string) => `${base}/artifacts/${encodeURIComponent(id)}`;
export const downloadUrl = (id: string) => `${base}/jobs/${encodeURIComponent(id)}/download`;

const recoveryKey = 'frameflow:decomposition-jobs:v1';
export function rememberJob(projectId: string, jobId: string) {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recoveryKey) || '{}');
    const index = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string[]> : {};
    index[projectId] = [...new Set([jobId, ...(Array.isArray(index[projectId]) ? index[projectId] : [])])].slice(0, 30);
    localStorage.setItem(recoveryKey, JSON.stringify(Object.fromEntries(Object.entries(index).slice(-20))));
    return true;
  } catch { return false; }
}
