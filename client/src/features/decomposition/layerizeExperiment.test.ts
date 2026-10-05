import { afterEach, expect, it, vi } from 'vitest';
import { isDesignVariant } from '../../lib/persistence/schema';
import { experimentApi, experimentToVariant, groupingOf, ownsOptions, parseTargetLayers, refinementSummary, suggestedLayers, targetLayerRange, templateOptionValues, type ExperimentLayer, type ExperimentRun } from './layerizeExperiment';

afterEach(() => { vi.unstubAllGlobals(); });

it('opens a run as a valid transparent version: base at the bottom, placed layers, unresolved layers hidden and unstretched', async () => {
  const layer = (zIndex: number, placement: ExperimentLayer['placement'], name?: string): ExperimentLayer => ({ index: zIndex, file: `layer-0${zIndex}.png`, zIndex, name, pixelWidth: placement.width, pixelHeight: placement.height, opaquePercent: 50, placement });
  const stored: string[] = [];
  let n = 0;
  const variant = await experimentToVariant({ id: '2026-09-28T10-00-00-000Z-abcdef', canvas: { width: 5000, height: 2500 }, layers: [
    layer(2, { kind: 'unresolved', x: 0, y: 0, width: 6000, height: 1000, reason: 'no fit' }),
    layer(1, { kind: 'bbox-scaled', x: 1000, y: 500, width: 400, height: 200 }, 'Phone'),
    layer(0, { kind: 'base', x: 0, y: 0, width: 5000, height: 2500 }),
  ] }, async () => new Blob(['x'], { type: 'image/png' }), { putAsset: async id => { stored.push(id); }, deleteAsset: async () => undefined }, () => String(++n));
  expect(isDesignVariant(variant)).toBe(true);
  expect(variant.canvas).toMatchObject({ width: 4096, height: 2048, transparent: true });
  expect(variant.layers!.map(l => [l.name, l.visible])).toEqual([['Generated base (z0)', true], ['Phone (z1)', true], ['⚠ unplaced: Layer (z2)', false]]);
  const s = 4096 / 5000;
  expect(variant.layers![1]).toMatchObject({ x: 1000 * s, y: 500 * s, width: 400 * s, height: 200 * s });
  // Natural aspect kept (6:1), shrunk only to fit the canvas.
  expect(variant.layers![2].width / variant.layers![2].height).toBeCloseTo(6);
  expect(stored).toHaveLength(3);
});

const templateA = { name: 'Template A', layerRoles: [{ name: 'Base (clean scene)' }, { name: 'Outer background' }, { name: 'Inner backdrop' }, { name: 'Decorative border' },
  { name: 'Main subject', foreground: true }, { name: 'Held object', heldObject: true, foreground: true }] };

it('suggests layers and allows exact targets 1..suggested combined and 3..suggested separate, with the server\'s messages', () => {
  expect(suggestedLayers(templateA, true)).toBe(6);
  expect(suggestedLayers(templateA, false)).toBe(5);
  expect(targetLayerRange(templateA, true)).toEqual({ min: 3, max: 6 });
  expect(targetLayerRange(templateA, false)).toEqual({ min: 1, max: 5 });
  // Empty means the suggested count.
  expect(parseTargetLayers('', templateA, false)).toEqual({ targetLayers: 5 });
  for (const t of [1, 2, 3, 4, 5]) expect(parseTargetLayers(String(t), templateA, false)).toEqual({ targetLayers: t });
  for (const t of [3, 4, 5, 6]) expect(parseTargetLayers(String(t), templateA, true)).toEqual({ targetLayers: t });
  expect(parseTargetLayers('6', templateA, false).error).toBe('Target layers must be a whole number from 1 to 5 for Template A in combined mode (5 is the natural semantic layer count).');
  expect(parseTargetLayers('2', templateA, true).error).toBe('Target layers 2 is too low for separate mode: background, subject and held object need at least 3 layers. Choose 3–6, or uncheck "Separate held object from subject" to allow fewer.');
  for (const bad of ['7', '0', '4.5', 'abc', '-1']) expect(parseTargetLayers(bad, templateA, true).error).toBeTruthy();
});

