import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExperimentLayer } from '../decomposition/layerizeExperiment';
import { generationBlockers, imageTemplateApi, importAsVersion, RESULT_STATUS_LABELS, resultStatus, templateInProgress, templateSummary, withRatio, withTemplate, type ImageTemplate, type ImageTemplateVariant } from './imageTemplates';

const PROMPT = 'A premium product advertisement: a lavender smartphone stands upright in the centre on a white platform.';
const image = { file: '1x1.image.png', mimeType: 'image/png', width: 1024, height: 1024, bytes: 10, sha256: 'abc' };
const variant = (over: Partial<ImageTemplateVariant> = {}): ImageTemplateVariant => ({ id: '1x1', aspectRatio: '1:1', size: { width: 1024, height: 1024 }, status: 'done', framing: '', prompt: PROMPT,
  generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 1, image, decompositions: [], ...over });
const run = (state: 'waiting' | 'running' | 'done' | 'failed', over = {}) => ({ runId: 'run-1', templateKey: 'template-b', createdAt: '2026-10-01T10:00:00.000Z', state, stage: state === 'done' ? 'done' : 'planning', ...over });
const template = (over: Partial<ImageTemplate> = {}): ImageTemplate => ({ id: 't1', kind: 'image-template', version: 'image-template-v1', createdAt: '', updatedAt: '', name: 'Lavender', prompt: PROMPT, promptEdited: false,
  reference: { file: 'reference.png', mimeType: 'image/png', width: 10, height: 10, bytes: 1 }, aspectRatios: ['1:1', '4:5'], variants: [], ...over });

