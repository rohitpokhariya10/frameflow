import { describe, expect, it, vi } from 'vitest';
import {
  addElement, applyCreative, createCreative, createTemplateDraft, createTemplateElement, designCanvasSize, hasExplicitOrder, paintOrder, setCreativeOverride, setElementLayout, updateElement, variantToCanvasElements,
  type DesignLayer, type DesignTemplate, type DesignVariant, type ProjectDocument,
} from '@frameflow/shared';
import { isDesignVariant, isProjectDocument } from '../../lib/persistence/schema';
import { PROJECT_KEY, restoreProject, saveProject } from '../../lib/persistence/projectStorage';
import { createEditorStore } from '../../store';
import { decomposedDesignImported, layerAdded, layerDuplicated, layerReordered, textAdded, textDuplicated, textUpdated } from '../../store/editorSlice';
import { creativeToVariant, type VariantDeps } from './toDesignVariant';

const NOW = '2026-09-30T10:00:00.000Z';
const LONG = 'MEGA FESTIVE CASHBACK OFFER FOR EVERY NEW AND EXISTING CUSTOMER THIS FESTIVE SEASON';
/** The validation example: background z0, rotated decorative text z1 (15°), hero image z2, heading z3 (2 lines, shrink then ellipsis). */
function template(): DesignTemplate {
  let draft = createTemplateDraft('tpl-1', NOW, 'Festival Campaign');
  for (const [role, id] of [['background', 'background'], ['generic-text', 'ribbon'], ['hero', 'hero'], ['heading', 'heading']] as const) draft = addElement(draft, createTemplateElement(role, id, 0));
  draft = setElementLayout(draft, 'ribbon', { x: 0.1, y: 0.3, width: 0.5, height: 0.08, rotation: 15 });
  draft = setElementLayout(draft, 'hero', { x: 0.3, y: 0.25, width: 0.6, height: 0.5 });
  draft = setElementLayout(draft, 'heading', { x: 0.05, y: 0.05, width: 0.6, height: 0.1 });
  draft = updateElement(draft, 'hero', element => element.type === 'image' ? { ...element, defaultContent: { assetId: 'asset-hero' } } : element);
  return updateElement(draft, 'background', element => element.type === 'background' ? { ...element, defaultContent: { color: '#F48FB1', assetId: 'asset-bg' } } : element);
}
const creativeOf = (source: DesignTemplate) => setCreativeOverride(createCreative(source, { id: 'creative-1', name: 'Holi Cashback Campaign', now: NOW, aspectRatio: '4:5' }), source, 'heading', { text: LONG }, NOW);
function deps(overrides: Partial<VariantDeps> = {}) {
  let n = 0;
  const calls = { copied: [] as string[], deleted: [] as string[] };
  const value: VariantDeps = { newId: () => String(++n), copyAsset: async (assetId) => { calls.copied.push(assetId); return `copy-${assetId}`; }, deleteAsset: async (assetId) => { calls.deleted.push(assetId); }, ...overrides };
  return { value, calls };
}
/** Opens the creative as the studio does: the template's elements with the creative's content, through the shared adapter. */
async function open(d = deps(), source = template()) {
  const creative = creativeOf(source), elements = applyCreative(source, creative).elements;
  const variant = await creativeToVariant(elements, designCanvasSize(creative.aspectRatio), { name: creative.name, templateId: source.id, templateVersion: source.version, creativeId: creative.id }, d.value);
  return { variant, elements, calls: d.calls };
}
function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const order = (variant: Pick<DesignVariant, 'elements' | 'layers'>) => paintOrder(variant).map(item => item.kind === 'text' ? item.element.id : item.layer.id);