it('imports the final output layers when a run has them, and the semantic layers otherwise', async () => {
  const layer = (file: string, zIndex: number, kind: ExperimentLayer['placement']['kind'], name?: string): ExperimentLayer => ({ index: zIndex, file, zIndex, name, pixelWidth: 300, pixelHeight: 450, opaquePercent: 50, placement: { kind, x: 0, y: 0, width: 300, height: 450 } });
  const layers = [layer('layer-00.png', 0, 'base'), layer('outer-background.png', 1, 'full-canvas', 'Outer background'), layer('layer-02.png', 2, 'full-canvas', 'Inner backdrop'), layer('layer-03.png', 3, 'full-canvas', 'Main subject')];
  const outputLayers = [{ ...layer('output-01.png', 0, 'full-canvas', 'Base + Outer background + Inner backdrop'), sources: ['layer-00.png', 'outer-background.png', 'layer-02.png'] }, { ...layers[3], sources: ['layer-03.png'] }];
  const fetched: string[] = [];
  const fetchFile = async (file: string) => { fetched.push(file); return new Blob(['x'], { type: 'image/png' }); };
  const noop = { putAsset: async () => undefined, deleteAsset: async () => undefined };
  const variant = await experimentToVariant({ id: '2026-09-28T10-00-00-000Z-abcdef', canvas: { width: 300, height: 450 }, layers, outputLayers }, fetchFile, noop);
  expect(isDesignVariant(variant)).toBe(true);
  expect(fetched).toEqual(['output-01.png', 'layer-03.png']);
  expect(variant.layers!.map(l => l.name)).toEqual(['Base + Outer background + Inner backdrop (z0)', 'Main subject (z3)']);
  fetched.length = 0;
  await experimentToVariant({ id: '2026-09-28T10-00-00-000Z-abcdef', canvas: { width: 300, height: 450 }, layers }, fetchFile, noop);
  expect(fetched).toEqual(layers.map(l => l.file));
});

it('Template B: suggested is found in the decomposition, targets 3+ separate / 1+ combined, capped by the natural count, with its own checkbox texts', () => {
  const templateB = { name: 'Template B', dynamicLayerCount: true, layerRoles: [{ name: 'Base' }, { name: 'Background' }, { name: 'Main product', foreground: true }, { name: 'Secondary object', heldObject: true, foreground: true }],
    grouping: { label: 'Separate secondary object from main product', checked: 'c', unchecked: 'u', minReason: 'background, main product and secondary object', modeName: 'Secondary object mode' } };
  expect(suggestedLayers(templateB, true)).toBeUndefined();
  expect(targetLayerRange(templateB, true)).toEqual({ min: 3, max: 17 });
  expect(targetLayerRange(templateB, false, 7)).toEqual({ min: 1, max: 7 });
  // Empty means no target: the natural layers as returned.
  expect(parseTargetLayers('', templateB, true)).toEqual({});
  expect(parseTargetLayers('4', templateB, true)).toEqual({ targetLayers: 4 });
  expect(parseTargetLayers('2', templateB, true).error).toBe('Target layers 2 is too low for separate mode: background, main product and secondary object need at least 3 layers. Choose 3–17, or uncheck "Separate secondary object from main product" to allow fewer.');
  expect(parseTargetLayers('8', templateB, false, 7).error).toBe("Target layers must be a whole number from 1 to 7 for Template B in combined mode (7 is this decomposition's natural semantic layer count).");
  expect(groupingOf(templateB).label).toBe('Separate secondary object from main product');
  expect(groupingOf(undefined).label).toBe('Separate held object from subject');
});

