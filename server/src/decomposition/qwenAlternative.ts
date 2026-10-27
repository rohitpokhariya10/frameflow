/**
 * Qwen-Image-Layered for a direct run Seedream refused (Decompose/Test and Template Studio runs): the alternative a person
 * chooses on the refused run's dashboard, never automatic. One fal request (listed $0.05), sent once and never retried.
 * Its layers are placed on the image's own canvas by creativeTemplates/qwenLayers.ts: what is visible is the image's own
 * pixels, and only what was hidden behind objects is AI-generated.
 *
 * The refused run stays as it is. The layers become a new run (composed: qwen-layers; alternative: the request), so the
 * dashboard, Saved Runs and the editor import read it like any other. A template execution's run is not handled here:
 * its execution offers the same choice and keeps its own record (creativeTemplates/service.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { isProtectedRun, readRun, RunError, saveRunRecord, SEEDREAM_ENDPOINT, type RunnerDeps, type RunRecord, type Stage } from './layerizeExperiment.js';
import { writeComposedLayers } from './creativeTemplates/composedRun.js';
import { QWEN_ENDPOINT, qwenEditorLayers, requestQwenLayers, type QwenLayerLabel } from './creativeTemplates/qwenLayers.js';
import type { SemanticElement } from './semanticPlanner.js';

/** "x 0.15–0.43, y 0.18–0.275" in a planner element's approximate_region: its box as fractions of the canvas. */
const REGION = /x\s*(\d*\.?\d+)\s*[–-]\s*(\d*\.?\d+)\s*,?\s*y\s*(\d*\.?\d+)\s*[–-]\s*(\d*\.?\d+)/i;
const BACKGROUND = /background|canvas|backdrop/i;

/**
 * What the Qwen request is told about the refused image, from that run's own analysis when it has one: the kinds of
 * elements in front of the background (category words, never brands or text), a layer count for them plus the
 * background, and their regions to name the layers by. Without an analysis, a plain caption and Qwen's default of four.
 */
export function qwenRequestFor(run: RunRecord, width: number, height: number): { caption: string; numLayers: number; labels: QwenLayerLabel[] } {
  const analysis = run.planner?.semantic_analysis ?? (run.promptSource && run.promptSource.mode !== 'generated' && run.promptSource.mode !== 'protected' ? run.promptSource.semantic_analysis : undefined);
  const objects = (analysis?.elements ?? []).filter((e: SemanticElement) => !BACKGROUND.test(e.type));
  const counts = new Map<string, number>();
  for (const o of objects) { const kind = o.type.replace(/_/g, ' ').trim(); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const kinds = [...counts].map(([kind, n]) => n > 1 ? `${kind} (×${n})` : kind);
  const labels: QwenLayerLabel[] = [];
  for (const o of objects) {
    const m = REGION.exec(o.approximate_region), v = m?.slice(1).map(Number);
    if (!v || v.some(x => !Number.isFinite(x) || x < 0 || x > 1) || v[1] <= v[0] || v[3] <= v[2]) continue;
    labels.push({ label: o.id.replace(/_/g, ' '), box: { x: v[0] * width, y: v[2] * height, width: (v[1] - v[0]) * width, height: (v[3] - v[2]) * height } });
  }
  return { caption: kinds.length ? `An advertising image: ${kinds.join(', ')}, in front of a background.` : 'An advertising image: its objects in front of a background.',
    numLayers: Math.min(6, Math.max(4, objects.length + 1)), labels };
}

/**
 * A new run for Qwen's layers of the image a Seedream run was refused for. Nothing is sent here; executeQwenRun sends
 * the one request. Only a run Seedream refused qualifies, and never a template execution's run.
 */
export async function createQwenRun(runsDir: string, failedDir: string): Promise<{ dir: string; run: RunRecord }> {
  const failed = readRun(failedDir);
  // A protected template's run is Seedream-only by definition: no other model is ever offered for it.
  if (isProtectedRun(failed)) throw new RunError('NOT_RETRYABLE', 'A protected template is decomposed with Seedream only; no alternative model is used for it.');
  if (failed.templateExecution) throw new RunError('NOT_RETRYABLE', 'This run belongs to a saved template execution: choose Qwen layers from that execution (Saved Runs), which keeps its own record.');
  if (failed.stage !== 'failed' || failed.error?.code !== 'PROVIDER_DECOMPOSITION_REJECTED') throw new RunError('NOT_RETRYABLE', 'Qwen layers are an alternative only for an image Seedream refused (PROVIDER_DECOMPOSITION_REJECTED).');
  // The exact image Seedream was sent, byte for byte when it is a PNG (a Template Studio poster's link checks its hash).
  const sent = readFileSync(join(failedDir, failed.input.file)), meta = await sharp(sent).metadata();
  const image = meta.format === 'png' ? sent : await sharp(sent).png().toBuffer(), width = meta.width!, height = meta.height!;
  const ask = qwenRequestFor(failed, width, height), now = new Date().toISOString();
  const id = `${now.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`, dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'original.png'), image);
  const run: RunRecord = { id, createdAt: now, updatedAt: now, stage: 'uploaded', ...(failed.origin ? { origin: failed.origin } : {}),
    original: { file: 'original.png', mime: 'image/png', width, height, bytes: image.length },
    input: { file: 'original.png', mime: 'image/png', width, height, orientationNormalized: false },
    // Never submitted to Seedream: no request id, no Seedream call.
    seedream: { endpoint: SEEDREAM_ENDPOINT }, timings: {}, warnings: [],
    alternative: { provider: 'qwen', endpoint: QWEN_ENDPOINT, fromRunId: failed.id, caption: ask.caption, numLayers: ask.numLayers, labels: ask.labels } };
  saveRunRecord(dir, run);
  return { dir, run };
}

