import { describe, expect, it } from 'vitest';
import { recoverablePosition, TEXT_LIMITS, type TextChanges, type TextKind } from '@frameflow/shared';
import { createEditorStore, selectActiveVariant } from './index';
import { canvasResized, textAdded, textUpdated, textMoved, textWidthResized, textDuplicated, textDeleted, textAutoLayoutApplied } from './editorSlice';
import { elementSelected, zoomChanged } from './uiSlice';

const target = { variantId: 'original', id: 'text-1', timestamp: '2026-09-21T06:00:00.000Z' };
function setup(kind: TextKind = 'heading') {
  const store = createEditorStore();
  store.dispatch(textAdded({ ...target, kind }));
  return store;
}

describe('text document operations', () => {
  it('applies Auto Layout atomically, preserves content/style, and no-ops on repeated geometry', () => {
    const store = setup();
    const before = selectActiveVariant(store.getState());
    const layout = { x: 43, y: 43, width: 994, fontSize: 42.125 };
    store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: before.revision, layout }));
    const after = selectActiveVariant(store.getState());
    expect(after.revision).toBe(before.revision + 1);
    expect(after.elements[0]).toEqual({ ...before.elements[0], ...layout });
    const document = store.getState().editor.document;
    store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: after.revision, layout }));
    expect(store.getState().editor.document).toBe(document);
  });
  it('rejects stale layout results and invalid or enlarged typography', () => {
    const store = setup();
    const before = store.getState().editor;
    const layout = { x: 43, y: 43, width: 994, fontSize: 42 };
    store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: 0, layout }));
    for (const changes of [{ x: NaN }, { width: 0 }, { fontSize: 7 }, { fontSize: 73 }]) {
      store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: 1, layout: { ...layout, ...changes } }));
    }
    expect(store.getState().editor).toBe(before);
  });
  it.each(['heading', 'subheading', 'body'] as const)('adds %s with logical, styled defaults and no UI mutation', (kind) => {
    const store = setup(kind);
    const variant = selectActiveVariant(store.getState());
    const element = variant.elements[0];
    expect(element).toMatchObject({ id: target.id, type: 'text', x: 162, width: 756, align: 'center' });
    expect(element.fontSize).toBe(kind === 'heading' ? 72 : kind === 'subheading' ? 38 : 26);
    expect(element.fontFamily).toBe(kind === 'heading' ? 'Lora' : 'Inter');
    expect(element.y).toBeGreaterThan(0);
    expect(element.y).toBeLessThan(1350);
    expect(variant.revision).toBe(1);
    expect(store.getState().ui.selectedElementId).toBeNull();
  });
  it('preserves exact content, whitespace, Unicode, and explicit line breaks', () => {
    const store = setup();
    const text = '  A moment together\n\nAarav & Meera 👩🏽‍🎨\n';
    store.dispatch(textUpdated({ ...target, changes: { text } }));
    expect(selectActiveVariant(store.getState()).elements[0].text).toBe(text);
    store.dispatch(textUpdated({ ...target, changes: { text: '' } }));
    expect(selectActiveVariant(store.getState()).elements[0].text).toBe('');
  });
  it('updates typography without changing coordinates or width', () => {
    const store = setup();
    const before = selectActiveVariant(store.getState()).elements[0];
    const changes: TextChanges = { fontFamily: 'Inter', fontWeight: 700, fontSize: 48, fill: '#aabbcc', align: 'right' };
    store.dispatch(textUpdated({ ...target, changes }));
    expect(selectActiveVariant(store.getState()).elements[0]).toEqual({ ...before, ...changes });
  });
  it.each([{ fontSize: NaN }, { fontSize: Infinity }, { fontSize: 0 }, { fontSize: -1 }, { fontSize: 513 }, { fontFamily: 'Unavailable Font' }, { fill: 'not-a-color' }, { text: 'a'.repeat(5001) }])('rejects invalid changes %o', (changes) => {
    const store = setup();
    const before = store.getState().editor;
    store.dispatch(textUpdated({ ...target, changes }));
    expect(store.getState().editor).toBe(before);
  });
  it('moves using logical coordinates independently of zoom', () => {
    const store = setup();
    for (const zoom of [0.4, 0.6, 1]) {
      store.dispatch(zoomChanged(zoom));
      store.dispatch(textMoved({ ...target, x: 300 + zoom, y: -20 }));
      expect(selectActiveVariant(store.getState()).elements[0]).toMatchObject({ x: 300 + zoom, y: -20 });
    }
    const before = store.getState().editor;
    store.dispatch(textMoved({ ...target, x: Infinity, y: 0 }));
    expect(store.getState().editor).toBe(before);
  });
  it('resizes width and left edge in one revision without changing typography', () => {
    const store = setup();
    const before = selectActiveVariant(store.getState());
    store.dispatch(textWidthResized({ ...target, width: 350, x: 200, y: 430 }));
    const after = selectActiveVariant(store.getState());
    expect(after.elements[0]).toEqual({ ...before.elements[0], width: 350, x: 200, y: 430 });
    expect(after.revision).toBe(before.revision + 1);
    expect('scaleX' in after.elements[0]).toBe(false);
    for (const width of [0, 31, NaN, Infinity, 8193]) {
      store.dispatch(textWidthResized({ ...target, width, x: 200, y: 430 }));
      expect(selectActiveVariant(store.getState())).toBe(after);
    }
  });
  it('duplicates content and styles under a new ID and offset', () => {
    const store = setup();
    const original = selectActiveVariant(store.getState()).elements[0];
    store.dispatch(textDuplicated({ ...target, newId: 'copy', x: original.x + 24, y: original.y + 24 }));
    const [source, copy] = selectActiveVariant(store.getState()).elements;
    expect(source).toEqual(original);
    expect(copy).toEqual({ ...original, id: 'copy', x: original.x + 24, y: original.y + 24 });
    store.dispatch(textUpdated({ ...target, id: 'copy', changes: { text: 'Independent copy' } }));
    expect(selectActiveVariant(store.getState()).elements[0]).toEqual(original);
  });
  it('deletes only the intended element; selection is a separate UI action', () => {
    const store = setup();
    store.dispatch(textAdded({ ...target, id: 'body', kind: 'body' }));
    store.dispatch(elementSelected(target.id));
    store.dispatch(textDeleted(target));
    expect(selectActiveVariant(store.getState()).elements.map((item) => item.id)).toEqual(['body']);
    store.dispatch(elementSelected(null));
    expect(store.getState().ui.selectedElementId).toBeNull();
  });
  it('preserves every text property on canvas resize; selection is not a document edit', () => {
    const store = setup();
    const before = selectActiveVariant(store.getState()).elements;
    store.dispatch(canvasResized({ variantId: 'original', size: { width: 256, height: 256 }, timestamp: target.timestamp }));
    expect(selectActiveVariant(store.getState()).elements).toBe(before);
    const document = store.getState().editor.document;
    store.dispatch(elementSelected(target.id));
    expect(store.getState().editor.document).toBe(document);
    expect(JSON.parse(JSON.stringify(store.getState()))).toEqual(store.getState());
  });
  it('bounds element count and prevents duplicate IDs', () => {
    const store = setup();
    store.dispatch(textAdded({ ...target, kind: 'heading' }));
    expect(selectActiveVariant(store.getState()).elements).toHaveLength(1);
    for (let i = 0; i < TEXT_LIMITS.maxElements + 1; i++) store.dispatch(textAdded({ ...target, id: String(i), kind: 'body' }));
    expect(selectActiveVariant(store.getState()).elements).toHaveLength(TEXT_LIMITS.maxElements);
    store.dispatch(textDuplicated({ ...target, newId: 'overflow', x: 200, y: 400 }));
    expect(selectActiveVariant(store.getState()).elements).toHaveLength(TEXT_LIMITS.maxElements);
  });
});

describe('recoverable positions', () => {
  it('allows partial overflow but retains a selectable strip on all edges', () => {
    const canvas = { width: 1080, height: 1350 };
    const bounds = { width: 500, height: 200 };
    expect(recoverablePosition({ x: -9999, y: -9999 }, bounds, canvas)).toEqual({ x: -476, y: -176 });
    expect(recoverablePosition({ x: 9999, y: 9999 }, bounds, canvas)).toEqual({ x: 1056, y: 1326 });
    expect(recoverablePosition({ x: -10, y: 400 }, bounds, canvas)).toEqual({ x: -10, y: 400 });
  });
});