/** Template B as the server lists it now: its own option, no held-object checkbox. */
const templateBOwnOptions = { name: 'Template B', dynamicLayerCount: true, layerRoles: [{ name: 'Base' }, { name: 'Main product', foreground: true }, { name: 'Secondary object', foreground: true }],
  options: [{ key: 'separateTouchingIndependentObjects', label: 'Separate touching / overlapping independent objects', help: 'h', default: false }] };

it('Template B owns its option: defaults, no held-object separate mode, and its own target message', () => {
  expect(ownsOptions(templateBOwnOptions)).toBe(true);
  expect(ownsOptions({ ...templateA, options: undefined })).toBe(false);
  expect(templateOptionValues(templateBOwnOptions)).toEqual({ separateTouchingIndependentObjects: false });
  expect(templateOptionValues(templateBOwnOptions, { separateTouchingIndependentObjects: true })).toEqual({ separateTouchingIndependentObjects: true });
  expect(templateOptionValues({ ...templateA, options: undefined }, { separateTouchingIndependentObjects: true })).toBeUndefined();
  // The held-object checkbox value never changes Template B's range.
  for (const separate of [true, false]) expect(targetLayerRange(templateBOwnOptions, separate)).toEqual({ min: 1, max: 17 });
  expect(parseTargetLayers('1', templateBOwnOptions, true)).toEqual({ targetLayers: 1 });
  expect(parseTargetLayers('8', templateBOwnOptions, true, 7).error).toBe("Target layers must be a whole number from 1 to 7 for Template B (7 is this decomposition's natural semantic layer count).");
  // Template A's rules are unchanged.
  expect(targetLayerRange(templateA, true)).toEqual({ min: 3, max: 6 });
});

it('sends Template B\'s option as templateOptions, and Template A\'s request without it', async () => {
  const bodies: FormData[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { bodies.push(init.body as FormData); return new Response(JSON.stringify({ id: 'r' }), { status: 202 }); }));
  const file = new File(['x'], 'x.png', { type: 'image/png' });
  await experimentApi.start(file, 'generated', 'template-b', true, undefined, { separateTouchingIndependentObjects: true });
  await experimentApi.start(file, 'generated', 'template-a', false, 5);
  expect(JSON.parse(bodies[0].get('templateOptions') as string)).toEqual({ separateTouchingIndependentObjects: true });
  expect(bodies[0].get('templateKey')).toBe('template-b');
  // Template A: exactly the fields it sent before.
  expect([...bodies[1].keys()]).toEqual(['promptMode', 'separateHeldObject', 'targetLayers', 'templateKey', 'image']);
  expect(bodies[1].get('separateHeldObject')).toBe('false');
  // "Run anyway" past the template fit check adds only skipFitCheck.
  await experimentApi.start(file, 'generated', 'template-a', false, undefined, undefined, true);
  expect([...bodies[2].keys()]).toEqual(['promptMode', 'separateHeldObject', 'templateKey', 'skipFitCheck', 'image']);
  expect(bodies[2].get('skipFitCheck')).toBe('true');
});

