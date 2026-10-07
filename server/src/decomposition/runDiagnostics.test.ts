import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunDiagnostics } from './runDiagnostics.js';
const endpoint = 'bytedance/seedream/v5/pro/layerize';
let root: string, dir: string;
const write = (file: string, data: unknown, where = dir) => writeFileSync(join(where, file), JSON.stringify(data));
const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const layer = (i: number, pass = 0, size = 1000) => ({ file: `${pass ? `pass-${pass}-` : ''}layer-${String(i).padStart(2, '0')}.png`, name: i ? `Product ${i}` : 'Layer 0', pixelWidth: size, pixelHeight: size, placement: { kind: i ? 'full-canvas' : 'base' } });
const response = (count: number, width = 1000, height = 1000) => ({ layers: Array.from({ length: count }, (_, i) => ({ z_index: i, image: { url: `https://fixture.invalid/${i}`, width, height } })) });
function seed(n = 13) {
  write('seedream-response.json', response(n)); write('raw-layers.json', { layers: Array.from({ length: n }, (_, i) => layer(i)) });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frameflow-diagnostics-')); dir = join(root, 'run'); mkdirSync(dir);
  write('run.json', { id: 'run-fixture', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:02:00Z', stage: 'done',
    original: { file: 'original.png', width: 1000, height: 1000 }, input: { file: 'input.png', width: 1000, height: 1000 },
    seedream: { endpoint, requestId: 'saved-seedream-id' }, calls: { fitCheck: 0, planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 },
    planner: { model: 'gpt-5.6-sol', responseId: 'saved-planner-id', prompt: 'Plan', planned_layers: [], warnings: [] },
    finalPrompt: 'Extract phone', timings: { totalMs: 120000 }, outputLayers: [layer(0), layer(1)], editorLayerFiles: [layer(0).file, layer(1).file], warnings: [] });
  write('openai-response.json', { model: 'gpt-5.6-sol', usage: { input_tokens: 3376, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3373 }, output_tokens: 4835, output_tokens_details: { reasoning_tokens: 1552 } } });
  write('openai-request.json', { model: 'gpt-5.6-sol', instructions: 'Saved planner instructions' }); seed();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const stage = async (id: string) => (await readRunDiagnostics(dir)).stages.find(s => s.id === id)!;
