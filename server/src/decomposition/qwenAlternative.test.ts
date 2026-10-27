import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { ProviderError } from './providers/adapters.js';
import { createRun, readRun, saveRunRecord, type RunRecord } from './layerizeExperiment.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import type { Planner } from './layerizePlanner.js';
import { readRunDiagnostics } from './runDiagnostics.js';
import { createQwenRun, executeQwenRun, qwenRequestFor } from './qwenAlternative.js';

const W = 900, H = 1200;
type Box = { x: number; y: number; width: number; height: number };
const boat: Box = { x: 450, y: 700, width: 360, height: 400 };
const inside = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
const raw = (pixel: (x: number, y: number) => [number, number, number, number]) => {
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(pixel(x, y), (y * W + x) * 4);
  return sharp(data, { raw: { width: W, height: H, channels: 4 } });
};
const sceneAt = (x: number, y: number): [number, number, number, number] => [180 + Math.round(60 * x / W), 230, 200 + Math.round(40 * y / H), 255];
/** Qwen's working size for 900×1200: about 640² at the input's ratio, sides of 32. */
const AT = { width: 544, height: 736 };

/** A poster (a mint field, an orange boat), and Qwen's answer for it as it really comes: each layer stretched to its working size. */
async function poster() {
  const source = await raw((x, y) => inside(boat, x, y) ? [240, 110, 60, 255] : sceneAt(x, y)).removeAlpha().png().toBuffer();
  const stretch = async (image: ReturnType<typeof raw>) => sharp(await image.png().toBuffer()).resize(AT.width, AT.height, { fit: 'fill' }).png().toBuffer();
  return { source, layers: [await stretch(raw(sceneAt)), await stretch(raw((x, y) => inside(boat, x, y) ? [240, 110, 60, 255] : [0, 0, 0, 2]))] };
}
function qwenTransport(layers: Buffer[], options: { reject?: boolean } = {}) {
  const url = (k: number) => `https://v3b.fal.media/files/t/qwen-${k}.png`;
  return {
    upload: vi.fn(async () => 'https://v3b.fal.media/files/t/input.png'),
    submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'qwen-req-1' })),
    status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async () => {
      if (options.reject) throw Object.assign(new ProviderError('PROVIDER_REJECTED', 'rejected', false, 422), { providerDetail: { status: 422, billableUnits: '0', requestId: 'qwen-req-1', messages: [{ msg: 'Qwen could not process the image.', type: 'invalid_request' }] } });
      return { images: layers.map((_, k) => ({ url: url(k), width: AT.width, height: AT.height, content_type: 'image/png' })), seed: 7, has_nsfw_concepts: layers.map(() => false) };
    }),
    cancel: vi.fn(),
    download: vi.fn(async (u: string) => layers[Number(/qwen-(\d+)\.png$/.exec(u)![1])]),
  } satisfies FalTransport;
}
/** A run Seedream's partner check refused, as the real one is saved (2026-10-19, request 01a1539b…), with its planner analysis. */
async function refusedRun(runsDir: string, image: Buffer, patch: Partial<RunRecord> = {}) {
  const { dir } = await createRun(runsDir, image);
  const run = readRun(dir);
  Object.assign(run, {
    stage: 'failed', seedream: { endpoint: 'bytedance/seedream/v5/pro/layerize', requestId: 'seedream-req-1' },
    error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', message: 'fal HTTP 422: flagged by a content checker.', stage: 'in_progress',
      provider: { code: 'PROVIDER_REJECTED', status: 422, billableUnits: '0', requestId: 'seedream-req-1', messages: [{ msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation', loc: 'body.image_url', reason: 'partner_validation_failed' }] } },
    rejection: { category: 'partner-content', status: 422, loc: 'body.image_url', type: 'content_policy_violation', reason: 'partner_validation_failed', billableUnits: '0', endpoint: 'bytedance/seedream/v5/pro/layerize', message: 'flagged' },
    planner: { model: 'gpt-5.6-sol', durationMs: 1, prompt: 'Rebuild this poster as 3 layers.', planned_layers: [], warnings: [], semantic_analysis: { elements: [
      { id: 'white_canvas', type: 'background', approximate_region: 'Full canvas, normalized x 0–1, y 0–1.' },
      { id: 'pine_labs_logo', type: 'logo', approximate_region: 'Upper right white margin, approximately x 0.74–0.95, y 0.039–0.073.' },
      { id: 'festive_boat', type: 'foreground_illustration', approximate_region: `Lower right, approximately x ${boat.x / W}–${(boat.x + boat.width) / W}, y ${boat.y / H}–${(boat.y + boat.height) / H}.` },
    ] } },
    ...patch,
  });
  saveRunRecord(dir, run);
  return { dir, run };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('Qwen layers for a direct run Seedream refused (offline: fal faked)', () => {
  it('asks Qwen with category words only (never brands or text) and names layers from the refused run\'s analysis', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'qwen-alt-'));
    const { run } = await refusedRun(runsDir, (await poster()).source);
    const ask = qwenRequestFor(run, W, H);
    expect(ask.caption).toBe('An advertising image: logo, foreground illustration, in front of a background.');
    expect(ask.caption).not.toMatch(/pine|labs/i);
    expect(ask.numLayers).toBe(4);
    expect(ask.labels.map(l => l.label)).toEqual(['pine labs logo', 'festive boat']);
    expect(ask.labels[1].box).toMatchObject({ x: expect.closeTo(boat.x, 0), y: expect.closeTo(boat.y, 0), width: expect.closeTo(boat.width, 0), height: expect.closeTo(boat.height, 0) });
    // Without an analysis: a plain caption and Qwen's default of four layers.
    expect(qwenRequestFor({ ...run, planner: undefined }, W, H)).toEqual({ caption: 'An advertising image: its objects in front of a background.', numLayers: 4, labels: [] });
  });

  it('only for a refused run, never a template execution\'s; creating it sends nothing and keeps the exact image', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'qwen-alt-')), { source } = await poster();
    const { dir: done } = await refusedRun(runsDir, source, { stage: 'done', error: undefined });
    await expect(createQwenRun(runsDir, done)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    const { dir: other } = await refusedRun(runsDir, source, { error: { code: 'PLANNER_FAILED', message: 'x', stage: 'planning' } });
    await expect(createQwenRun(runsDir, other)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    const { dir: execution } = await refusedRun(runsDir, source, { templateExecution: { executionId: 'e1', mode: 'REUSE_TEMPLATE_ORIGINAL' } as RunRecord['templateExecution'] });
    await expect(createQwenRun(runsDir, execution)).rejects.toThrow(/template execution/);
    const { dir, run: refused } = await refusedRun(runsDir, source);
    const { dir: created, run } = await createQwenRun(runsDir, dir);
    expect(run).toMatchObject({ stage: 'uploaded', alternative: { provider: 'qwen', endpoint: 'fal-ai/qwen-image-layered', fromRunId: refused.id, numLayers: 4 } });
    expect(run.alternative).not.toHaveProperty('requestId');
    expect(sha(readFileSync(join(created, 'original.png')))).toBe(sha(source));
  });

  it('one Qwen request, real editor layers with a reconstruction; the refused run is untouched and the request is never sent twice', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'qwen-alt-')), { source, layers } = await poster();
    const { dir: refusedDir } = await refusedRun(runsDir, source), before = readFileSync(join(refusedDir, 'run.json'), 'utf8');
    const { dir } = await createQwenRun(runsDir, refusedDir), transport = qwenTransport(layers);
    const run = await executeQwenRun(dir, { transport: () => transport, sleep: async () => undefined });
    expect(run.error).toBeUndefined();
    expect(run).toMatchObject({ stage: 'done', canvas: { width: W, height: H }, composed: { source: 'qwen-layers', extraction: 'qwen' }, alternative: { requestId: 'qwen-req-1', returned: 2, seed: 7 } });
    expect(run.layers!.map(l => l.name)).toEqual([expect.stringMatching(/^Background \(Qwen; /), 'festive boat']);
    expect(run.editorLayerFiles).toEqual(run.layers!.map(l => l.file));
    expect(run.warnings).toEqual([expect.stringMatching(/^LAYERS_QWEN: .*after Seedream refused the image.*AI-generated\.$/)]);
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.submit.mock.calls[0][0]).toBe('fal-ai/qwen-image-layered');
    expect(transport.submit.mock.calls[0][1]).toMatchObject({ prompt: 'An advertising image: logo, foreground illustration, in front of a background.', num_layers: 4, enable_safety_checker: true });
    for (const file of ['reconstructed.png', 'qwen-layers.json', 'qwen-request.json', 'qwen-response.json', ...run.layers!.map(l => l.file)]) expect(existsSync(join(dir, file)), file).toBe(true);
    // The editor layers rebuild the poster from its own pixels.
    const rebuilt = await sharp(join(dir, 'reconstructed.png')).removeAlpha().raw().toBuffer(), original = await sharp(source).raw().toBuffer();
    let diff = 0; for (let i = 0; i < original.length; i++) diff += Math.abs(rebuilt[i] - original[i]);
    expect(diff / original.length).toBeLessThan(2);
    expect(readFileSync(join(refusedDir, 'run.json'), 'utf8')).toBe(before);
    await expect(executeQwenRun(dir, { transport: () => transport })).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    // Its cost: the one Qwen request at fal's listed price, labelled an estimate; nothing from the refused run.
    const d = await readRunDiagnostics(dir);
    expect(d.stages.find(s => s.id === 'alternative')).toMatchObject({ status: 'Complete', calls: [{ kind: 'qwen', requestId: 'qwen-req-1' }], cost: { usd: 0.05, confidence: 'Estimated' } });
    expect(d.stages.filter(s => s.id !== 'alternative').every(s => !s.calls.length)).toBe(true);
    expect(d).toMatchObject({ calls: 1, rawLayers: 2, editorLayers: 2, total: { usd: 0.05 } });
  });

  it('a refused Qwen request is recorded (billed 0), never retried, and leaves the refused Seedream run as it was', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'qwen-alt-')), { source, layers } = await poster();
    const { dir: refusedDir } = await refusedRun(runsDir, source);
    const { dir } = await createQwenRun(runsDir, refusedDir), transport = qwenTransport(layers, { reject: true });
    const run = await executeQwenRun(dir, { transport: () => transport, sleep: async () => undefined });
    expect(run).toMatchObject({ stage: 'failed', error: { code: 'QWEN_LAYERS_FAILED', stage: 'in_progress', message: expect.stringMatching(/HTTP 422.*Qwen could not process the image\..*nothing was retried\.$/) } });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(readRun(refusedDir).stage).toBe('failed');
    const d = await readRunDiagnostics(dir);
    expect(d.stages.find(s => s.id === 'alternative')).toMatchObject({ status: 'Failed', cost: { usd: 0 } });
  });

  it('POST /runs/:id/qwen starts it in the background, like a retry, and refuses a run Seedream did not refuse', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'qwen-alt-')), { source, layers } = await poster(), transport = qwenTransport(layers);
    const { dir: refusedDir, run: refused } = await refusedRun(runsDir, source);
    const { run: ok } = await refusedRun(runsDir, source, { stage: 'done', error: undefined });
    const deps = () => ({ planner: vi.fn<Planner>(), transport: () => transport, sleep: async () => undefined });
    const server = express().use('/x', createLayerizeRouter({ runsDir, deps })).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    try {
      const { port } = server.address() as AddressInfo, base = `http://127.0.0.1:${port}/x/runs`;
      const refusedAnswer = await fetch(`${base}/${ok.id}/qwen`, { method: 'POST' });
      expect(refusedAnswer.status).toBe(409);
      const started = await fetch(`${base}/${refused.id}/qwen`, { method: 'POST' });
      expect(started.status).toBe(202);
      const created = await started.json() as RunRecord;
      expect(created).toMatchObject({ stage: 'uploaded', alternative: { fromRunId: refused.id } });
      let run = created;
      for (let i = 0; i < 100 && !['done', 'failed'].includes(run.stage); i++) { await new Promise(done => setTimeout(done, 50)); run = await (await fetch(`${base}/${created.id}`)).json() as RunRecord; }
      expect(run.stage).toBe('done');
      expect(transport.submit).toHaveBeenCalledTimes(1);
      expect(readRun(refusedDir).stage).toBe('failed');
    } finally { server.close(); }
  });
});
