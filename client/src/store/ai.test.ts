import { describe, expect, it } from 'vitest';
import { createTextElement } from '@frameflow/shared';
import { createEditorStore, type EditorStore } from './index';
import { generationStarted, generationReady, generationFailed, generationCleared, type DesignPreview } from './aiSlice';
import { generatedDesignApplied, textAdded, textUpdated } from './editorSlice';
import { redo, undo } from './history';
import { tabChanged, zoomChanged } from './uiSlice';
import { isProjectDocument } from '../lib/persistence/schema';

const timestamp = '2026-09-21T00:00:00.000Z';
function fixture(store: EditorStore): DesignPreview {
  const state = store.getState();
  const canvas = { width: 1600, height: 900, backgroundColor: '#FFFEFA' };
  return {
    sourceProjectId: state.editor.document.id, sourceVersion: state.editor.version,
    originalPrompt: 'Calm ivory botanical artwork',
    styleBrief: { theme: 'Floral', palette: ['ivory'], motifs: ['botanicals'], mood: 'quiet' }, unresolved: [],
    variant: {
      ...state.editor.document.variants[0], canvas,
      elements: [{ ...createTextElement('heading', canvas, 'generated-title'), role: 'title', text: '  Exact title\n& date  ' }],
      background: { assetId: 'stored-artwork', fit: 'cover', focalPoint: { x: .5, y: .5 } },
      // Metadata-only mock: these unit tests never call a provider.
      generation: { mode: 'live', provider: 'cloudflare', model: 'mocked-provider', promptUsed: 'Artwork only; reserve space.', requestedAspectRatio: '16:9', returnedWidth: 1376, returnedHeight: 768 },
    },
  };
}
function populatedStore() {
  const store = createEditorStore();
  store.dispatch(textAdded({ variantId: 'original', id: 'existing', kind: 'heading', timestamp }));
  return store;
}

describe('AI request metadata and atomic application', () => {
  it('keeps document and history unchanged while generating, previewing, failing or discarding', () => {
    const store = populatedStore();
    const before = store.getState().editor;
    store.dispatch(generationStarted('request-1'));
    expect(store.getState().ai.status).toBe('generating');
    store.dispatch(generationReady({ requestId: 'request-1', preview: fixture(store) }));
    expect(store.getState().ai.status).toBe('ready');
    expect(store.getState().editor).toBe(before);
    store.dispatch(generationCleared());
    store.dispatch(generationStarted('request-2'));
    store.dispatch(generationFailed({ requestId: 'request-2', message: 'Provider unavailable' }));
    expect(store.getState().ai).toMatchObject({ status: 'error', error: 'Provider unavailable', preview: null });
    expect(store.getState().editor).toBe(before);
  });

  it('ignores late successful and failed responses from superseded or cancelled requests', () => {
    const store = createEditorStore();
    const preview = fixture(store);
    store.dispatch(generationStarted('old'));
    store.dispatch(generationStarted('new'));
    const waiting = store.getState().ai;
    store.dispatch(generationReady({ requestId: 'old', preview }));
    store.dispatch(generationFailed({ requestId: 'old', message: 'Old failure' }));
    expect(store.getState().ai).toBe(waiting);
    store.dispatch(generationCleared());
    store.dispatch(generationReady({ requestId: 'new', preview }));
    expect(store.getState().ai).toMatchObject({ status: 'idle', requestId: null, preview: null });
  });

  it('applies all design metadata in one undo step and redoes the exact saved snapshot', () => {
    const store = populatedStore();
    const before = store.getState().editor.document;
    const count = store.getState().editor.past.length;
    const preview = fixture(store);
    store.dispatch(generatedDesignApplied({ preview, timestamp }));
    const applied = store.getState().editor.document;
    expect(applied.variants[0]).toEqual({ ...preview.variant, revision: before.variants[0].revision + 1 });
    expect(applied.variants[0].generation?.provider).toBe('cloudflare');
    expect(applied).toMatchObject({ originalPrompt: preview.originalPrompt, styleBrief: preview.styleBrief, updatedAt: timestamp });
    expect(store.getState().editor.past).toHaveLength(count + 1);
    expect(isProjectDocument(applied)).toBe(true);
    expect(JSON.parse(JSON.stringify(store.getState()))).toEqual(store.getState());
    expect(JSON.stringify(applied)).not.toMatch(/base64|blob:|data:image/);
    store.dispatch(undo());
    expect(store.getState().editor.document).toBe(before);
    store.dispatch(redo());
    expect(store.getState().editor.document).toBe(applied);
    expect(store.getState().ai.requestId).toBeNull();
  });

  it('rejects stale preview after an edit and also after undo returns to the same document revision', () => {
    const store = populatedStore();
    const preview = fixture(store);
    const original = store.getState().editor.document;
    store.dispatch(textUpdated({ variantId: 'original', id: 'existing', timestamp, changes: { text: 'A newer edit' } }));
    const edited = store.getState().editor;
    store.dispatch(generatedDesignApplied({ preview, timestamp }));
    expect(store.getState().editor).toBe(edited);
    store.dispatch(undo());
    expect(store.getState().editor.document).toBe(original);
    const afterUndo = store.getState().editor;
    store.dispatch(generatedDesignApplied({ preview, timestamp }));
    expect(store.getState().editor).toBe(afterUndo);
  });

  it('allows a preview after UI-only changes because they do not modify its source', () => {
    const store = createEditorStore();
    const preview = fixture(store);
    store.dispatch(tabChanged('text'));
    store.dispatch(zoomChanged(.5));
    expect(store.getState().editor.version).toBe(preview.sourceVersion);
    store.dispatch(generatedDesignApplied({ preview, timestamp }));
    expect(store.getState().editor.document.variants[0].background?.assetId).toBe('stored-artwork');
  });

  it('rejects a preview from another project or malformed persisted metadata without adding history', () => {
    const store = createEditorStore();
    const before = store.getState().editor;
    const preview = fixture(store);
    store.dispatch(generatedDesignApplied({ preview: { ...preview, sourceProjectId: 'another-project' }, timestamp }));
    expect(store.getState().editor).toBe(before);
    store.dispatch(generatedDesignApplied({ preview: { ...preview, variant: { ...preview.variant, background: { assetId: 'blob:temporary', fit: 'cover', focalPoint: { x: .5, y: .5 } } } }, timestamp }));
    expect(store.getState().editor).toBe(before);
  });
});
