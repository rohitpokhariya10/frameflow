import { describe, expect, it } from 'vitest';
import { createEditorStore, selectActiveVariant } from './index';
import { canvasResized } from './editorSlice';
import { fitRequested, tabChanged, zoomChanged } from './uiSlice';

describe('document and UI boundary', () => {
  it('changes logical dimensions and revision, preserves elements, and rejects invalid actions', () => {
    const store = createEditorStore();
    const before = selectActiveVariant(store.getState());
    const timestamp = '2026-09-21T12:00:00.000Z';
    store.dispatch(canvasResized({ variantId: 'original', size: { width: 1600, height: 900 }, timestamp }));
    const after = selectActiveVariant(store.getState());
    expect(after.canvas).toEqual({ ...before.canvas, width: 1600, height: 900 });
    expect(after.elements).toEqual(before.elements);
    expect(after.revision).toBe(before.revision + 1);
    expect(store.getState().editor.document.updatedAt).toBe(timestamp);
    for (const size of [{ width: NaN, height: 900 }, { width: 4096, height: 4096 }, { width: 0, height: 900 }]) {
      store.dispatch(canvasResized({ variantId: 'original', size, timestamp }));
      expect(selectActiveVariant(store.getState())).toBe(after);
    }
  });
  it('keeps zoom, tab changes, and fit requests out of the document', () => {
    const store = createEditorStore();
    const document = store.getState().editor.document;
    store.dispatch(zoomChanged(0.42));
    store.dispatch(tabChanged('ai'));
    store.dispatch(fitRequested());
    expect(store.getState().editor.document).toBe(document);
    expect(store.getState().ui).toMatchObject({ zoom: 0.42, activeLeftTab: 'ai', fitRequest: 1, selectedElementId: null });
    expect(JSON.parse(JSON.stringify(store.getState()))).toEqual(store.getState());
    store.dispatch(zoomChanged(NaN));
    expect(store.getState().ui.zoom).toBe(0.42);
  });
});
