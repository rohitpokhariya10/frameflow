import { describe, expect, it } from 'vitest';
import { createTextElement } from '@frameflow/shared';
import { createEditorStore } from './index';
import { createDocument, adaptedDesignApplied, textUpdated } from './editorSlice';
import { generationReady, generationStarted, type DesignPreview } from './aiSlice';
import { variantSelected } from './uiSlice';
import { undo, redo } from './history';
import { isProjectDocument } from '../lib/persistence/schema';
import { bootstrapEditor } from '../lib/persistence/bootstrap';
import { PROJECT_KEY } from '../lib/persistence/projectStorage';
const timestamp = '2026-09-22T00:00:00Z';
function fixture() {
  const document = createDocument('project', timestamp), source = document.variants[0];
  source.background = { assetId: 'source-asset', fit: 'cover', focalPoint: { x: .5, y: .5 } };
  source.elements = [{ ...createTextElement('heading', source.canvas, 'title'), text: '  Aarav & Meera\n♥  ' }];
  const store = createEditorStore(document);
  const preview: DesignPreview = { sourceProjectId: document.id, sourceVersion: 0, originalPrompt: 'Flowers', styleBrief: { theme: 'Wedding', palette: [], motifs: [], mood: 'Calm' }, unresolved: [],
    adaptation: { source, selectionVersion: 0, format: 'landscape' },
    variant: { ...source, id: 'landscape', name: 'Landscape', sourceVariantId: source.id, canvas: { width: 1600, height: 900, backgroundColor: '#FFFEFA' },
      background: { ...source.background, assetId: 'target-asset' },
      generation: { mode: 'live', provider: 'cloudflare', sourceAssetId: 'source-asset', promptUsed: 'Artwork only', requestedAspectRatio: '16:9', returnedWidth: 1024, returnedHeight: 576 } } };
  return { store, source, preview };
}
describe('adaptation variants and history', () => {
  it('previews without mutation, appends atomically, selects target, undoes and redoes with asset IDs only', () => {
    const { store, source, preview } = fixture(), before = store.getState().editor.document;
    store.dispatch(generationStarted('mock')); store.dispatch(generationReady({ requestId: 'mock', preview }));
    expect(store.getState().editor.document).toBe(before); expect(store.getState().editor.past).toHaveLength(0);
    store.dispatch(adaptedDesignApplied({ preview, timestamp }));
    const applied = store.getState().editor.document;
    expect(applied.variants).toEqual([source, preview.variant]); expect(applied.variants[0]).toBe(source);
    expect(store.getState().ui.activeVariantId).toBe('landscape'); expect(store.getState().editor.past).toHaveLength(1);
    expect(isProjectDocument(applied)).toBe(true); expect(JSON.stringify(applied)).not.toMatch(/base64|blob:|data:image/);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before); expect(store.getState().ui.activeVariantId).toBe(source.id);
    store.dispatch(redo()); expect(store.getState().editor.document).toBe(applied); expect(store.getState().ui.activeVariantId).toBe('landscape');
    expect(store.getState().ai.requestId).toBe('mock');
  });
  it('rejects source edits, undo-to-same-revision, and variant switch-away-and-back', () => {
    const { store, preview, source } = fixture();
    store.dispatch(textUpdated({ variantId: source.id, id: 'title', timestamp, changes: { text: 'Changed' } }));
    store.dispatch(adaptedDesignApplied({ preview, timestamp })); expect(store.getState().editor.document.variants).toHaveLength(1);
    store.dispatch(undo()); store.dispatch(adaptedDesignApplied({ preview, timestamp })); expect(store.getState().editor.document.variants).toHaveLength(1);
    const fresh = fixture(); fresh.store.dispatch(adaptedDesignApplied({ preview: fresh.preview, timestamp }));
    fresh.store.dispatch(variantSelected('original'));
    const state = fresh.store.getState(), next = { ...fresh.preview, sourceVersion: state.editor.version, adaptation: { ...fresh.preview.adaptation!, selectionVersion: state.ui.selectionVersion }, variant: { ...fresh.preview.variant, id: 'third' } };
    fresh.store.dispatch(variantSelected('landscape')); fresh.store.dispatch(variantSelected('original'));
    fresh.store.dispatch(adaptedDesignApplied({ preview: next, timestamp })); expect(fresh.store.getState().editor.document.variants).toHaveLength(2);
  });
  it('rejects changed or removed wording and wrong project without creating history', () => {
    for (const change of ['text', 'removed', 'project']) {
      const { store, preview } = fixture();
      if (change === 'text') preview.variant = { ...preview.variant, elements: preview.variant.elements.map((e) => ({ ...e, text: 'Rewritten' })) };
      if (change === 'removed') preview.variant = { ...preview.variant, elements: [] };
      if (change === 'project') preview.sourceProjectId = 'wrong';
      store.dispatch(adaptedDesignApplied({ preview, timestamp })); expect(store.getState().editor.past).toHaveLength(0);
    }
  });
  it('restores both variants, source relationships and assets with the existing v1 schema', () => {
    const { store, preview } = fixture(); store.dispatch(adaptedDesignApplied({ preview, timestamp }));
    const document = store.getState().editor.document;
    const session = bootstrapEditor(() => ({ getItem: (key) => key === PROJECT_KEY ? JSON.stringify(document) : null, setItem: () => undefined }));
    expect(session.store.getState().editor.document).toEqual(document);
    expect(session.store.getState().editor.document.variants.map((v) => v.background?.assetId)).toEqual(['source-asset', 'target-asset']);
    expect(session.store.getState().editor.past).toEqual([]); session.dispose();
  });
});
