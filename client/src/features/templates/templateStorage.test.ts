import { expect, it, vi } from 'vitest';
import { addElement, createCreative, createTemplateDraft, createTemplateElement, emptyLibrary, findElement, saveCreative, saveDesignTemplate, setCreativeOverride, setElementLayout, type TemplateLibrary } from '@frameflow/shared';
import { TEMPLATE_LIBRARY_KEY, TEMPLATE_LIBRARY_UNREADABLE_KEY, loadTemplateLibrary, saveTemplateLibrary } from './templateStorage';

const NOW = '2026-09-30T10:00:00.000Z';
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
function library(): TemplateLibrary {
  let draft = createTemplateDraft('tpl-1', NOW, 'Festival Campaign');
  for (const role of ['background', 'hero', 'heading', 'cta'] as const) draft = addElement(draft, createTemplateElement(role, role, 0));
  draft = setElementLayout(draft, 'heading', { x: 0.05, y: 0.05, width: 0.6, height: 0.1 });
  const saved = saveDesignTemplate(emptyLibrary(), draft, NOW);
  const creative = setCreativeOverride(createCreative(saved.template, { id: 'c-1', name: 'Diwali', now: NOW, aspectRatio: '4:5' }), saved.template, 'heading', { text: 'Diwali Offer' }, NOW);
  return saveCreative(saved.library, creative, NOW).library;
}

it('starts empty, and a saved library comes back identical after a reload', () => {
  const storage = memory();
  expect(loadTemplateLibrary(() => storage)).toEqual({ library: emptyLibrary() });
  const saved = library();
  saveTemplateLibrary(() => storage, saved);
  expect([...storage.values.keys()]).toEqual([TEMPLATE_LIBRARY_KEY]);
  // A reload: nothing but the stored text survives.
  const reloaded = loadTemplateLibrary(() => memory(Object.fromEntries(storage.values)));
  expect(reloaded).toEqual({ library: saved });
  expect(findElement(reloaded.library.templates[0], 'heading')!.layout).toEqual({ x: 0.05, y: 0.05, width: 0.6, height: 0.1, rotation: 0 });
  expect(reloaded.library.creatives[0]).toMatchObject({ templateId: 'tpl-1', templateVersion: 1, aspectRatio: '4:5', contentOverrides: { heading: { text: 'Diwali Offer' } } });
  // Saving what was loaded writes the same text.
  const again = memory();
  saveTemplateLibrary(() => again, reloaded.library);
  expect(again.values.get(TEMPLATE_LIBRARY_KEY)).toBe(storage.values.get(TEMPLATE_LIBRARY_KEY));
});

it('keeps unreadable stored text aside instead of overwriting it', () => {
  const storage = memory({ [TEMPLATE_LIBRARY_KEY]: '{"templates": [oops' });
  const loaded = loadTemplateLibrary(() => storage);
  expect(loaded.library).toEqual(emptyLibrary());
  expect(loaded.warning).toContain('could not be read');
  expect(storage.values.get(TEMPLATE_LIBRARY_UNREADABLE_KEY)).toBe('{"templates": [oops');
  // Saving the new library later replaces only the main key.
  saveTemplateLibrary(() => storage, library());
  expect(storage.values.get(TEMPLATE_LIBRARY_UNREADABLE_KEY)).toBe('{"templates": [oops');
});

it('loads the valid templates when one stored entry is malformed, reports it, and writes it back untouched', () => {
  const stored = JSON.parse(JSON.stringify({ schemaVersion: 1, templates: library().templates, creatives: library().creatives })) as { templates: { id: string }[]; creatives: unknown[] };
  const broken = { ...stored.templates[0], id: 'tpl-broken', supportedAspectRatios: ['1:1', '2:3'] };
  stored.templates.push(broken);
  const storage = memory({ [TEMPLATE_LIBRARY_KEY]: JSON.stringify(stored) });
  const loaded = loadTemplateLibrary(() => storage);
  expect(loaded.library.templates.map(template => template.id)).toEqual(['tpl-1']);
  expect(loaded.library.creatives).toHaveLength(1);
  expect(loaded.warning).toContain('1 saved item could not be read and is left untouched in storage: template (supportedAspectRatios: Invalid aspect ratio "2:3"');
  saveTemplateLibrary(() => storage, loaded.library);
  expect(JSON.parse(storage.values.get(TEMPLATE_LIBRARY_KEY)!).templates).toEqual(stored.templates);
});

it('reports unavailable storage and a refused write', () => {
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  expect(loadTemplateLibrary(() => blocked)).toMatchObject({ library: emptyLibrary(), warning: expect.stringContaining('storage is unavailable') });
  expect(() => saveTemplateLibrary(() => blocked, library())).toThrow('quota');
});