describe('opening a creative in the existing editor', () => {
  it('gives the editor a valid design that keeps order, rotation, raw text and overflow rules', async () => {
    const { variant, calls } = await open();
    expect(isDesignVariant(variant)).toBe(true);
    expect(variant).toMatchObject({ id: 'template-1', name: 'Holi Cashback Campaign', canvas: { width: 1080, height: 1350, backgroundColor: '#F48FB1' }, background: { assetId: 'copy-asset-bg', fit: 'cover' },
      template: { templateId: 'tpl-1', templateVersion: 1, creativeId: 'creative-1' } });
    // The editor works on its own copy of each picture, so it never owns or deletes the template's.
    expect(calls.copied).toEqual(['asset-bg', 'asset-hero']);
    // z-order: the rotated text below the hero image, the heading above it.
    expect(order(variant)).toEqual(['ribbon', 'hero', 'heading']);
    expect(variant.elements.map(element => [element.id, element.zIndex, element.rotation])).toEqual([['ribbon', 1, 15], ['heading', 3, 0]]);
    expect(variant.layers).toMatchObject([{ id: 'hero', zIndex: 2, assetId: 'copy-asset-hero', fit: 'cover', focalPoint: { x: 0.5, y: 0.5 } }]);
    // The heading: the whole text as written, and its rules beside it.
    expect(variant.elements[1]).toMatchObject({ text: LONG, maxLines: 2, overflow: 'shrink', x: 54, y: 67.5, width: 648, height: 135 });
    expect(JSON.stringify(variant)).not.toContain('…');
  });

  it('removes the copies it made and returns nothing when a picture is missing', async () => {
    const failing = deps({ copyAsset: vi.fn(async (assetId: string) => assetId === 'asset-hero' ? undefined : `copy-${assetId}`) });
    await expect(open(failing)).rejects.toThrow('The picture of "Hero image" is missing from this browser.');
    expect(failing.calls.deleted).toEqual(['copy-asset-bg']);
    await expect(creativeToVariant([], { width: 10, height: 10 }, { name: 'Tiny', templateId: 't', templateVersion: 1, creativeId: 'c' }, deps().value)).rejects.toThrow('cannot be opened in the editor');
  });

  it('11–12. open, save, reopen: the design and its normalized geometry come back exactly, twice', async () => {
    const identity = deps({ copyAsset: async assetId => assetId });
    const { variant, elements } = await open(identity);
    const store = createEditorStore();
    store.dispatch(decomposedDesignImported({ variant, timestamp: NOW }));
    const storage = memory();
    saveProject(() => storage, store.getState().editor.document);
    const reopened = restoreProject(() => storage).document!.variants.find(item => item.id === variant.id)!;
    expect(reopened).toEqual(variant);
    // Read back as the shared model: the same elements the template and creative resolve to.
    expect(variantToCanvasElements(reopened)).toEqual(elements);
    // A second session: reopen, save, reopen again. Nothing drifts.
    const second = createEditorStore(restoreProject(() => storage).document);
    saveProject(() => storage, second.getState().editor.document);
    const again = restoreProject(() => storage).document!.variants.find(item => item.id === variant.id)!;
    expect(again).toEqual(variant);
    expect(variantToCanvasElements(again)).toEqual(elements);
    expect(order(again)).toEqual(['ribbon', 'hero', 'heading']);
  });

  it('editing the text in the editor changes the text only: its rules, box, rotation and place in the order stay', async () => {
    const { variant } = await open();
    const store = createEditorStore();
    store.dispatch(decomposedDesignImported({ variant, timestamp: NOW }));
    store.dispatch(textUpdated({ variantId: variant.id, id: 'heading', changes: { text: `${LONG} AND MORE` }, timestamp: NOW }));
    store.dispatch(textUpdated({ variantId: variant.id, id: 'ribbon', changes: { text: 'Ends Sunday' }, timestamp: NOW }));
    const edited = store.getState().editor.document.variants.find(item => item.id === variant.id)!;
    expect(edited.elements[1]).toEqual({ ...variant.elements[1], text: `${LONG} AND MORE` });
    expect(edited.elements[0]).toEqual({ ...variant.elements[0], text: 'Ends Sunday' });
    // The template and the creative are other data entirely: the template still resolves to what it did.
    expect(applyCreative(template(), creativeOf(template())).elements.find(element => element.id === 'heading')).toMatchObject({ defaultContent: { text: LONG } });
  });
});

