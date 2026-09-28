import { CANVAS_LIMITS, validateCanvasSize, type DesignLayer, type DesignVariant } from '@frameflow/shared';

/** Mirrors the server's run.json for the OpenAI → Seedream layerize experiment (server/src/decomposition/layerizeExperiment.ts). */
export type Placement = { kind: 'base' | 'full-canvas' | 'bbox-crop' | 'bbox-scaled' | 'unresolved'; x: number; y: number; width: number; height: number; reason?: string };
export type ExperimentLayer = { index: number; file: string; zIndex: number; name?: string; description?: string; pixelWidth: number; pixelHeight: number; opaquePercent: number; placement: Placement };
export type ExperimentRun = {
  id: string; stage: string; active?: boolean; createdAt: string;
  error?: { code: string; message: string; stage: string };
  original: { file: string; width: number; height: number };
  input: { file: string; width: number; height: number; orientationNormalized: boolean };
  planner?: { model: string; responseId?: string; usage?: Record<string, number | undefined>; durationMs: number; prompt: string; planned_layers: { name: string; description: string }[]; warnings: string[] };
  seedream: { endpoint: string; requestId?: string; status?: string };
  timings: Record<string, number>;
  canvas?: { width: number; height: number }; layers?: ExperimentLayer[]; warnings: string[];
};

const BASE = '/api/layerize-experiment';
export const experimentFileUrl = (runId: string, file: string) => `${BASE}/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file)}`;
export const experimentZipUrl = (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/outputs.zip`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 && !body?.error ? 'The experiment API is off. Start the server with LAYERIZE_EXPERIMENT=1.' : body?.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}
export const experimentApi = {
  list: () => call<{ active: string | null; runs: ExperimentRun[] }>('/runs'),
  get: (id: string) => call<ExperimentRun>(`/runs/${encodeURIComponent(id)}`),
  start: (file: File) => { const form = new FormData(); form.append('image', file); return call<ExperimentRun>('/runs', { method: 'POST', body: form }); },
  resume: (id: string, requestId?: string) => call<ExperimentRun>(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestId ? { requestId } : {}) }),
};

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };

/**
 * A completed run as a new editor version on a transparent canvas: the generated base at the bottom, then each returned
 * layer back-to-front at its resolved placement. Unresolved layers are added hidden at their natural size and marked,
 * never stretched. Coordinates are scaled uniformly only if the base exceeds the editor canvas limit. Assets are stored
 * first; on failure they are removed and nothing is added.
 */
export async function experimentToVariant(run: Pick<ExperimentRun, 'id' | 'canvas' | 'layers'>, fetchFile: (file: string) => Promise<Blob>, assets: Assets, newId: () => string = () => crypto.randomUUID()): Promise<DesignVariant> {
  if (!run.canvas || !run.layers?.length) throw new Error('This run has no layers yet.');
  const scale = Math.min(1, CANVAS_LIMITS.maxSide / run.canvas.width, CANVAS_LIMITS.maxSide / run.canvas.height, Math.sqrt(CANVAS_LIMITS.maxArea / (run.canvas.width * run.canvas.height)));
  const width = Math.floor(run.canvas.width * scale), height = Math.floor(run.canvas.height * scale);
  if (!validateCanvasSize(width, height).valid) throw new Error(`The base (${run.canvas.width} × ${run.canvas.height}) does not fit the editor canvas limits.`);
  const stored: string[] = [];
  try {
    const layers: DesignLayer[] = [];
    for (const layer of [...run.layers].sort((a, b) => a.zIndex - b.zIndex)) {
      const assetId = `layerize-${newId()}`;
      await assets.putAsset(assetId, await fetchFile(layer.file));
      stored.push(assetId);
      const p = layer.placement, unresolved = p.kind === 'unresolved';
      // Unresolved: natural size, shrunk to fit the canvas if needed, at the top-left and hidden.
      const k = unresolved ? Math.min(1, run.canvas.width / p.width, run.canvas.height / p.height) : 1;
      const label = p.kind === 'base' ? 'Generated base' : layer.name || 'Layer';
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId, name: `${unresolved ? '⚠ unplaced: ' : ''}${label} (z${layer.zIndex})`.slice(0, 200),
        x: p.x * scale, y: p.y * scale, width: Math.max(1, p.width * k * scale), height: Math.max(1, p.height * k * scale), rotation: 0, opacity: 1, visible: !unresolved, locked: false });
    }
    return { id: `layerize-${newId()}`, name: `OpenAI + Seedream ${run.id.slice(0, 16)}`, revision: 0, canvas: { width, height, backgroundColor: '#FFFFFF', transparent: true }, elements: [], layers };
  } catch (error) {
    await Promise.all(stored.map(id => assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The run could not be imported.');
  }
}
