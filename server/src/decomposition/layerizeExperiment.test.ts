import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { placeLayers } from './layerizeArtifacts.js';
import { createRun, executeRun, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner, PlannerError, type Planner } from './layerizePlanner.js';

const png = (width: number, height: number, alpha = 255) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha } } }).png().toBuffer();
const url = (name: string) => `https://v3b.fal.media/files/test/${name}.png`;

function fakeTransport(files: Record<string, Buffer>, raw: unknown) {
  return {
    upload: vi.fn(async () => url('input')), submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'req-123' })),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async () => raw), cancel: vi.fn(),
    download: vi.fn(async (u: string) => files[u]),
  } satisfies FalTransport;
}
const plan: Planner = async () => ({ plan: { prompt: 'Separate the woman from the phone she holds.', planned_layers: [{ name: 'Woman', description: 'left' }], warnings: [] }, model: 'test-model', raw: {}, request: {} });

describe('OpenAI → Seedream layerize experiment', () => {
  it('a planner refusal, incomplete or invalid output makes zero fal calls', async () => {
    const outputs = [
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      { status: 'completed', output: [], output_text: '{"prompt": ' },
      { status: 'completed', output: [], output_text: JSON.stringify({ prompt: 'x'.repeat(2001), planned_layers: [], warnings: [] }) },
    ];
    const codes = [];
    for (const response of outputs) {
      const planner = createOpenAIPlanner({ client: { responses: { create: async () => response } } as never });
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(800, 600));
      const transport = fakeTransport({}, {});
      const run = await executeRun(dir, { planner, transport: () => transport, sleep: async () => undefined });
      expect(run.stage).toBe('failed');
      codes.push(run.error!.code);
      for (const call of [transport.upload, transport.submit, transport.status, transport.result]) expect(call).not.toHaveBeenCalled();
    }
    expect(codes).toEqual(['PLANNER_REFUSED', 'PLANNER_INCOMPLETE', 'PLANNER_INVALID_JSON', 'PLANNER_PROMPT_TOO_LONG']);
    await expect(createOpenAIPlanner({})(Buffer.from(''), 'image/png')).rejects.toBeInstanceOf(PlannerError);
  });

  it('submits once, and recovery uses the saved request ID without resubmitting', async () => {
    const raw = { layers: [{ image: { url: url('base') }, z_index: 0 }, { image: { url: url('phone') }, z_index: 1, name: 'Phone', bounding_box: { absolute: [100, 50, 300, 250] } }] };
    const files = { [url('base')]: await png(800, 600), [url('phone')]: await png(200, 200) };
    const transport = fakeTransport(files, raw);
    transport.result.mockRejectedValueOnce(new Error('network down'));
    const deps: RunnerDeps = { planner: plan, transport: () => transport, sleep: async () => undefined };
    const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(800, 600));
    const failed = await executeRun(dir, deps);
    expect(failed).toMatchObject({ stage: 'failed', error: { code: 'FAL_RESULT_FAILED' }, seedream: { requestId: 'req-123' } });
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('Separate the woman from the phone she holds.');
    await expect(executeRun(dir, deps)).rejects.toThrow(/never submitted twice/);
    const done = await resumeRun(dir, deps);
    expect(done.stage).toBe('done');
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.result).toHaveBeenCalledTimes(2);
    expect(transport.result).toHaveBeenLastCalledWith('bytedance/seedream/v5/pro/layerize', 'req-123');
    expect(transport.submit.mock.calls[0][1]).toEqual({ image_url: url('input'), prompt: 'Separate the woman from the phone she holds.', image_size: 'auto', enhance_prompt_mode: 'standard', enable_safety_checker: true, sync_mode: false });
    // Re-render from the saved response and files: no lookups, no downloads.
    await resumeRun(dir, deps);
    expect(transport.result).toHaveBeenCalledTimes(2);
    expect(transport.download).toHaveBeenCalledTimes(2);
    for (const f of ['seedream-response.json', 'layer-00.png', 'layer-01.png', 'contact-sheet.png', 'reconstructed.png', 'layers.json']) expect(existsSync(join(dir, f))).toBe(true);
    expect(readRun(dir).layers!.map(l => l.placement.kind)).toEqual(['base', 'bbox-crop']);
  });

  it('places full-canvas, cropped and uniformly scaled layers on the base and flags the rest', () => {
    const { canvas, placements, warnings } = placeLayers([
      { width: 1000, height: 1500, meta: { zIndex: 0 } },
      { width: 1000, height: 1500, meta: { zIndex: 1, bboxAbsolute: [10, 10, 400, 400] } },
      { width: 300, height: 200, meta: { zIndex: 2, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 600, height: 400, meta: { zIndex: 3, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 600, height: 100, meta: { zIndex: 4, bboxAbsolute: [100, 200, 400, 400] } },
      { width: 50, height: 50, meta: { zIndex: 5 } },
    ]);
    expect(canvas).toEqual({ width: 1000, height: 1500 });
    expect(placements.map(p => p.kind)).toEqual(['base', 'full-canvas', 'bbox-crop', 'bbox-scaled', 'unresolved', 'unresolved']);
    expect(placements[2]).toMatchObject({ x: 100, y: 200, width: 300, height: 200 });
    expect(placements[3]).toMatchObject({ x: 100, y: 200, width: 300, height: 200 });
    // Unresolved layers keep their natural size and are never stretched into the box.
    expect(placements[4]).toMatchObject({ width: 600, height: 100 });
    expect(warnings.join()).toMatch(/UNRESOLVED_PLACEMENT: 2/);
  });
});
