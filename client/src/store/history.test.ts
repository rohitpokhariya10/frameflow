import { describe, expect, it } from 'vitest';
import { createEditorStore } from './index';
import { textAdded, textDeleted, textDuplicated, textUpdated, textMoved, textWidthResized, textAutoLayoutApplied, canvasResized } from './editorSlice';
import { undo, redo, endTextSession, HISTORY_LIMIT } from './history';
import { elementSelected, tabChanged, zoomChanged, fitRequested } from './uiSlice';
import { saveStatusChanged } from './saveSlice';
const target = { variantId: 'original', id: 'text', timestamp: '2026-09-21T00:00:00.000Z' };
function setup() {
  const store = createEditorStore();
  store.dispatch(textAdded({ ...target, kind: 'heading' }));
  return store;
}
describe('bounded document history', () => {
  it('undoes add and redoes the exact snapshot, clearing invalid selection', () => {
    const store = setup();
    const added = store.getState().editor.document;
    store.dispatch(elementSelected('text'));
    store.dispatch(undo());
    expect(store.getState().editor.document.variants[0].elements).toHaveLength(0);
    expect(store.getState().ui.selectedElementId).toBeNull();
    store.dispatch(redo());
    expect(store.getState().editor.document).toBe(added);
  });
  it('undoes canvas dimensions', () => {
    const store = setup(); const before = store.getState().editor.document;
    store.dispatch(canvasResized({ variantId: 'original', size: { width: 1600, height: 900 }, timestamp: target.timestamp }));
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before);
  });
  it('undoes deletion and duplication', () => {
    const store = setup(); const before = store.getState().editor.document;
    store.dispatch(textDeleted(target)); store.dispatch(undo());
    expect(store.getState().editor.document).toBe(before);
    store.dispatch(textDuplicated({ ...target, newId: 'copy', x: 200, y: 200 }));
    expect(store.getState().editor.document.variants[0].elements).toHaveLength(2);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before);
  });
  it('undoes and redoes Auto Layout as one exact snapshot without recomputing', () => {
    const store = setup(); const before = store.getState().editor.document;
    store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: 1, layout: { x: 43, y: 43, width: 994, fontSize: 42.123 } }));
    const fitted = store.getState().editor.document;
    expect(store.getState().editor.past).toHaveLength(2);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before);
    store.dispatch(redo()); expect(store.getState().editor.document).toBe(fitted);
  });
  it('records position and width commits separately and exactly once', () => {
    const store = setup(); const before = store.getState().editor.document;
    store.dispatch(textMoved({ ...target, x: 300, y: 400 }));
    const moved = store.getState().editor.document;
    store.dispatch(textWidthResized({ ...target, x: 320, y: 400, width: 500 }));
    expect(store.getState().editor.past).toHaveLength(3);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(moved);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before);
  });
  it('groups live typing, with blur and pause boundaries', () => {
    const store = setup(); const before = store.getState().editor.document;
    for (let i = 1; i <= 20; i++) store.dispatch(textUpdated({ ...target, changes: { text: 'a'.repeat(i) }, timestamp: new Date(Date.parse(target.timestamp) + i * 50).toISOString() }));
    expect(store.getState().editor.past).toHaveLength(2);
    store.dispatch(undo()); expect(store.getState().editor.document).toBe(before);
    store.dispatch(redo()); store.dispatch(endTextSession());
    store.dispatch(textUpdated({ ...target, changes: { text: 'new session' } }));
    expect(store.getState().editor.past).toHaveLength(3);
    store.dispatch(textUpdated({ ...target, changes: { text: 'after pause' }, timestamp: '2026-09-21T00:00:03.000Z' }));
    expect(store.getState().editor.past).toHaveLength(4);
  });
  it('does not coalesce typography or edits on another element', () => {
    const store = setup();
    store.dispatch(textUpdated({ ...target, changes: { fontSize: 48 } }));
    store.dispatch(textUpdated({ ...target, changes: { fontSize: 42 } }));
    expect(store.getState().editor.past).toHaveLength(3);
    store.dispatch(undo()); expect(store.getState().editor.document.variants[0].elements[0].fontSize).toBe(48);
  });
  it('invalidates redo on a new edit, but preserves it for no-ops', () => {
    const store = setup();
    store.dispatch(textMoved({ ...target, x: 1, y: 2 })); store.dispatch(undo());
    store.dispatch(textUpdated({ ...target, changes: { fontSize: 72 } }));
    expect(store.getState().editor.future).toHaveLength(1);
    store.dispatch(textUpdated({ ...target, changes: { fontSize: 48 } }));
    expect(store.getState().editor.future).toHaveLength(0);
  });
  it('bounds history to 30 operations and makes exhausted undo/redo no-ops', () => {
    const store = setup();
    for (let i = 0; i < 50; i++) store.dispatch(textMoved({ ...target, x: i, y: 400 }));
    expect(store.getState().editor.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < 30; i++) store.dispatch(undo());
    const oldest = store.getState().editor;
    store.dispatch(undo()); expect(store.getState().editor).toBe(oldest);
    expect(oldest.future).toHaveLength(30);
    for (let i = 0; i < 30; i++) store.dispatch(redo());
    const latest = store.getState().editor;
    store.dispatch(redo()); expect(store.getState().editor).toBe(latest);
  });
  it('excludes selection, zoom, Fit, tabs and save status from history', () => {
    const store = setup(); const before = store.getState().editor;
    store.dispatch(elementSelected('text')); store.dispatch(zoomChanged(.5));
    store.dispatch(fitRequested()); store.dispatch(tabChanged('text')); store.dispatch(saveStatusChanged('saved'));
    expect(store.getState().editor).toBe(before);
  });
});
