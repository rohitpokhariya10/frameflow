import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, textAdded, textUpdated, textAutoLayoutApplied, canvasResized } from '../../store/editorSlice';
import { undo } from '../../store/history';
import { elementSelected, zoomChanged } from '../../store/uiSlice';
import { bootstrapEditor } from './bootstrap';
import { PROJECT_KEY, restoreProject, saveProject, createProjectSaver } from './projectStorage';
import { isProjectDocument } from './schema';
import { CANVAS_PRESETS } from '@frameflow/shared';
const target = { variantId: 'original', id: 'text', timestamp: '2026-09-21T00:00:00.000Z' };
const document = () => createDocument('project', target.timestamp);
function memory() {
  const values = new Map<string, string>();
  return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('validated local recovery and debounced saves', () => {
  it('saves preset dimensions without leaking display-only preset fields', () => {
    const storage = memory(); const session = bootstrapEditor(() => storage);
    session.store.dispatch(canvasResized({ variantId: 'original', size: CANVAS_PRESETS[2], timestamp: target.timestamp }));
    vi.advanceTimersByTime(500);
    expect(session.store.getState().save.status).toBe('saved');
    expect(restoreProject(() => storage).document?.variants[0].canvas).toEqual({ width: 1600, height: 900, backgroundColor: '#FFFEFA' });
    session.dispose();
  });
  it('round-trips version 1 with optional metadata and missing asset references', () => {
    const storage = memory(); const project = document();
    project.variants[0].background = { assetId: 'missing-fixture', fit: 'cover', focalPoint: { x: .5, y: .5 } };
    project.originalPrompt = 'Flowers';
    project.styleBrief = { theme: 'garden', palette: ['green'], motifs: ['leaves'], mood: 'calm' };
    saveProject(() => storage, project);
    expect(restoreProject(() => storage).document).toEqual(project);
  });
  it.each([undefined, 'gemini', 'cloudflare'] as const)('recovers generation metadata with provider %s without changing schema version', (provider) => {
    const storage = memory(); const project = document();
    project.variants[0].generation = {
      mode: 'live', model: 'mocked-provider', promptUsed: 'Flowers', requestedAspectRatio: '4:5',
      returnedWidth: 1024, returnedHeight: 1280, ...(provider === undefined ? {} : { provider }),
    };
    expect(isProjectDocument(project)).toBe(true);
    saveProject(() => storage, project);
    const session = bootstrapEditor(() => storage);
    expect(session.store.getState().editor).toMatchObject({ document: project, past: [], future: [] });
    expect(session.store.getState().editor.document.schemaVersion).toBe(1);
    expect(session.store.getState().editor.document.variants[0].generation?.provider).toBe(provider);
    session.dispose();
  });
  it('rejects unsupported persisted providers without overwriting the stored document', () => {
    for (const provider of ['other', 'Cloudflare', '', null, 42, {}]) {
      const project = document();
      const invalid = { ...project, variants: [{ ...project.variants[0], generation: {
        mode: 'live', provider, model: 'mocked-provider', promptUsed: 'Flowers', requestedAspectRatio: '4:5',
        returnedWidth: 1024, returnedHeight: 1280,
      } }] };
      expect(isProjectDocument(invalid)).toBe(false);
      const storage = memory(); const raw = JSON.stringify(invalid);
      storage.setItem(PROJECT_KEY, raw); storage.setItem.mockClear();
      expect(restoreProject(() => storage).document).toBeUndefined();
      expect(storage.getItem(PROJECT_KEY)).toBe(raw);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });
  it.each(['{invalid', '{}', JSON.stringify({ ...document(), schemaVersion: 2 }), JSON.stringify({ ...document(), variants: [] })])('safely rejects corrupt data %s without overwriting it', (raw) => {
    const storage = memory(); storage.setItem(PROJECT_KEY, raw); storage.setItem.mockClear();
    const session = bootstrapEditor(() => storage);
    expect(session.store.getState().save).toMatchObject({ status: 'error' });
    expect(session.store.getState().save.warning).not.toBe('');
    expect(isProjectDocument(session.store.getState().editor.document)).toBe(true);
    vi.runAllTimers(); expect(storage.setItem).not.toHaveBeenCalled(); session.dispose();
  });
  it('rejects unsupported fonts/enums, nonfinite dimensions, duplicate IDs, and UI/runtime fields', () => {
    const session = bootstrapEditor(() => memory());
    session.store.dispatch(textAdded({ ...target, kind: 'heading' }));
    const valid = session.store.getState().editor.document;
    for (const change of [{ fontFamily: 'Unknown' }, { align: 'justify' }, { x: Infinity }, { width: 0 }, { fontSize: NaN }, { text: 'a'.repeat(5001) }]) {
      const copy = structuredClone(valid); Object.assign(copy.variants[0].elements[0], change);
      expect(isProjectDocument(copy)).toBe(false);
    }
    const duplicate = structuredClone(valid); duplicate.variants[0].elements.push(duplicate.variants[0].elements[0]);
    expect(isProjectDocument(duplicate)).toBe(false);
    expect(isProjectDocument({ ...valid, selectedElementId: 'text' })).toBe(false);
    expect(isProjectDocument({ ...valid, blob: new Blob() })).toBe(false);
    session.dispose();
  });
  it('debounces latest document only, with truthful saving → saved transitions', () => {
    const storage = memory(); const status = vi.fn(); const saver = createProjectSaver(() => storage, status);
    const first = document(), second = { ...first, name: 'Latest' };
    saver.schedule(first); vi.advanceTimersByTime(400); saver.schedule(second);
    vi.advanceTimersByTime(499); expect(storage.setItem).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('saving');
    vi.advanceTimersByTime(1); expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(restoreProject(() => storage).document?.name).toBe('Latest');
    expect(status).toHaveBeenLastCalledWith('saved'); saver.dispose();
  });
  it('handles unavailable storage and setItem failure, then retries on the next edit', () => {
    const session = bootstrapEditor(() => { throw new Error('Denied'); });
    expect(session.store.getState().save.status).toBe('error'); session.dispose();
    const storage = memory(); storage.setItem.mockImplementationOnce(() => { throw new Error('Quota'); });
    const retry = bootstrapEditor(() => storage);
    vi.advanceTimersByTime(500); expect(retry.store.getState().save.status).toBe('error');
    retry.store.dispatch(textAdded({ ...target, kind: 'heading' }));
    expect(retry.store.getState().save.status).toBe('saving');
    vi.advanceTimersByTime(500); expect(retry.store.getState().save.status).toBe('saved'); retry.dispose();
  });
  it('restores text, style, canvas and fitted geometry with empty history and null selection', () => {
    const storage = memory(); const session = bootstrapEditor(() => storage); const store = session.store;
    store.dispatch(textAdded({ ...target, kind: 'heading' }));
    store.dispatch(textUpdated({ ...target, changes: { text: 'Exact\n👩🏽‍🎨', fontFamily: 'Inter', fontWeight: 700, fill: '#285443' } }));
    store.dispatch(canvasResized({ variantId: 'original', size: { width: 1600, height: 900 }, timestamp: target.timestamp }));
    store.dispatch(textAutoLayoutApplied({ ...target, expectedRevision: 3, layout: { x: 36, y: 36, width: 1000, fontSize: 42.125 } }));
    store.dispatch(elementSelected('text')); store.dispatch(zoomChanged(.2));
    vi.advanceTimersByTime(500);
    const snapshot = store.getState().editor.document;
    const writes = storage.setItem.mock.calls.length;
    store.dispatch(elementSelected(null)); store.dispatch(zoomChanged(.4)); vi.runAllTimers();
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    const restored = bootstrapEditor(() => storage);
    expect(restored.store.getState().editor).toMatchObject({ document: snapshot, past: [], future: [] });
    expect(restored.store.getState().ui).toMatchObject({ selectedElementId: null, zoom: 1 });
    store.dispatch(undo()); vi.advanceTimersByTime(500);
    expect(restoreProject(() => storage).document).toEqual(store.getState().editor.document);
    session.dispose(); restored.dispose();
  });
  it('flushes pending edits on request and cancels timers on dispose', () => {
    const storage = memory(); const status = vi.fn(); const saver = createProjectSaver(() => storage, status);
    saver.schedule(document()); saver.flush(); expect(storage.setItem).toHaveBeenCalledTimes(1);
    saver.schedule({ ...document(), name: 'Discard pending' }); saver.dispose(); vi.runAllTimers();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
  it('never marks a newer save request saved from an older completion', () => {
    const storage = memory(); const status = vi.fn();
    const saver = createProjectSaver(() => storage, status);
    const latest = { ...document(), name: 'Newer request' };
    storage.setItem.mockImplementationOnce(() => { saver.schedule(latest); });
    saver.schedule(document()); vi.advanceTimersByTime(500);
    expect(status).toHaveBeenLastCalledWith('saving');
    expect(status.mock.calls.some(([value]) => value === 'saved')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(status).toHaveBeenLastCalledWith('saved');
    expect(restoreProject(() => storage).document).toEqual(latest); saver.dispose();
  });
});
