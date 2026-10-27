import { describe, expect, it } from 'vitest';
import { buildVariantLayout, STYLE_PRESETS, validateLayout, validTextChanges, type DetectedWord, type LogoSlot, type ProtectedTemplateView, type StyleVariationView, type TextAnalysis } from '@frameflow/shared';
import { isProjectDocument, isTextElement } from '../../lib/persistence/schema';
import { createEditorStore, selectActiveVariant } from '../../store';
import { textGroupMoved, textGroupUpdated, textPhraseEdited } from '../../store/editorSlice';
import { undo } from '../../store/history';
import { textNodeStyle } from '../text/textGeometry';
import { variationCanvas, variationDocument } from './variationDocument';

const style = (over: Partial<DetectedWord['style']> = {}): DetectedWord['style'] => ({ fontFamily: 'Inter', fontMatch: 'estimated', fontSize: 100, fontWeight: 700, fontStyle: 'normal', color: '#03595a', opacity: 1, lineHeight: 1.2, letterSpacing: 0, baseline: 80, align: 'left', ...over });
const word = (n: number, text: string, box: [number, number, number, number], over: Partial<DetectedWord> = {}): DetectedWord => ({
  id: `pw-${String(n).padStart(10, '0')}`, text, recognized: { text, confidence: 0.95, mode: 'block' }, box: { x: box[0], y: box[1], width: box[2], height: box[3], rotation: 0 },
  normalized: { x: 0, y: 0, width: 0, height: 0 }, elementId: 'pe-0000000001', groupId: 'pg-0000000001', lineId: `pn-000000000${n}`, order: n - 1,
  style: style(), confidence: 0.95, styleConfidence: 0.8, role: 'copy', review: { status: 'approved' }, locked: false, protected: false, origin: 'ocr', ...over,
});
const slot = (n: number, x: number, over: Partial<LogoSlot> = {}): LogoSlot => ({ id: `pl-${String(n).padStart(10, '0')}`, label: `Bank ${n}`, elementId: 'pe-0000000002', box: { x, y: 822, width: 200, height: 76, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 },
  original: { file: `logo-pl-${n}.png`, sha256: 'a'.repeat(64), mime: 'image/png', width: 200, height: 76, bytes: 1, hasAlpha: true, placement: { x, y: 822, width: 200, height: 76 } }, detection: 'tile-grid', confidence: 0.7, order: n, locked: true, replaceable: true, review: { status: 'approved' }, ...over });
function fixture() {
  const words = [
    word(1, 'Easy', [80, 100, 260, 120], { style: style({ fontSize: 120, fontStyle: 'italic', fontFamily: 'Fraunces', baseline: 90 }) }),
    word(2, 'EMI', [80, 230, 700, 290], { style: style({ fontSize: 800, baseline: 288 }) }),
    word(3, 'available.', [80, 560, 460, 80], { style: style({ fontSize: 96, baseline: 78 }) }),
    word(4, 'months', [330, 700, 170, 46], { style: style({ fontSize: 48, baseline: 44 }), groupId: 'pg-0000000002', elementId: 'pe-0000000001', role: 'duration', protected: true, locked: true }),
  ];
  const analysis: TextAnalysis = { version: 1, revision: 2, analyzedAt: '', updatedAt: '', engine: { name: 'fake', version: '1', model: 'm', modes: [], local: true }, basis: { sourceSha256: 's', regionsKey: 'k' }, words,
    groups: [{ id: 'pg-0000000001', elementId: 'pe-0000000001', label: 'Easy EMI available.', align: 'left', lines: [1, 2, 3].map(n => ({ id: `pn-000000000${n}`, wordIds: [words[n - 1].id] })) },
      { id: 'pg-0000000002', elementId: 'pe-0000000001', label: 'months', align: 'left', lines: [{ id: 'pn-0000000004', wordIds: [words[3].id] }] }],
    logoSlots: [slot(1, 80), slot(2, 300, { replacement: { file: 'logo-asset-pl-2.png', sha256: 'b'.repeat(64), mime: 'image/png', width: 200, height: 76, bytes: 1, hasAlpha: true } })], history: [] };
  const element = (id: string, kind: 'text' | 'other') => ({ id, kind, label: id, box: { x: 0, y: 0, width: 900, height: 1200, rotation: 0 }, normalized: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0, representation: 'raster' as const, mask: { mode: 'difference' as const, threshold: 24 }, locked: true, replaceable: true, origin: 'admin' as const, review: { status: 'approved' as const } });
  const template = { schemaVersion: 2, id: 'pt-0123456789ab', name: 'EMI poster', createdAt: '', updatedAt: '', revision: 5, coordinateSystem: 'source-pixels', elementsRevision: 2, layerInstructions: '', runs: [],
    source: { file: 'source.png', inputFile: 'source.png', sha256: 's', mime: 'image/png', width: 900, height: 1200, bytes: 1, orientationNormalized: false, origin: { kind: 'upload' } },
    elements: [element('pe-0000000001', 'text'), element('pe-0000000002', 'other')], textAnalysis: analysis, status: 'ready', problems: [], stale: { base: false, approval: false } } as unknown as ProtectedTemplateView;
  const layout = buildVariantLayout(analysis, { width: 900, height: 1200 }, 'match', STYLE_PRESETS[0]);
  const variation = { schemaVersion: 1, id: 'var_0123456789abcdef0123', batchId: 'vbat_0123456789abcdef0123', index: 0, templateId: template.id, templateName: template.name, createdAt: '', updatedAt: '',
    preset: STYLE_PRESETS[0], customInstructions: null, source: 'ai', provenance: 'ai_generated', status: 'ready', error: null,
    artwork: { url: '/api/template-studio/assets/ast_0123456789abcdef0123', width: 900, height: 1200, sha256: 'c', model: 'gpt-image-2', providerSize: '1024x1360', quality: 'medium', promptVersion: 'v', requestId: null, cachedFrom: null },
    artworkCheck: { status: 'clean', words: [], note: '' }, layout, validation: validateLayout(layout, { analysis }), customTypography: null, confirmedProtectedEdits: [], review: { status: 'selected', history: [] },
    cost: { estimate: { microUsd: 0, usd: '$0', inr: '₹0' }, actual: null, unknown: false }, jobId: null, parent: { templateId: template.id, baseSha256: 'b', analysisRevision: 2, elementsRevision: 2, variationId: null }, children: [] } as StyleVariationView;
  return { template, variation, analysis };
}
function deps() {
  const assets = new Map<string, Blob>(), fetched: string[] = []; let n = 0;
  return { assets, fetched, deps: { file: async (url: string) => { fetched.push(url); return new Blob([url]); }, templateFileUrl: (f: string) => `tpl:${f}`,
    assets: { putAsset: async (id: string, b: Blob) => { assets.set(id, b); }, deleteAsset: async (id: string) => { assets.delete(id); } }, newId: () => `id${n++}`, now: () => '2026-10-20T12:00:00.000Z' } };
}

