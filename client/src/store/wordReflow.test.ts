import { describe, expect, it } from 'vitest';
import { estimateTextWidth, type DesignVariant, type TextElement } from '@frameflow/shared';
import { createEditorStore } from './index';
import { decomposedDesignImported, textGroupUpdated, textPhraseEdited, textUpdated } from './editorSlice';
import { restoreProject, saveProject } from '../lib/persistence/projectStorage';

/** A product template's line of three words, each its own text, as the editor opens a creative's words. */
function line(texts: string[], fontSize = 40, rotation = 0) {
  const style = { fontFamily: 'Sora', fontSize, fontWeight: 700 as const, fontStyle: 'normal' as const, letterSpacing: 0 };
  const gap = fontSize * 0.3, elements: TextElement[] = [];
  let x = 100;
  texts.forEach((text, order) => {
    elements.push({ id: `text-w${order}`, type: 'text', role: 'generic-text', name: `Word · ${text}`, text, x, y: 200, width: estimateTextWidth(text, style) + fontSize * 0.6,
      fontFamily: 'Sora', fontSize, fontWeight: 700, fill: '#111111', align: 'left', lineHeight: 1, letterSpacing: 0, zIndex: order, ...(rotation ? { rotation } : {}),
      protectedSlot: { templateId: 'pt-0123456789ab', elementId: 'pe-0123456789', kind: 'text', representation: 'native-text', word: { id: `pw-000000000${order}`, groupId: 'pg-0123456789', lineId: 'pn-0123456789', order } } });
    x += estimateTextWidth(text, style) + gap;
  });
  const variant = { id: 'layerize-words', name: 'Words', revision: 0, canvas: { width: 1200, height: 800, backgroundColor: '#FFFFFF' }, elements, layers: [], productTemplate: true } as unknown as DesignVariant;
  const store = createEditorStore();
  store.dispatch(decomposedDesignImported({ variant, timestamp: '2026-10-23T00:00:00.000Z' }));
  const words = () => store.getState().editor.document.variants.find(v => v.id === 'layerize-words')!.elements as TextElement[];
  expect(words()).toHaveLength(texts.length);
  return { store, words, style, gap };
}
/** Gaps between consecutive words' drawn extents, along x. */
const gaps = (els: TextElement[], style: Parameters<typeof estimateTextWidth>[1]) => els.slice(1).map((w, k) => w.x - (els[k].x + estimateTextWidth(els[k].text, { ...style, fontSize: els[k].fontSize })));

describe('editing a word of a product template keeps its line readable', () => {
  it('a longer word moves the rest of its line; a shorter one closes up; the spaces stay as they were', () => {
    const { store, words, style, gap } = line(['A', 'grand', 'welcome']);
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w1', changes: { text: 'EDITED' }, timestamp: '2026-10-23T00:00:01.000Z' }));
    expect(gaps(words(), style).map(Math.round)).toEqual([Math.round(gap), Math.round(gap)]);
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w1', changes: { text: 'a' }, timestamp: '2026-10-23T00:00:02.000Z' }));
    expect(gaps(words(), style).map(Math.round)).toEqual([Math.round(gap), Math.round(gap)]);
    // The first word never moves.
    expect(words()[0].x).toBe(100);
  });

  it('a bigger size or a phrase typed again does the same', () => {
    const { store, words, style, gap } = line(['Get', '26%', 'cashback']);
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w0', changes: { fontSize: 60 }, timestamp: '2026-10-23T00:00:01.000Z' }));
    expect(gaps(words(), style)[0]).toBeGreaterThan(gap - 1);
    store.dispatch(textPhraseEdited({ variantId: 'layerize-words', groupId: 'pg-0123456789', text: 'Grab 50% CASHBACK', newIds: [], timestamp: '2026-10-23T00:00:02.000Z' }));
    for (const g of gaps(words(), style)) expect(g).toBeGreaterThan(gap - 1);
  });

  it('a rotated line moves along its own direction', () => {
    const { store, words } = line(['grand', 'savings'], 40, 90);
    const before = words()[1];
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w0', changes: { text: 'GRANDEST' }, timestamp: '2026-10-23T00:00:01.000Z' }));
    const after = words()[1];
    // (Built along x, so at 90° the next word is "across" the line; it moves down by the growth, not sideways.)
    expect(Math.round(after.x - before.x)).toBe(0);
    expect(after.y).toBeGreaterThan(before.y);
  });

  it('widths measured as the canvas draws them take the place of the estimate (the store estimates only without them)', () => {
    const { store, words } = line(['A', 'grand', 'welcome']);
    const [, grand, welcome] = words(), measuredBefore = estimateTextWidth('grand', { fontFamily: 'Sora', fontSize: 40, fontWeight: 700, fontStyle: 'normal', letterSpacing: 0 }) + 12;
    // The gap the browser sees: the next word's place past "grand" as drawn (wider than estimated).
    const gap = welcome.x - (grand.x + measuredBefore);
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w1', changes: { text: 'EDITED' }, measured: { 'text-w1': { before: measuredBefore, after: 260 } }, timestamp: '2026-10-23T00:00:01.000Z' }));
    expect(words()[2].x).toBeCloseTo(grand.x + 260 + gap, 6);
    // The edited word's box holds what is drawn.
    expect(words()[1].width).toBeGreaterThanOrEqual(260);
  });

  it('a whole phrase in another font or size keeps its spacing: no word runs into the next', () => {
    const { store, words, style, gap } = line(['Get', '26%', 'cashback']);
    store.dispatch(textGroupUpdated({ variantId: 'layerize-words', groupId: 'pg-0123456789', changes: { fontSize: 80, fontFamily: 'Poppins' }, timestamp: '2026-10-23T00:00:01.000Z' }));
    const after = words();
    expect(after.every(w => w.fontSize === 80 && w.fontFamily === 'Poppins')).toBe(true);
    expect(gaps(after, { ...style, fontFamily: 'Poppins' }).map(Math.round)).toEqual([Math.round(gap), Math.round(gap)]);
    expect(after[0].x).toBe(100);
  });

  it('the reflowed line is what is saved and reopened', () => {
    const { store, words } = line(['A', 'grand', 'welcome']);
    store.dispatch(textUpdated({ variantId: 'layerize-words', id: 'text-w1', changes: { text: 'EDITED' }, timestamp: '2026-10-23T00:00:01.000Z' }));
    const placed = words().map(w => [w.text, w.x, w.y]);
    const storage = new Map<string, string>(), access = () => ({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
    saveProject(access, store.getState().editor.document);
    const reopened = restoreProject(access).document!;
    expect(reopened, 'the saved document is valid').toBeTruthy();
    const again = createEditorStore(reopened).getState().editor.document.variants.find(v => v.id === 'layerize-words')!.elements as TextElement[];
    expect(again.map(w => [w.text, w.x, w.y])).toEqual(placed);
  });
});
