import { afterEach, expect, it, vi } from 'vitest';
import { bootstrapEditor } from './bootstrap';
import { PROJECT_KEY } from './projectStorage';
import { assets } from '../assets/runtimeAssets';
import { createDocument, textAdded, generatedDesignApplied, adaptedDesignApplied } from '../../store/editorSlice';
import { undo, redo } from '../../store/history';
import { elementSelected, variantSelected, tabChanged, aiModeChanged } from '../../store/uiSlice';
import { generationStarted, generationReady, generationFailed, type DesignPreview } from '../../store/aiSlice';

const timestamp = '2026-09-22T00:00:00.000Z';
function setup() {
  const document = createDocument('old-project', timestamp);
  document.name = 'Keep my design';
  document.variants[0].background = { assetId: 'source-art', fit: 'cover', focalPoint: { x: .5, y: .5 } };
  document.variants.push({ ...document.variants[0], id: 'landscape', sourceVariantId: 'original', canvas: { width: 1600, height: 900, backgroundColor: '#FFFEFA' }, background: { ...document.variants[0].background, assetId: 'target-art' } });
  const values = new Map([[PROJECT_KEY, JSON.stringify(document)], ['unrelated-setting', 'preserve']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
  const records = new Set(['source-art', 'target-art', 'preview-art', 'unrelated-art']);
  const deleteAsset = vi.fn(async (id: string) => { records.delete(id); });
  const session = bootstrapEditor(() => storage, { ...assets, deleteAsset });
  return { session, store: session.store, storage, values, records, deleteAsset };
}
afterEach(() => vi.useRealTimers());

for (const adapting of [false, true]) it(`resets the complete project boundary with ${adapting ? 'adaptation' : 'generation'} preview and both history directions`, async () => {
  const { session, store, records, values } = setup();
  store.dispatch(textAdded({ variantId: 'original', id: 'one', kind: 'heading', timestamp }));
  store.dispatch(textAdded({ variantId: 'original', id: 'two', kind: 'body', timestamp }));
  store.dispatch(undo());
  store.dispatch(variantSelected('landscape')); store.dispatch(elementSelected('one'));
  store.dispatch(tabChanged('ai')); store.dispatch(aiModeChanged('adapt'));
  const before = store.getState();
  const preview: DesignPreview = { variant: { ...before.editor.document.variants[0], background: { assetId: 'preview-art', fit: 'cover', focalPoint: { x: .5, y: .5 } } },
    originalPrompt: 'Artwork', styleBrief: { theme: 'Test', palette: [], motifs: [], mood: 'Calm' }, unresolved: [], sourceProjectId: 'old-project', sourceVersion: before.editor.version,
    ...(adapting ? { adaptation: { source: before.editor.document.variants[0], selectionVersion: 0, format: 'landscape' as const } } : {}) };
  store.dispatch(generationStarted('old-request')); store.dispatch(generationReady({ requestId: 'old-request', preview }));
  expect(await session.newDesign()).toBe(true);
  const fresh = store.getState();
  expect(fresh.editor.document.id).not.toBe('old-project');
  expect(fresh.editor.document).toEqual(createDocument(fresh.editor.document.id, fresh.editor.document.createdAt));
  expect(fresh.editor).toMatchObject({ past: [], future: [], group: null, version: 0 });
  expect(fresh.ui).toMatchObject({ activeVariantId: 'original', selectedElementId: null, activeLeftTab: 'design', aiMode: 'generate', zoom: 1 });
  expect(fresh.ai).toEqual({ status: 'idle', requestId: null, preview: null, error: '' });
  expect(fresh.save).toEqual({ status: 'saved', warning: '' });
  expect([...records]).toEqual(['unrelated-art']); expect(values.get('unrelated-setting')).toBe('preserve');
  store.dispatch(undo()); store.dispatch(redo());
  store.dispatch(generationReady({ requestId: 'old-request', preview }));
  store.dispatch(generationFailed({ requestId: 'old-request', message: 'Late failure' }));
  store.dispatch(generatedDesignApplied({ preview, timestamp }));
  store.dispatch(adaptedDesignApplied({ preview, timestamp }));
  expect(store.getState()).toEqual(fresh);
  session.dispose();
});

it('invalidates a pending old debounce before persisting fresh state, including flush and recovery', async () => {
  vi.useFakeTimers();
  const { session, store, storage } = setup();
  store.dispatch(textAdded({ variantId: 'original', id: 'pending', kind: 'heading', timestamp }));
  vi.advanceTimersByTime(499);
  await session.newDesign(); const fresh = store.getState().editor.document;
  vi.runAllTimers(); session.flush();
  expect(JSON.parse(storage.getItem(PROJECT_KEY)!)).toEqual(fresh);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  const recovered = bootstrapEditor(() => storage);
  expect(recovered.store.getState().editor.document).toEqual(fresh);
  session.dispose(); recovered.dispose();
});

it('leaves the old project, artwork and pending save intact when the fresh save fails', async () => {
  vi.useFakeTimers(); const { session, store, storage, deleteAsset } = setup();
  store.dispatch(textAdded({ variantId: 'original', id: 'pending', kind: 'heading', timestamp }));
  const before = store.getState(); storage.setItem.mockImplementationOnce(() => { throw new Error('Quota'); });
  await expect(session.newDesign()).rejects.toThrow('Quota');
  expect(store.getState()).toEqual(before); expect(deleteAsset).not.toHaveBeenCalled();
  vi.runAllTimers(); expect(JSON.parse(storage.getItem(PROJECT_KEY)!)).toEqual(before.editor.document);
  session.dispose();
});

it('retains failed cleanup IDs for retry without resetting the new project again', async () => {
  const { session, store, deleteAsset, records } = setup();
  deleteAsset.mockRejectedValueOnce(new Error('Blocked storage'));
  expect(await session.newDesign()).toBe(false);
  const fresh = store.getState().editor.document;
  expect(records.has('source-art')).toBe(true); expect(records.has('target-art')).toBe(false);
  expect(await session.cleanupArtwork()).toBe(true);
  expect(records.has('source-art')).toBe(false); expect(records.has('unrelated-art')).toBe(true);
  expect(store.getState().editor.document).toBe(fresh); session.dispose();
});

it('collects artwork reachable only through undo, redo or an adaptation source reference', async () => {
  const { projectAssetIds } = await import('../assets/projectAssetIds');
  const { session, store } = setup(); const state = store.getState();
  const historic = (id: string) => ({ ...state.editor.document, variants: [{ ...state.editor.document.variants[0], background: { assetId: id, fit: 'cover' as const, focalPoint: { x: .5, y: .5 } } }] });
  const ids = projectAssetIds({ ...state, editor: { ...state.editor, past: [historic('undo-only')], future: [historic('redo-only')] },
    ai: { status: 'ready', error: '', requestId: 'preview', preview: { variant: historic('preview-only').variants[0], adaptation: { source: historic('reference-only').variants[0], selectionVersion: 0, format: 'landscape' },
      sourceVersion: 0, sourceProjectId: 'old-project', originalPrompt: '', styleBrief: { theme: '', palette: [], motifs: [], mood: '' }, unresolved: [] } } });
  expect([...ids].sort()).toEqual(['preview-only', 'redo-only', 'reference-only', 'source-art', 'target-art', 'undo-only']);
  session.dispose();
});

it('reopens the version that was open before a reload, only for the same project and only if it still exists', () => {
  const { session, store, storage, values } = setup();
  store.dispatch(variantSelected('landscape'));
  session.flush();
  const reloaded = bootstrapEditor(() => storage);
  expect(reloaded.store.getState().ui.activeVariantId).toBe('landscape');
  values.set('frameflow:active-version:v1', JSON.stringify({ projectId: 'another-project', variantId: 'landscape' }));
  expect(bootstrapEditor(() => storage).store.getState().ui.activeVariantId).toBe('original');
  values.set('frameflow:active-version:v1', JSON.stringify({ projectId: 'old-project', variantId: 'deleted-version' }));
  expect(bootstrapEditor(() => storage).store.getState().ui.activeVariantId).toBe('original');
  values.set('frameflow:active-version:v1', '{broken');
  expect(bootstrapEditor(() => storage).store.getState().ui.activeVariantId).toBe('original');
  session.dispose(); reloaded.dispose();
});
