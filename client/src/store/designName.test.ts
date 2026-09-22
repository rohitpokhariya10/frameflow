import { expect, it } from 'vitest';
import { createEditorStore } from './index';
import { documentRenamed } from './editorSlice';
import { redo, undo } from './history';
import { isProjectDocument } from '../lib/persistence/schema';

const timestamp = '2026-09-22T12:00:00.000Z';

it('renames the existing project field as one undo step without changing variants', () => {
  const store = createEditorStore();
  const original = store.getState().editor.document;
  expect(original.name).toBe('New design');
  store.dispatch(documentRenamed({ name: '  Aarav & Meera  ', timestamp }));
  const renamed = store.getState().editor.document;
  expect(renamed.name).toBe('Aarav & Meera');
  expect(renamed.updatedAt).toBe(timestamp);
  expect(renamed.variants).toBe(original.variants);
  expect(isProjectDocument(renamed)).toBe(true);
  expect(store.getState().editor.past).toHaveLength(1);
  store.dispatch(undo()); expect(store.getState().editor.document).toBe(original);
  store.dispatch(redo()); expect(store.getState().editor.document).toBe(renamed);
});

it.each(['', ' \t\n '])('falls back for an empty name %j and ignores unchanged commits', (name) => {
  const store = createEditorStore();
  store.dispatch(documentRenamed({ name: 'Wedding', timestamp }));
  store.dispatch(documentRenamed({ name, timestamp }));
  expect(store.getState().editor.document.name).toBe('New design');
  const before = store.getState().editor;
  store.dispatch(documentRenamed({ name: '  New design  ', timestamp }));
  expect(store.getState().editor).toBe(before);
});