describe('style variation → editor document', () => {
  it('opens the artwork, every logo slot and every word as its own native text, in variant coordinates', async () => {
    const { template, variation } = fixture(), d = deps(), doc = await variationDocument(template, variation, d.deps);
    expect(isProjectDocument(JSON.parse(JSON.stringify(doc)))).toBe(true);
    const v = doc.variants[0];
    // The 800 px EMI must fit the editor's 512 px limit: the canvas is scaled down, keeping the template's aspect.
    expect(v.canvas.width / v.canvas.height).toBeCloseTo(900 / 1200, 2);
    const s = v.canvas.width / 900;
    expect(800 * s).toBeLessThanOrEqual(512);
    expect(v.layers![0]).toMatchObject({ type: 'image', x: 0, y: 0, width: v.canvas.width, height: v.canvas.height, locked: true, zIndex: 0 });
    expect(v.layers![0].name).toMatch(/AI-generated artwork/);
    const logos = v.layers!.slice(1);
    expect(logos.map(l => l.protectedSlot?.logoSlotId)).toEqual(['pl-0000000001', 'pl-0000000002']);
    expect(logos[0]).toMatchObject({ x: 80 * s, y: 822 * s, role: 'logo', locked: true });
    expect(d.fetched).toEqual(['/api/template-studio/assets/ast_0123456789abcdef0123', 'tpl:logo-pl-1.png', 'tpl:logo-asset-pl-2.png']);
    // Easy, EMI and available. are three separate texts, in reading order, each with its word slot and original style.
    expect(v.elements.map(e => e.text)).toEqual(['Easy', 'EMI', 'available.', 'months']);
    const [easy, emi] = v.elements;
    expect(easy).toMatchObject({ fontFamily: 'Fraunces', fontStyle: 'italic', fill: '#03595a', lineHeight: 1, protectedSlot: { word: { id: 'pw-0000000001', groupId: 'pg-0000000001', order: 0 } } });
    expect(emi.fontSize).toBeCloseTo(800 * s, 6);
    expect(emi.x).toBeCloseTo(80 * s, 6);
    expect(v.elements[3]).toMatchObject({ locked: true, protectedSlot: { word: { protected: true, role: 'duration' } } });
    expect(v.importedFrom).toEqual({ templateId: template.id, resultId: `variation-${variation.id}`, runId: variation.id });
    expect(v.styleVariation).toMatchObject({ variationId: variation.id, provenance: 'ai_generated', presetId: 'original-festive', typographyMode: 'match' });
    expect(textNodeStyle(easy).fontStyle).toBe('italic 700');
  });

  it('removes what it stored when it cannot open the variation', async () => {
    const { template, variation } = fixture(), d = deps();
    await expect(variationDocument({ ...template, elements: [] }, variation, d.deps)).rejects.toThrow(/protected region/);
    expect(d.assets.size).toBe(0);
  });

  it('keeps the canvas size when every word fits the font limit', () => {
    expect(variationCanvas({ width: 900, height: 1200 }, [{ style: { fontSize: 120 } as DetectedWord['style'] }])).toMatchObject({ width: 900, height: 1200 });
  });
});

