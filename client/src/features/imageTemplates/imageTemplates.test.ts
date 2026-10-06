import { IMAGE_TEMPLATE_LIMITS } from '@frameflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExperimentLayer, ExperimentRun } from '../decomposition/layerizeExperiment';
import { bootstrapEditor } from '../../lib/persistence/bootstrap';
import { PROJECT_KEY } from '../../lib/persistence/projectStorage';
import { assets as runtimeAssets } from '../../lib/assets/runtimeAssets';
import { createDocument } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { generationBlockers, imageTemplateApi, importAsVersion, MAX_VERSIONS, openResultInEditor, RESULT_STATUS_LABELS, resultStatus, templateInProgress, templateSummary, withRatio, withTemplate, type ImageTemplate, type ImageTemplateVariant } from './imageTemplates';

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

  it('counts exact user text and rejects one character above the inclusive shared limit', () => {
    for (const [length, valid] of [[IMAGE_TEMPLATE_LIMITS.prompt - 1, true], [IMAGE_TEMPLATE_LIMITS.prompt, true], [IMAGE_TEMPLATE_LIMITS.prompt + 1, false], [IMAGE_TEMPLATE_LIMITS.prompt - 1, true]] as const) {
      const prompt = 'a'.repeat(length - 1) + ' ';
      expect(generationBlockers({ name: 'Boundary', prompt, ratios: ['1:1'] }).length === 0).toBe(valid);
    }
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

describe('Open in editor: a decomposed result opens as a design of its own, never a new version', () => {
  const SIZES = { '1:1': [1024, 1024], '4:5': [1216, 1520], '16:9': [1536, 864] } as const;
  const runOf = (id: string, [width, height]: readonly [number, number]): ExperimentRun => ({ id, stage: 'done', canvas: { width, height }, warnings: [], layers: [
    { index: 0, file: 'clean-background.png', zIndex: 0, pixelWidth: width, pixelHeight: height, opaquePercent: 100, placement: { kind: 'base', x: 0, y: 0, width, height }, cleanBackground: { status: 'continued-clean', method: 'plain-field' } },
    { index: 1, file: 'layer-01.png', zIndex: 1, name: 'Woman and child', pixelWidth: 200, pixelHeight: 300, opaquePercent: 60, placement: { kind: 'bbox-scaled', x: 100, y: 120, width: 200, height: 300 } },
    { index: 2, file: 'layer-02.png', zIndex: 2, name: '"NOW" headline', pixelWidth: 300, pixelHeight: 80, opaquePercent: 40, placement: { kind: 'bbox-crop', x: 40, y: 30, width: 300, height: 80 } }] } as unknown as ExperimentRun);
  const tpl = { id: 'tmpl-mom', name: 'mom and child' };
  const result = (ratio: keyof typeof SIZES, runId = `run-${ratio}`, editor?: { runId: string; openedAt: string }) => ({ id: ratio.replace(':', 'x'), aspectRatio: ratio,
    decomposition: { runId, templateKey: 'template-c', createdAt: '', state: 'done' as const, stage: 'done', layers: 3 }, ...(editor ? { editor } : {}) });
  /** The real editor session on in-memory browser storage, opened on "My campaign" with `versions` versions; every server read counted. */
  function harness(versions: number) {
    const main = createDocument('my-campaign', '2026-10-06T00:00:00.000Z');
    main.name = 'My campaign';
    main.variants = Array.from({ length: versions }, (_, i) => ({ ...main.variants[0], id: `v${i + 1}`, name: `Version ${i + 1}` }));
    const values = new Map([[PROJECT_KEY, JSON.stringify(main)]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const removed: string[] = [], session = bootstrapEditor(() => storage, { ...runtimeAssets, deleteAsset: async (id: string) => { removed.push(id); } });
    const runs = new Map(Object.entries(SIZES).map(([ratio, size]) => [`run-${ratio}`, runOf(`run-${ratio}`, size)]));
    const reads = { runs: [] as string[], files: [] as string[], recorded: [] as string[] };
    let n = 0;
    const deps = {
      current: () => session.store.getState().editor.document, stored: () => session.designs(),
      openStored: (id: string) => session.openDesign(id), openNew: (document: Parameters<typeof session.openNewDesign>[0]) => session.openNewDesign(document),
      select: (id: string) => session.store.dispatch(variantSelected(id)),
      run: async (id: string) => { reads.runs.push(id); await Promise.resolve(); return runs.get(id)!; },
      file: async (runId: string, file: string) => { reads.files.push(`${runId}/${file}`); return new Blob([file]); },
      recordOpened: async (runId: string) => { reads.recorded.push(runId); },
      assets: { putAsset: async () => undefined, deleteAsset: async (id: string) => { removed.push(id); } }, newId: () => `id-${++n}`,
    };
    const open = () => session.store.getState().editor.document;
    /** "My campaign" as kept on this device (stored while another design is open, else open). */
    const campaign = () => open().id === 'my-campaign' ? open() : JSON.parse(values.get('frameflow:design:v1:my-campaign')!);
    return { session, deps, reads, removed, open, campaign, values };
  }

  it('1/7. the first open of 1:1, 4:5 and 16:9 creates a design each, on its own canvas with every layer; "My campaign" keeps its 28 versions', async () => {
    const h = harness(28);
    for (const ratio of ['4:5', '1:1', '16:9'] as const) {
      const opened = (await openResultInEditor(tpl, result(ratio), h.deps))!;
      expect(opened.created).toBe(true);
      const design = h.open();
      expect(design).toMatchObject({ id: opened.documentId, name: `mom and child · ${ratio}` });
      expect(design.variants).toHaveLength(1);
      expect(design.variants[0]).toMatchObject({ canvas: { width: SIZES[ratio][0], height: SIZES[ratio][1] }, importedFrom: { templateId: 'tmpl-mom', resultId: ratio.replace(':', 'x'), runId: `run-${ratio}` } });
      expect(design.variants[0].layers!.map(l => l.name)).toEqual(['Clean background (z0)', 'Woman and child (z1)', '"NOW" headline (z2)']);
      expect(h.campaign().variants).toHaveLength(28);
    }
    expect(h.session.designs().map(d => d.name).sort()).toEqual(['My campaign', 'mom and child · 1:1', 'mom and child · 4:5']);
    expect(h.reads.recorded).toEqual(['run-4:5', 'run-1:1', 'run-16:9']);
    // Back to the campaign: exactly as it was.
    h.session.openDesign('my-campaign');
    expect(h.open().variants.map(v => v.id)).toEqual(Array.from({ length: 28 }, (_, i) => `v${i + 1}`));
  });

  it('4. with 30 versions open, the first open still works, with no warning, and the campaign stays at 30', async () => {
    const h = harness(MAX_VERSIONS);
    const opened = (await openResultInEditor(tpl, result('4:5'), h.deps))!;
    expect(opened.created).toBe(true);
    expect(h.open().variants[0].canvas).toMatchObject({ width: 1216, height: 1520 });
    expect(h.campaign().variants).toHaveLength(MAX_VERSIONS);
  });

  it('2. opening it again switches back to the same design: no new design, no version, no download or server write', async () => {
    const h = harness(28);
    const first = (await openResultInEditor(tpl, result('4:5'), h.deps))!;
    await openResultInEditor(tpl, result('1:1'), h.deps);
    const reads = { runs: h.reads.runs.length, files: h.reads.files.length }, designs = h.session.designs().length;
    const opened = { runId: 'run-4:5', openedAt: '2026-10-06T08:30:00.000Z' };
    expect(await openResultInEditor(tpl, result('4:5', 'run-4:5', opened), h.deps)).toEqual({ documentId: first.documentId, created: false });
    expect(h.open().id).toBe(first.documentId);
    expect(h.open().variants).toHaveLength(1);
    // Already open: still the same design and its one version.
    expect(await openResultInEditor(tpl, result('4:5', 'run-4:5', opened), h.deps)).toEqual({ documentId: first.documentId, created: false });
    expect([h.reads.runs.length, h.reads.files.length, h.session.designs().length, h.reads.recorded.length]).toEqual([reads.runs, reads.files, designs, 2]);
    expect(h.campaign().variants).toHaveLength(28);
    // A later decomposition of the same result is a different run: a new design.
    expect((await openResultInEditor(tpl, result('4:5', 'run-4:5-b'), { ...h.deps, run: async () => runOf('run-4:5-b', SIZES['4:5']) }))!.created).toBe(true);
  });

  it('6. two clicks while one open is on its way make one design, not two', async () => {
    const h = harness(28);
    const [a, b] = await Promise.all([openResultInEditor(tpl, result('4:5'), h.deps), openResultInEditor(tpl, result('4:5'), h.deps)]);
    expect(a!.documentId).toBe(b!.documentId);
    expect(h.session.designs().map(d => d.name)).toEqual(['My campaign']);
    expect(h.reads.runs).toEqual(['run-4:5']);
  });

  it('never pretends: storage refusing the new design is an error, its pictures are removed and the open design is unchanged', async () => {
    const h = harness(28);
    await expect(openResultInEditor(tpl, result('4:5'), { ...h.deps, openNew: () => { throw new Error('quota exceeded'); } })).rejects.toThrow('The 4:5 result could not be opened: quota exceeded. The design that was open is unchanged.');
    expect(h.removed).toHaveLength(3);
    expect(h.open()).toMatchObject({ id: 'my-campaign' });
    expect(h.open().variants).toHaveLength(28);
    await expect(openResultInEditor(tpl, { ...result('4:5'), decomposition: { ...result('4:5').decomposition, state: 'running' as const } }, h.deps)).rejects.toThrow('This image has no finished decomposition yet.');
    // Closed before it finished: nothing is opened.
    expect(await openResultInEditor(tpl, result('16:9'), { ...h.deps, wanted: () => false })).toBeUndefined();
    expect(h.open().id).toBe('my-campaign');
  });
});