describe('persisted run diagnostics', () => {
  it('uses 13 raw outputs despite only two editor selections', async () => {
    const d = await readRunDiagnostics(dir); expect(d.rawLayers).toBe(13); expect(d.editorLayers).toBe(2); expect(d.stages.find(s => s.id === 'seedream')?.cost.inr).toBeCloseTo(39.4875);
  });
  it('keeps exact saved model and cache-write tokens', async () => {
    const s = await stage('planner'); expect(s.calls[0]).toMatchObject({ model: 'gpt-5.6-sol', usage: { cacheWriteTokens: 3373, reasoningTokens: 1552 } }); expect(s.cost.inr).toBeCloseTo(10.22193);
  });
  it('is deterministic after reopening, with no file writes', async () => {
    const before = readFileSync(join(dir, 'run.json'), 'utf8'); expect(await readRunDiagnostics(dir)).toEqual(await readRunDiagnostics(dir)); expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe(before);
  });
  it('uses native residual base size, not resized raw canvas', async () => {
    const r = read('run.json'); r.calls.seedreamResidual = 1; r.refinement = { state: 'done', passes: [{ pass: 1, state: 'done', returnedLayers: 3 }], options: { maxDepth: 2 } }; write('run.json', r);
    write('pass-1-seedream-response.json', response(3, 2048, 2048)); write('pass-1-raw-layers.json', { canvas: { width: 1000, height: 1000 }, layers: [layer(0, 1, 2048), layer(1, 1, 2048), layer(2, 1, 2048)] });
    const d = await readRunDiagnostics(dir); expect(d.rawLayers).toBe(16); expect(d.stages.find(s => s.id === 'residual')?.cost.inr).toBeCloseTo(18.225);
  });
  it('failed provider output keeps known planner subtotal and unknown charge', async () => {
    const r = read('run.json'); r.stage = 'failed'; r.error = { stage: 'queued', code: 'PROVIDER_DECOMPOSITION_REJECTED' }; write('run.json', r);
    rmSync(join(dir, 'seedream-response.json')); rmSync(join(dir, 'raw-layers.json'));
    const d = await readRunDiagnostics(dir); expect(d.total).toMatchObject({ inr: null, confidence: 'Unknown' }); expect(d.total.knownInr).toBeCloseTo(10.22193); expect(d.editorLayers).toBe(0); expect(d.stages.find(s => s.id === 'seedream')?.status).toBe('Failed'); expect(d.stages.find(s => s.id === 'curation')?.status).toBe('Skipped');
  });
  it('explicit zero billable units permits zero cost for a rejected call', async () => {
    const r = read('run.json'); r.stage = 'failed'; r.error = { provider: { billableUnits: '0' } }; write('run.json', r); expect((await stage('seedream')).cost.inr).toBe(0);
  });
  it('legacy missing usage never becomes an exact zero', async () => {
    rmSync(join(dir, 'openai-response.json')); const s = await stage('planner'); expect(s.cost.confidence).toBe('Unknown'); expect(s.cost.inr).toBeNull();
  });
  it('preserves a changed model instead of pricing the default', async () => {
    write('openai-response.json', { model: 'unpriced-model', usage: { input_tokens: 10, output_tokens: 10 } }); expect((await stage('planner')).cost.confidence).toBe('Unknown');
  });
  it('reads linked generation, shared reference usage and prompts after refresh', async () => {
    const id = '2026-10-07T00-00-00-000Z-abcdef', source = join(root, id); mkdirSync(source);
    const r = read('run.json'); r.origin = { kind: 'image-template', generationId: id, variantId: '4x5' }; write('run.json', r);
    write('group.json', { promptGeneration: { status: 'done', model: 'gpt-5-mini', attempts: 1, durationMs: 1000, usage: { input_tokens: 2616, output_tokens: 1937 } }, variants: [{ id: '4x5', status: 'done', attempts: 1, durationMs: 2000, generator: { model: 'gpt-image-2' }, requestFile: '4x5.openai-request.json', responseFile: '4x5.openai-response.json' }] }, source);
    write('prompt.openai-response.json', { usage: { input_tokens: 2616, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1937 } }, source);
    write('4x5.openai-request.json', { model: 'gpt-image-2', prompt: 'Actual generation prompt' }, source);
    write('4x5.openai-response.json', { quality: 'medium', data: [{}], usage: { input_tokens: 1867, input_tokens_details: { image_tokens: 1178, text_tokens: 689 }, output_tokens: 1755 } }, source);
    const d = await readRunDiagnostics(dir, { imageTemplatesDir: root }); expect(d.total.inr).toBeCloseTo(56.01366); expect(d.calls).toBe(4); expect(d.elapsedMs).toBe(123000); expect(d.prompts.some(p => p.text === 'Actual generation prompt')).toBe(true); expect(d.notes.join(' ')).toContain('shared across variants');
  });
  it('does not treat overwritten generation attempts as free', async () => {
    const id = '2026-10-07T00-00-00-000Z-abcdef'; mkdirSync(join(root, id)); const r = read('run.json'); r.origin = { kind: 'template-a-generation', generationId: id, variantId: 'single' }; write('run.json', r);
    write('group.json', { variants: [{ id: 'single', status: 'done', attempts: 2, generator: { model: 'gpt-image-2' } }] }, join(root, id));
    const d = await readRunDiagnostics(dir, { generationDirs: { 'template-a': root } }); expect(d.stages.find(s => s.id === 'generation')?.calls).toHaveLength(2); expect(d.total.inr).toBeNull();
  });
  it('handles missing source directories and corrupt optional artifacts', async () => {
    const r = read('run.json'); r.origin = { kind: 'image-template', generationId: '../escape', variantId: '4x5' }; write('run.json', r); writeFileSync(join(dir, 'openai-response.json'), '{');
    const d = await readRunDiagnostics(dir, { imageTemplatesDir: root }); expect(d.total.confidence).toBe('Unknown');
  });
  it('uses configured FX and reports invalid fallback', async () => {
    expect((await readRunDiagnostics(dir, { fx: '80' })).fx).toBe(80); expect((await readRunDiagnostics(dir, { fx: 'bad' })).notes.join(' ')).toContain('Invalid AI_BUDGET_USD_INR');
  });
  it('skipped stages and local curation have zero cost', async () => { for (const id of ['reference', 'generation', 'residual', 'background', 'curation']) expect((await stage(id)).cost.inr).toBe(0); });
  it('does not expose raw candidates on invalid editor selection', async () => { const r = read('run.json'); r.editorLayerFiles = ['missing.png']; write('run.json', r); expect((await readRunDiagnostics(dir)).editorLayers).toBe(0); });
});