describe('phrase tools', () => {
  async function store() {
    const { template, variation } = fixture(), doc = await variationDocument(template, variation, deps().deps), s = createEditorStore(doc);
    return { s, variantId: doc.variants[0].id };
  }
  it('restyles, moves and locks a phrase in one undoable step each, leaving its words\' text alone', async () => {
    const { s, variantId } = await store(), at = '2026-10-20T12:00:01.000Z';
    s.dispatch(textGroupUpdated({ variantId, groupId: 'pg-0000000001', changes: { fontFamily: 'Poppins', fill: '#ffffff', fontStyle: 'normal' }, timestamp: at }));
    let v = selectActiveVariant(s.getState());
    expect(v.elements.slice(0, 3).map(e => [e.text, e.fontFamily, e.fill])).toEqual([['Easy', 'Poppins', '#ffffff'], ['EMI', 'Poppins', '#ffffff'], ['available.', 'Poppins', '#ffffff']]);
    expect(v.elements[3].fontFamily).toBe('Inter');
    // Text is never changed by a group style change.
    s.dispatch(textGroupUpdated({ variantId, groupId: 'pg-0000000001', changes: { text: 'x' }, timestamp: at }));
    expect(selectActiveVariant(s.getState()).elements[0].text).toBe('Easy');
    const before = v.elements.slice(0, 3).map(e => [e.x, e.y]);
    s.dispatch(textGroupMoved({ variantId, groupId: 'pg-0000000001', dx: 10, dy: -5, timestamp: at }));
    v = selectActiveVariant(s.getState());
    expect(v.elements.slice(0, 3).map(e => [e.x, e.y])).toEqual(before.map(([x, y]) => [x + 10, y - 5]));
    s.dispatch(undo());
    expect(selectActiveVariant(s.getState()).elements.slice(0, 3).map(e => [e.x, e.y])).toEqual(before);
  });
  it('edits a phrase word by word, adding and removing words in its style', async () => {
    const { s, variantId } = await store(), at = '2026-10-20T12:00:02.000Z';
    s.dispatch(textPhraseEdited({ variantId, groupId: 'pg-0000000001', text: 'Easy EMI now available.', newIds: [{ element: 'new-text-1', word: 'pw-00000000ff' }], timestamp: at }));
    let v = selectActiveVariant(s.getState());
    const phrase = v.elements.filter(e => e.protectedSlot?.word?.groupId === 'pg-0000000001').sort((a, b) => a.protectedSlot!.word!.order - b.protectedSlot!.word!.order);
    expect(phrase.map(e => e.text)).toEqual(['Easy', 'EMI', 'now', 'available.']);
    expect(phrase[3]).toMatchObject({ id: 'new-text-1', fontSize: phrase[2].fontSize, protectedSlot: { word: { id: 'pw-00000000ff' } } });
    expect(v.elements.every(isTextElement)).toBe(true);
    s.dispatch(textPhraseEdited({ variantId, groupId: 'pg-0000000001', text: 'EMI', newIds: [], timestamp: at }));
    v = selectActiveVariant(s.getState());
    expect(v.elements.filter(e => e.protectedSlot?.word?.groupId === 'pg-0000000001').map(e => e.text)).toEqual(['EMI']);
  });
  it('accepts the new text style fields and still reads documents without them', () => {
    expect(validTextChanges({ fontStyle: 'italic', opacity: 0.5, rotation: 12, letterSpacing: 2, lineHeight: 1.1 })).toBe(true);
    expect(validTextChanges({ fontStyle: 'oblique' as never })).toBe(false); expect(validTextChanges({ opacity: 2 })).toBe(false);
    const plain = { id: 't', type: 'text', role: 'custom', text: 'Hi', x: 0, y: 0, width: 100, fontFamily: 'Inter', fontSize: 20, fontWeight: 400, fill: '#000000', align: 'left', lineHeight: 1.2, letterSpacing: 0 };
    expect(isTextElement(plain)).toBe(true);
    expect(isTextElement({ ...plain, fontStyle: 'italic', opacity: 0.4 })).toBe(true);
    expect(isTextElement({ ...plain, opacity: 3 })).toBe(false);
  });
});
