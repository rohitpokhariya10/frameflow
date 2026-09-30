import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { createRun, executeRun, fitCheckEnabled, liveDeps, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { createOpenAIPlanner, PLANNER_INSTRUCTION } from './layerizePlanner.js';
import { PLANNER_INSTRUCTION_B } from './layerizeTemplateB.js';
import { PLANNER_INSTRUCTION_C } from './layerizeTemplateC.js';

afterEach(() => { vi.unstubAllGlobals(); });

const W = 800, H = 1200;
const png = () => sharp({ create: { width: W, height: H, channels: 3, background: '#2f6b2f' } }).png().toBuffer();
function falFake() {
  return { upload: vi.fn(async () => 'https://v3b.fal.media/files/t/in.png'), submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'r' })), status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async () => ({ layers: [{ image: { url: 'https://v3b.fal.media/files/t/b.png' }, z_index: 0 }] })), cancel: vi.fn(), download: vi.fn(async () => png()) } satisfies FalTransport;
}
/** What each template's planner answers (its own schema): Template A and B a layer list, Template C its facts. */
const ANSWERS: Record<string, unknown> = {
  'template-a': { prompt: 'Keep the main subject whole. Separate each held object into its own layer.', planned_layers: [], warnings: [] },
  'template-b': { prompt: 'Extract the lamp with its cord as one layer.', planned_layers: [], warnings: [], touching_group: null },
  'template-c': { prompt: 'draft', planned_layers: [], warnings: [], people: [{ id: 'p1', phrase: 'person on the left', includes: '', grouped_with: [] }], repeated_modules: null, elements: [] },
};
const INSTRUCTIONS: Record<string, string> = { 'template-a': PLANNER_INSTRUCTION, 'template-b': PLANNER_INSTRUCTION_B, 'template-c': PLANNER_INSTRUCTION_C };

describe('test harness: the selected template is trusted (no template fit check)', () => {
  it('leaves the fit check out of the live dependencies unless LAYERIZE_FIT_CHECK=1', () => {
    expect(fitCheckEnabled({})).toBe(false);
    expect(liveDeps({})).not.toHaveProperty('fitCheck');
    expect(fitCheckEnabled({ LAYERIZE_FIT_CHECK: '1' })).toBe(true);
    expect(liveDeps({ LAYERIZE_FIT_CHECK: '1' }).fitCheck).toEqual(expect.any(Function));
  });

  for (const templateKey of ['template-a', 'template-b', 'template-c']) {
    it(`${templateKey}: goes straight to its own planner (the only OpenAI call), then Seedream`, async () => {
      // Any real network call (an OpenAI fit check included) fails the test.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call'); }));
      const requests: { instructions: string }[] = [];
      const create = vi.fn(async (request: { instructions: string }) => { requests.push(request); return { status: 'completed', output: [], output_text: JSON.stringify(ANSWERS[templateKey]) }; });
      const transport = falFake();
      // The live dependencies as the experiment builds them, with a mocked OpenAI client and fake fal transport.
      const deps: RunnerDeps = { ...liveDeps({}), planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined };
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(), { mode: 'generated' }, { templateKey });
      const run = await executeRun(dir, deps);
      expect(run.stage).toBe('done');
      expect(create).toHaveBeenCalledTimes(1);
      expect(requests[0].instructions.startsWith(INSTRUCTIONS[templateKey])).toBe(true);
      expect(transport.submit).toHaveBeenCalledTimes(1);
      expect(transport.submit.mock.calls[0][1].prompt).toBe(run.finalPrompt);
      expect(readRun(dir)).not.toHaveProperty('templateFit');
    });
  }

  it('a planner failure still stops before Seedream, for every template', async () => {
    for (const templateKey of ['template-a', 'template-b', 'template-c']) {
      const create = vi.fn(async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
      const transport = falFake();
      const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'layerize-')), await png(), { mode: 'generated' }, { templateKey });
      const run = await executeRun(dir, { ...liveDeps({}), planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined });
      expect(run.error).toMatchObject({ code: 'PLANNER_REFUSED' });
      for (const call of [transport.upload, transport.submit]) expect(call).not.toHaveBeenCalled();
    }
  });

  it('reports the setting to the panel, and still serves older runs that carry a fit result', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'layerize-'));
    const old = '2026-09-29T08-48-55-723Z-47e823';
    mkdirSync(join(runsDir, old));
    const fit = { fits: false, bestTemplate: 'template-b', plausibleTemplates: ['template-b'], reason: 'A single product.', model: 'm', durationMs: 5 };
    writeFileSync(join(runsDir, old, 'run.json'), JSON.stringify({ id: old, stage: 'failed', templateKey: 'template-a', templateFit: fit, skipFitCheck: false, error: { code: 'TEMPLATE_NOT_SUITABLE', message: 'm', stage: 'planning' },
      original: { file: 'original.png' }, input: { file: 'original.png' }, seedream: {}, timings: { fitCheckMs: 5 }, warnings: [] }));
    const servers = [express().use('/x', createLayerizeRouter({ runsDir, deps: () => liveDeps({}) })).listen(0, '127.0.0.1'),
      express().use('/x', createLayerizeRouter({ runsDir, deps: () => liveDeps({ LAYERIZE_FIT_CHECK: '1' }) })).listen(0, '127.0.0.1')];
    try {
      await Promise.all(servers.map(s => new Promise(done => s.once('listening', done))));
      const [off, on] = servers.map(s => `http://127.0.0.1:${(s.address() as AddressInfo).port}/x`);
      expect((await (await fetch(`${off}/templates`)).json()).fitCheck).toBe(false);
      expect((await (await fetch(`${on}/templates`)).json()).fitCheck).toBe(true);
      expect(await (await fetch(`${off}/runs/${old}`)).json()).toMatchObject({ templateFit: fit, error: { code: 'TEMPLATE_NOT_SUITABLE' } });
    } finally { for (const s of servers) s.close(); }
  });
});