describe('Create Template from Image: what each result shows', () => {
  it('7. follows a result from generating to ready in editor, and says which step failed', () => {
    const cases: [Partial<ImageTemplateVariant>, string, string | undefined][] = [
      [{ status: 'pending', image: undefined }, 'not-generated', undefined],
      [{ status: 'queued', image: undefined }, 'generating', undefined],
      [{ status: 'generating', image: undefined }, 'generating', undefined],
      [{ status: 'failed', image: undefined, error: { code: 'PROVIDER_REJECTED', message: 'Rejected.' } }, 'failed', 'generation'],
      [{}, 'generated', undefined],
      [{ decomposition: run('waiting') }, 'decomposing', undefined],
      [{ decomposition: run('running') }, 'decomposing', undefined],
      [{ decomposition: run('done', { layers: 5 }) }, 'decomposed', undefined],
      [{ decomposition: run('done', { layers: 5 }), editor: { runId: 'run-1', openedAt: '2026-10-01T10:05:00.000Z' } }, 'in-editor', undefined],
      // Opened from an earlier decomposition: the latest one is not in the editor yet.
      [{ decomposition: run('done', { layers: 5 }), editor: { runId: 'run-0', openedAt: '2026-10-01T10:05:00.000Z' } }, 'decomposed', undefined],
      [{ decomposition: run('failed', { error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', message: 'Seedream rejected it.' } }) }, 'failed', 'decomposition'],
    ];
    for (const [over, status, failure] of cases) expect([resultStatus(variant(over)).status, resultStatus(variant(over)).failure]).toEqual([status, failure]);
    expect(resultStatus(variant({ decomposition: run('waiting') })).detail).toBe('Waiting for another decomposition to finish.');
    expect(resultStatus(variant({ decomposition: run('done', { layers: 5 }) })).detail).toBe('5 layers ready to open in the editor.');
    expect(resultStatus(variant({ decomposition: run('failed', { error: { code: 'X', message: 'Seedream rejected it.' } }) })).detail).toBe('Seedream rejected it.');
    expect(RESULT_STATUS_LABELS).toEqual({ 'not-generated': 'Not generated', generating: 'Generating…', generated: 'Generated', decomposing: 'Decomposing…', decomposed: 'Decomposed', 'in-editor': 'Ready in editor', failed: 'Failed' });
  });

  it('is read again only while something is on its way, and sums itself up for the list', () => {
    expect(templateInProgress(template({ promptGeneration: { status: 'generating', model: 'm', attempts: 1, startedAt: '' } }))).toBe(true);
    expect(templateInProgress(template({ variants: [variant({ decomposition: run('running') })] }))).toBe(true);
    expect(templateInProgress(template({ variants: [variant({ decomposition: run('done') })] }))).toBe(false);
    expect(templateSummary(template({ prompt: '', promptGeneration: { status: 'generating', model: 'm', attempts: 1, startedAt: '' } }))).toBe('Draft · writing prompt…');
    expect(templateSummary(template())).toBe('Draft · prompt ready');
    expect(templateSummary(template({ generatedAt: 'x', variants: [variant(), variant({ id: '4x5', aspectRatio: '4:5', status: 'failed', image: undefined }), variant({ id: '16x9', aspectRatio: '16:9', status: 'pending', image: undefined })] }))).toBe('1:1 · 4:5 · 1 generated · 1 failed');
    expect(templateSummary(template({ generatedAt: 'x', variants: [variant({ decomposition: run('done') }), variant({ id: '4x5', aspectRatio: '4:5' })] }))).toBe('1:1 · 4:5 · 1 decomposed');
  });
});

describe('Create Template from Image: the form', () => {
  it('5. keeps the sizes in the fixed order, each once', () => {
    expect(withRatio(['16:9'], '1:1', true)).toEqual(['1:1', '16:9']);
    expect(withRatio(['1:1', '4:5', '16:9'], '4:5', false)).toEqual(['1:1', '16:9']);
    expect(withRatio(['1:1'], '1:1', true)).toEqual(['1:1']);
  });

  it('1, 4. says what is missing before generating, in the user\'s terms', () => {
    expect(generationBlockers({ name: 'Lavender', prompt: PROMPT, ratios: ['1:1'] })).toEqual([]);
    expect(generationBlockers({ name: ' ', prompt: '', ratios: [] })).toEqual(['Name your template.', 'Generate the prompt from the image, or write one.', 'Choose at least one size.']);
    expect(generationBlockers({ name: 'x', prompt: '', ratios: ['1:1'], promptGeneration: 'generating' })).toEqual(['Wait for the prompt to be written.']);
    expect(generationBlockers({ name: 'x'.repeat(81), prompt: 'red phone', ratios: ['1:1'] })).toEqual(['The template name is 81 characters; at most 80.', 'The prompt is too short to describe an image.']);
  });

  it('keeps the list newest first, replacing a template where it is', () => {
    expect(withTemplate([template({ id: 'a' }), template({ id: 'b' })], template({ id: 'b', name: 'New' })).map(item => [item.id, item.name])).toEqual([['a', 'Lavender'], ['b', 'New']]);
    expect(withTemplate([template({ id: 'a' })], template({ id: 'c' })).map(item => item.id)).toEqual(['c', 'a']);
  });
});

describe('Create Template from Image: requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const capture = (answer: unknown = template(), status = 200) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(answer), { status }); }));
    return calls;
  };

  it('2–3, 6, 8. each step is one request to the app\'s own server, with only what that step needs', async () => {
    const calls = capture();
    const file = new File([new Uint8Array([1, 2, 3])], 'lavender.png', { type: 'image/png' });
    await imageTemplateApi.create(file, 'Lavender launch');
    await imageTemplateApi.change('t1', { prompt: PROMPT });
    await imageTemplateApi.regeneratePrompt('t1');
    await imageTemplateApi.generate('t1', { name: 'Lavender launch', prompt: PROMPT, aspectRatios: ['1:1', '16:9'] });
    await imageTemplateApi.generateRatio('t1', '4x5');
    await imageTemplateApi.decompose('t1', '1x1');
    await imageTemplateApi.resume('t1', '1x1');
    await imageTemplateApi.opened('t1', '1x1', 'run-1');
    expect(calls.map(call => [call.init?.method ?? 'GET', call.url])).toEqual([
      ['POST', '/api/layerize-experiment/image-templates'], ['PATCH', '/api/layerize-experiment/image-templates/t1'], ['POST', '/api/layerize-experiment/image-templates/t1/prompt'],
      ['POST', '/api/layerize-experiment/image-templates/t1/generate'], ['POST', '/api/layerize-experiment/image-templates/t1/variants/4x5/generate'],
      ['POST', '/api/layerize-experiment/image-templates/t1/variants/1x1/decompose'], ['POST', '/api/layerize-experiment/image-templates/t1/variants/1x1/resume'], ['POST', '/api/layerize-experiment/image-templates/t1/variants/1x1/opened'],
    ]);
    const form = calls[0].init!.body as FormData;
    expect([form.get('name'), (form.get('image') as File).name]).toEqual(['Lavender launch', 'lavender.png']);
    expect(calls.slice(1).map(call => call.init?.body ?? null)).toEqual([JSON.stringify({ prompt: PROMPT }), null, JSON.stringify({ name: 'Lavender launch', prompt: PROMPT, aspectRatios: ['1:1', '16:9'] }), null,
      null, null, JSON.stringify({ runId: 'run-1' })]);
    // An unnamed draft sends no name.
    await imageTemplateApi.create(file, '  ');
    expect((calls.at(-1)!.init!.body as FormData).has('name')).toBe(false);
    await imageTemplateApi.create(file, 'Chosen sizes', ['16:9']);
    expect((calls.at(-1)!.init!.body as FormData).get('aspectRatios')).toBe('["16:9"]');
  });

  it('shows the server\'s own message, and says plainly when the feature\'s server side is off', async () => {
    capture({ error: { code: 'INVALID_NAME', message: 'Give the template a name.' } }, 400);
    await expect(imageTemplateApi.generate('t1', { name: '', prompt: PROMPT, aspectRatios: ['1:1'] })).rejects.toThrow('Give the template a name.');
    capture({}, 404);
    await expect(imageTemplateApi.list()).rejects.toThrow(/LAYERIZE_EXPERIMENT=1/);
  });
});

describe('Create Template from Image: Open in editor', () => {
  const layer = (index: number, kind: 'base' | 'bbox-crop'): ExperimentLayer => ({ index, file: `layer-${index}.png`, zIndex: index, name: kind === 'base' ? undefined : 'Phone', pixelWidth: 10, pixelHeight: 10, opaquePercent: 100,
    placement: { kind, x: kind === 'base' ? 0 : 100, y: kind === 'base' ? 0 : 50, width: kind === 'base' ? 1024 : 200, height: kind === 'base' ? 1024 : 300 } });
  const finished = { id: 'run-1', canvas: { width: 1024, height: 1024 }, layers: [layer(0, 'base'), layer(1, 'bbox-crop')] };
  const store = () => { const put: string[] = [], removed: string[] = []; return { put, removed, assets: { putAsset: async (id: string) => { put.push(id); }, deleteAsset: async (id: string) => { removed.push(id); } } }; };

  it('9. a finished decomposition becomes a new version named after the template and its size, with the run\'s layers', async () => {
    const { put, assets } = store(), fetched: string[] = [];
    const version = await importAsVersion(finished, 'Lavender launch · 4:5', { versions: 1, assets, fetchFile: async (file) => { fetched.push(file); return new Blob([file]); } });
    expect(version).toMatchObject({ name: 'Lavender launch · 4:5', canvas: { width: 1024, height: 1024, transparent: true }, elements: [] });
    expect(version.layers!.map(item => [item.name, item.x, item.y, item.width, item.height, item.visible])).toEqual([['Generated base (z0)', 0, 0, 1024, 1024, true], ['Phone (z1)', 100, 50, 200, 300, true]]);
    expect(fetched).toEqual(['layer-0.png', 'layer-1.png']);
    expect(put).toHaveLength(2);
  });

  it('refuses a 31st version, and removes the layer pictures it stored', async () => {
    const { put, removed, assets } = store();
    await expect(importAsVersion(finished, 'Lavender', { versions: 30, assets, fetchFile: async () => new Blob(['x']) })).rejects.toThrow('This design already has 30 versions. Delete one and try again.');
    expect(removed).toEqual(put);
    await expect(importAsVersion({ ...finished, layers: [] }, 'Lavender', { versions: 1, assets, fetchFile: async () => new Blob(['x']) })).rejects.toThrow('This run has no layers yet.');
  });
});