/** Sends the run's one Qwen request and turns its layers into editor layers. A failure is recorded, never retried. */
export async function executeQwenRun(dir: string, deps: Pick<RunnerDeps, 'transport' | 'sleep' | 'onUpdate'>): Promise<RunRecord> {
  const run = readRun(dir), alternative = run.alternative;
  if (!alternative || run.stage !== 'uploaded') throw new RunError('NOT_RETRYABLE', 'This Qwen run was already sent; it is never sent twice.');
  const started = Date.now(), image = readFileSync(join(dir, run.input.file)), canvas = { width: run.input.width, height: run.input.height };
  const at = (stage: Stage) => { run.stage = stage; saveRunRecord(dir, run); deps.onUpdate?.(run); };
  at('submitting');
  try {
    const qwen = await requestQwenLayers(deps.transport(), image, { caption: alternative.caption, numLayers: alternative.numLayers, sleep: deps.sleep,
      save: (file, value) => writeFileSync(join(dir, `qwen-${file}`), JSON.stringify(value, null, 2)),
      onSubmitted: requestId => { alternative.requestId = requestId; alternative.submittedAt = new Date().toISOString(); at('in_progress'); } });
    Object.assign(alternative, { completedAt: new Date().toISOString(), returned: qwen.images.length, ...(qwen.seed !== undefined ? { seed: qwen.seed } : {}) });
    at('downloading');
    qwen.images.forEach((layer, i) => writeFileSync(join(dir, `qwen-layer-${i}.png`), layer));
    const { layers, report } = await qwenEditorLayers(image, qwen.images, { labels: alternative.labels });
    const written = await writeComposedLayers(dir, layers, canvas);
    writeFileSync(join(dir, 'qwen-layers.json'), JSON.stringify({ endpoint: QWEN_ENDPOINT, requestId: qwen.requestId, seed: qwen.seed, caption: alternative.caption, numLayers: alternative.numLayers, ...report }, null, 2));
    Object.assign(run, { canvas, ...written, editorLayerFiles: written.layers.map(l => l.file), composed: { source: 'qwen-layers', layers: written.layers.map(l => l.file), extraction: 'qwen' } });
    run.warnings.push(`LAYERS_QWEN: extracted with the alternative provider (Qwen-Image-Layered) after Seedream refused the image (run ${alternative.fromRunId}). The model chose how objects are grouped; what is visible is the image's own pixels, and ${report.aiFilledBackgroundPercent}% of the background, hidden behind objects, is AI-generated.`);
    run.timings.totalMs = Date.now() - started;
    at('done');
  } catch (error) {
    run.error = { code: 'QWEN_LAYERS_FAILED', message: `${error instanceof Error ? error.message : String(error)} The image is kept; nothing was retried.`, stage: run.stage };
    run.timings.totalMs = Date.now() - started;
    at('failed');
  }
  return run;
}