it('imports a refined run: the clean background at the bottom, residual-pass layers marked, each layer once', async () => {
  const placement = { kind: 'full-canvas' as const, x: 0, y: 0, width: 1024, height: 1024 };
  const layer = (file: string, zIndex: number, name: string, sourcePass: number, extra: Partial<ExperimentLayer> = {}): ExperimentLayer => ({ index: zIndex, file, zIndex, name, pixelWidth: 1024, pixelHeight: 1024, opaquePercent: 5, placement,
    provenance: { sourcePass, sourceImage: sourcePass ? `residual-pass-${sourcePass}.png` : 'original.png', providerFile: file, providerZIndex: zIndex, role: 'unknown', mask: file }, ...extra });
  const layers = [
    layer('clean-background.png', 0, 'Background', 0, { placement: { ...placement, kind: 'base' }, rawFile: 'layer-00.png', cleanBackground: { status: 'ai-reconstructed', method: 'ai-reconstruction' } }),
    layer('layer-01.png', 1, 'Display pedestal', 0), layer('pass-1-layer-01.png', 2, 'Bluetooth speaker', 1), layer('layer-03.png', 3, 'Wireless headphones', 0),
  ];
  const fetched: string[] = [];
  const variant = await experimentToVariant({ id: '2026-10-05T10-00-00-000Z-abcdef', canvas: { width: 1024, height: 1024 }, layers, outputLayers: layers.map(l => ({ ...l, sources: [l.file] })) },
    async file => { fetched.push(file); return new Blob(['x'], { type: 'image/png' }); }, { putAsset: async () => undefined, deleteAsset: async () => undefined });
  expect(isDesignVariant(variant)).toBe(true);
  expect(fetched).toEqual(['clean-background.png', 'layer-01.png', 'pass-1-layer-01.png', 'layer-03.png']);
  expect(variant.layers!.map(l => l.name)).toEqual(['Clean background (z0)', 'Display pedestal (z1)', 'Bluetooth speaker · pass 1 (z2)', 'Wireless headphones (z3)']);
  // A fallback or contaminated background is never called clean.
  for (const [status, name] of [['fallback', 'Background (fallback fill) (z0)'], ['contaminated', 'Background (contaminated) (z0)']] as const) {
    const base = { ...layers[0], cleanBackground: { status, method: status === 'fallback' ? 'local-fill' as const : 'ai-reconstruction' as const } };
    const imported = await experimentToVariant({ id: '2026-10-05T10-00-00-000Z-abcdef', canvas: { width: 1024, height: 1024 }, layers: [base] }, async () => new Blob(['x']), { putAsset: async () => undefined, deleteAsset: async () => undefined });
    expect(imported.layers![0].name).toBe(name);
  }
});

it('summarizes a refined run for debugging: passes, final layers, cleanup, background and every call', () => {
  const run = { calls: { fitCheck: 0, planner: 1, seedreamInitial: 1, seedreamResidual: 2, backgroundReconstruction: 1 }, refinement: {
    state: 'done', options: { maxDepth: 2, maxTotalLayers: 32, reconstructBackground: true }, passesExecuted: 3, finalLayers: 17, stopReason: 'clean', warnings: [], assessments: [],
    passes: [{ pass: 1, state: 'done', accepted: ['a'], rejected: [] }, { pass: 2, state: 'done', accepted: ['b'], rejected: [] }],
    background: { status: 'ai-reconstructed', method: 'ai-reconstruction', file: 'clean-background.png', contaminated: false, reasons: [] },
  } } satisfies Pick<ExperimentRun, 'refinement' | 'calls'>;
  expect(refinementSummary(run)).toEqual([
    { label: 'Passes', value: '3 (1 initial + 2 residual, at most 2)' }, { label: 'Final layers', value: '17' },
    { label: 'Residual cleanup', value: 'Performed (stopped: clean)' }, { label: 'Background', value: 'AI reconstructed' },
    { label: 'Calls', value: 'planner 1 · initial Seedream 1 · residual Seedream 2 · background edit 1' },
  ]);
  expect(refinementSummary({ ...run, refinement: { ...run.refinement, passesExecuted: 1, passes: [], background: { ...run.refinement.background, status: 'provider-clean' } } }).slice(2, 4).map(line => line.value))
    .toEqual(['Not needed (clean)', 'Clean (Seedream base, no reconstruction needed)']);
  expect(refinementSummary({})).toEqual([]);
});

it('asks for the recursive refinement only when chosen', async () => {
  const sent: FormData[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { sent.push(init.body as FormData); return new Response(JSON.stringify({ id: 'x' }), { status: 202 }); }));
  const file = new File(['x'], 'offer.png', { type: 'image/png' });
  await experimentApi.start(file, 'generated', 'template-b');
  await experimentApi.start(file, 'generated', 'template-b', true, undefined, undefined, false, true);
  expect(sent.map(form => form.get('recursive'))).toEqual([null, 'true']);
});