describe('the one order in the editor', () => {
  const shape = (id: string): DesignLayer => ({ id, name: id, type: 'shape', shapeType: 'rectangle', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#285443', radius: 0 });

  it('keeps text and layers interleaved when elements are added, duplicated and reordered', async () => {
    const { variant } = await open();
    const store = createEditorStore(), at = { variantId: variant.id, timestamp: NOW };
    const current = () => store.getState().editor.document.variants.find(item => item.id === variant.id)!;
    store.dispatch(decomposedDesignImported({ variant, timestamp: NOW }));
    expect(order(current())).toEqual(['ribbon', 'hero', 'heading']);
    // New text goes on top; a background layer goes underneath everything, the rotated text included.
    store.dispatch(textAdded({ ...at, id: 'note', kind: 'body' }));
    store.dispatch(layerAdded({ ...at, layer: shape('backdrop'), position: 'bottom' }));
    expect(order(current())).toEqual(['backdrop', 'ribbon', 'hero', 'heading', 'note']);
    // A copy sits directly above what it was made from.
    store.dispatch(layerDuplicated({ ...at, id: 'hero', newId: 'hero-2' }));
    store.dispatch(textDuplicated({ ...at, id: 'ribbon', newId: 'ribbon-2', x: 10, y: 10 }));
    expect(order(current())).toEqual(['backdrop', 'ribbon', 'ribbon-2', 'hero', 'hero-2', 'heading', 'note']);
    // Reordering layers moves them among the places layers hold; the text between them stays where it is.
    store.dispatch(layerReordered({ ...at, id: 'backdrop', direction: 'forward' }));
    expect(order(current())).toEqual(['hero', 'ribbon', 'ribbon-2', 'backdrop', 'hero-2', 'heading', 'note']);
    expect(current().layers!.map(layer => layer.id)).toEqual(['hero', 'backdrop', 'hero-2']);
    store.dispatch(layerAdded({ ...at, layer: shape('sticker'), position: 'top' }));
    expect(order(current()).at(-1)).toBe('sticker');
    expect(isProjectDocument(store.getState().editor.document)).toBe(true);
  });
});

describe('older documents', () => {
  /** A project exactly as a build before these fields saved it: text, an image layer, a shape layer, background artwork. */
  const older = (): ProjectDocument => ({
    schemaVersion: 1, id: 'older-project', name: 'Spring gala', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    variants: [{
      id: 'original', name: 'Original', revision: 4, canvas: { width: 1080, height: 1350, backgroundColor: '#FFFEFA' },
      elements: [
        { id: 'title', type: 'text', role: 'title', text: 'Spring Gala', x: 162, y: 432, width: 756, fontFamily: 'Lora', fontSize: 72, fontWeight: 600, fill: '#1F2925', align: 'center', lineHeight: 1.2, letterSpacing: 0 },
        { id: 'date', type: 'text', role: 'date', text: '12 May', x: 162, y: 648, width: 756, fontFamily: 'Inter', fontSize: 30, fontWeight: 400, fill: '#1F2925', align: 'center', lineHeight: 1.35, letterSpacing: 1 },
      ],
      layers: [
        { id: 'panel', name: 'Orange panel', type: 'shape', shapeType: 'rounded-rectangle', x: 100, y: 400, width: 850, height: 700, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#ff6a00', radius: 50, gradient: { from: '#ff6a00', to: '#ffd54a', angle: 45 }, stroke: { color: '#000000', width: 2 } },
        { id: 'photo', name: 'Photo', type: 'image', assetId: 'decomp-photo', x: 140, y: 140, width: 300, height: 300, rotation: 12, opacity: 0.9, visible: true, locked: true, source: { jobId: 'job-1', layerId: 'layer-1', kind: 'image' } },
      ],
      background: { assetId: 'artwork-1', fit: 'cover', focalPoint: { x: 0.5, y: 0.5 } },
    }],
  });

  it('10. an existing editor document still loads, unchanged, and is drawn in its old order', () => {
    const document = older(), storage = memory();
    expect(isProjectDocument(document)).toBe(true);
    storage.values.set(PROJECT_KEY, JSON.stringify(document));
    const restored = restoreProject(() => storage);
    expect(restored).toEqual({ document });
    // No migration and no rewrite: saving it again writes the same text.
    saveProject(() => storage, restored.document!);
    expect(storage.values.get(PROJECT_KEY)).toBe(JSON.stringify(document));
    const variant = restored.document!.variants[0];
    expect(hasExplicitOrder(variant)).toBe(false);
    expect(order(variant)).toEqual(['panel', 'photo', 'title', 'date']);
    // Working on it keeps it in the old format: no element is given a place in a shared order.
    const store = createEditorStore(document), at = { variantId: 'original', timestamp: NOW };
    store.dispatch(textAdded({ ...at, id: 'extra', kind: 'body' }));
    store.dispatch(layerDuplicated({ ...at, id: 'panel', newId: 'panel-2' }));
    store.dispatch(layerReordered({ ...at, id: 'photo', direction: 'backward' }));
    const edited = store.getState().editor.document.variants[0];
    expect(order(edited)).toEqual(['panel', 'photo', 'panel-2', 'title', 'date', 'extra']);
    expect(JSON.stringify(edited)).not.toContain('zIndex');
    expect(isProjectDocument(store.getState().editor.document)).toBe(true);
  });

  it('still rejects unknown fields and invalid values of the new optional fields', () => {
    const withText = (change: Record<string, unknown>) => { const document = older(); Object.assign(document.variants[0].elements[0], change); return isProjectDocument(document); };
    expect(withText({ rotation: 15, zIndex: 3, height: 120, maxLines: 2, overflow: 'shrink', minFontSize: 36, verticalAlign: 'middle', name: 'Title', visible: true, box: { fill: null, radius: 0 } })).toBe(true);
    for (const bad of [{ zIndex: 1.5 }, { overflow: 'clip' }, { maxLines: 0 }, { rotation: 720 }, { height: 0 }, { minFontSize: -1 }, { box: { fill: 'red', radius: 0 } }, { selected: true }, { editable: { content: true } }]) expect(withText(bad)).toBe(false);
    const withLayer = (index: number, change: Record<string, unknown>) => { const document = older(); Object.assign(document.variants[0].layers![index], change); return isProjectDocument(document); };
    expect(withLayer(1, { fit: 'contain', focalPoint: { x: 0.2, y: 0.8 }, radius: 12, role: 'hero', zIndex: 2 })).toBe(true);
    expect(withLayer(0, { shapeType: 'circle', role: 'circle', zIndex: -1 })).toBe(true);
    for (const bad of [{ fit: 'stretch' }, { focalPoint: { x: 2, y: 0 } }, { role: 'mascot' }, { zIndex: 'top' }]) expect(withLayer(1, bad)).toBe(false);
  });
});
