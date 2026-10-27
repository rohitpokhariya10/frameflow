/** Browser side of Template Studio: requests to /api/template-studio, all of them the app's own server. */
import type { StudioJob } from '@frameflow/shared';

export const STUDIO_API = '/api/template-studio';

export class StudioRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly issues: { path: string; message: string }[] = []) { super(message); this.name = 'StudioRequestError'; }
}

async function handle<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; issues?: { path: string; message: string }[] } } | null;
  if (!response.ok) throw new StudioRequestError(body?.error?.message ?? `Request failed (${response.status}).`, response.status, body?.error?.code, body?.error?.issues ?? []);
  return body as T;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const studioApi = {
  get: async <T>(path: string) => handle<T>(await fetch(`${STUDIO_API}${path}`, { cache: 'no-store' })),
  post: async <T>(path: string, body?: unknown) => handle<T>(await fetch(`${STUDIO_API}${path}`, json('POST', body ?? {}))),
  patch: async <T>(path: string, body: unknown) => handle<T>(await fetch(`${STUDIO_API}${path}`, json('PATCH', body))),
  del: async <T>(path: string) => handle<T>(await fetch(`${STUDIO_API}${path}`, { method: 'DELETE' })),
  upload: async <T>(path: string, form: FormData) => handle<T>(await fetch(`${STUDIO_API}${path}`, { method: 'POST', body: form })),
};

/** One per submission: a double click or a retried request returns the same job instead of paying twice. */
export const newIdempotencyKey = () => crypto.randomUUID();

/** Upload one image into the studio's asset library. */
export async function uploadAsset<T>(file: File, role: string, label?: string) {
  const form = new FormData();
  form.set('file', file);
  form.set('role', role);
  form.set('label', label ?? file.name.replace(/\.[^.]+$/, ''));
  return studioApi.upload<T>('/assets', form);
}

export const getJob = (id: string) => studioApi.get<{ job: StudioJob }>(`/jobs/${id}`).then(r => r.job);