it('residual upload failure is a warning but does not invent a paid call', async () => {
  const r = read('run.json'); r.refinement = { state: 'done', passes: [{ pass: 1, state: 'failed', error: { code: 'FAL_UPLOAD_FAILED' } }], options: { maxDepth: 2 } }; write('run.json', r);
  expect(await stage('residual')).toMatchObject({ status: 'Warning', calls: [], cost: { inr: 0 } });
});
it('background edit usage survives a failed quality evaluation', async () => {
  const r = read('run.json'); r.calls.backgroundReconstruction = 1; r.refinement = { state: 'done', passes: [], reconstruction: { model: 'gpt-image-2', state: 'done' }, background: { method: 'local-fill', quality: 'degraded' } }; write('run.json', r);
  write('clean-background-response.json', { usage: { input_tokens: 1146, input_tokens_details: { image_tokens: 1024, text_tokens: 122 }, output_tokens: 196 } });
  expect(await stage('background')).toMatchObject({ status: 'Warning', cost: { confidence: 'Calculated' } }); expect((await stage('background')).cost.inr).toBeCloseTo(1.32138);
});
it('keeps failed background requests as unknown, even with a local fallback', async () => {
  const r = read('run.json'); r.calls.backgroundReconstruction = 1; r.refinement = { state: 'done', passes: [], reconstruction: { model: 'gpt-image-2', state: 'failed' }, background: { method: 'local-fill', quality: 'degraded' } }; write('run.json', r);
  expect((await stage('background')).cost).toMatchObject({ inr: null, confidence: 'Unknown' });
});
it('shows an active Seedream call as running with pending downstream stages', async () => {
  const r = read('run.json'); r.stage = 'in_progress'; write('run.json', r); rmSync(join(dir, 'seedream-response.json')); rmSync(join(dir, 'raw-layers.json'));
  expect(await stage('seedream')).toMatchObject({ status: 'Running', cost: { confidence: 'Unknown' } }); expect((await stage('curation')).status).toBe('Pending');
});
it('reads optional fit-check usage and preserves its model', async () => {
  const r = read('run.json'); r.calls.fitCheck = 1; r.templateFit = { fits: true, reason: 'Fits', model: 'gpt-5-mini' }; write('run.json', r);
  write('template-fit.json', { request: { model: 'gpt-5-mini' }, response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50 } } });
  expect((await stage('fit')).cost.inr).toBeCloseTo(.01125);
});
it('a newly analyzed reference is not incorrectly charged to an older generation', async () => {
  const id = '2026-10-07T00-00-00-000Z-abcdef'; mkdirSync(join(root, id)); const r = read('run.json'); r.origin = { kind: 'image-template', generationId: id, variantId: 'single' }; write('run.json', r);
  write('group.json', { promptGeneration: { model: 'gpt-5-mini', status: 'done', attempts: 2, finishedAt: '2026-10-07T02:00:00Z', usage: { input_tokens: 100, output_tokens: 100 } }, variants: [{ id: 'single', startedAt: '2026-10-07T01:00:00Z', status: 'done', attempts: 1 }] }, join(root, id));
  const d = await readRunDiagnostics(dir, { imageTemplatesDir: root }); expect(d.stages.find(s => s.id === 'reference')?.cost.confidence).toBe('Unknown'); expect(d.notes.join(' ')).toContain('analyzed again');
});
