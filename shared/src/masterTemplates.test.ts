import { describe, expect, it } from 'vitest';
import {
  addRescanFindings, alignGroup, applyRescanFonts, applyTypographyPreset, creativeFromSnapshot, estimateAdvance, guessTextCategory, masterCreativeIssues, reflowLine, rescanChanges, rewriteGroup,
  type CreativeInstance, type MasterSnapshot,
} from './masterTemplates.js';
import { OFFER_FONTS, drawableOfferStyle, offerFace, offerFontsInCatalogue, offerWeights } from './offerFonts.js';
import type { DetectedWord, LogoSlot, TextAnalysis, WordGroup } from './protectedWords.js';

const word = (id: string, text: string, x: number, y: number, size: number, groupId: string, lineId: string, order: number, color = '#03595a'): DetectedWord => ({
  id, text, recognized: { text, confidence: 0.95, mode: 'fixture' }, box: { x, y, width: text.length * size * 0.55, height: size * 0.72, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 },
  elementId: 'pe-0000000001', groupId, lineId, order,
  style: { fontFamily: 'Poppins', fontMatch: 'estimated', fontSize: size, fontWeight: 700, fontStyle: 'normal', color, opacity: 1, lineHeight: 1.2, letterSpacing: 0, baseline: size * 0.72, align: 'left', originDx: -2 },
  confidence: 0.95, styleConfidence: 0.8, role: 'copy', review: { status: 'approved' }, locked: false, protected: false, origin: 'ocr',
});
const groups: WordGroup[] = [
  { id: 'pg-0000000001', elementId: 'pe-0000000001', label: 'Easy EMI available.', lines: [{ id: 'pn-0000000001', wordIds: ['pw-0000000001'] }, { id: 'pn-0000000002', wordIds: ['pw-0000000002'] }, { id: 'pn-0000000003', wordIds: ['pw-0000000003'] }], align: 'left', category: 'headline' },
  { id: 'pg-0000000002', elementId: 'pe-0000000001', label: '3 months', lines: [{ id: 'pn-0000000004', wordIds: ['pw-0000000004', 'pw-0000000005'] }], align: 'left', category: 'offer' },
];
const words = [
  word('pw-0000000001', 'Easy', 280, 440, 230, 'pg-0000000001', 'pn-0000000001', 0),
  word('pw-0000000002', 'EMI', 280, 676, 800, 'pg-0000000001', 'pn-0000000002', 1),
  word('pw-0000000003', 'available.', 280, 1291, 130, 'pg-0000000001', 'pn-0000000003', 2),
  word('pw-0000000004', '3', 350, 1470, 90, 'pg-0000000002', 'pn-0000000004', 3, '#cede59'),
  word('pw-0000000005', 'months', 420, 1470, 90, 'pg-0000000002', 'pn-0000000004', 4, '#cede59'),
];
const slot = (id: string, x: number, category: LogoSlot['category']): LogoSlot => ({ id, label: id, elementId: 'pe-0000000002', box: { x, y: 1840, width: 200, height: 76, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 },
  original: { file: `logo-${id}.png`, sha256: 'x', mime: 'image/png', width: 200, height: 76, bytes: 1, hasAlpha: true, placement: { x, y: 1840, width: 200, height: 76 } }, detection: 'tile-grid', confidence: 0.7, order: 0, locked: false, replaceable: true, review: { status: 'approved' }, category });
const snapshot: MasterSnapshot = {
  schemaVersion: 1, masterId: 'pt-000000000001', revision: 1, publishedAt: '2026-10-20T00:00:00.000Z', name: 'Easy EMI', canvas: { width: 1820, height: 2420 }, source: { file: 'source.jpg', sha256: 'x' },
  background: { file: 'base.png', sha256: 'y', width: 1820, height: 2420, method: 'local-fill', reliability: 'uncertain', acknowledgedEstimate: true }, layers: [], decomposition: null,
  words: [...words, { ...word('pw-0000000009', 'noise', 10, 10, 20, 'pg-0000000001', 'pn-0000000003', 9), review: { status: 'rejected' } }], groups,
  logoSlots: [slot('pl-0000000001', 280, 'partner-logo'), slot('pl-0000000002', 490, 'partner-logo'), { ...slot('pl-0000000003', 700, 'graphic'), review: { status: 'rejected' } }],
  plates: [{ id: 'pp-0000000001', groupId: 'pg-0000000002', box: { x: 300, y: 1450, width: 400, height: 100, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 }, fill: '#025658', stroke: { color: '#c5da61', width: 4 }, radius: 50, confidence: 0.75, review: { status: 'approved' } }],
  analysisRevision: 3,
};
let n = 0;
const newId = (p: string) => `${p}-${String(++n).padStart(10, '0')}`;
const fresh = (): CreativeInstance => creativeFromSnapshot(snapshot, { id: 'cr-000000000001', name: 'c', at: '2026-10-20T00:00:00.000Z', newId });

describe('master templates: creatives', () => {
  it('makes one text per usable word at its saved origin and baseline, one image per usable slot, one shape per plate', () => {
    const c = fresh();
    expect(c.texts.map(t => t.text)).toEqual(['Easy', 'EMI', 'available.', '3', 'months']);
    const emi = c.texts.find(t => t.text === 'EMI')!;
    expect(emi.x).toBe(280 - 2); expect(emi.baselineY).toBe(676 + 800 * 0.72);
    expect(emi.style).toEqual({ fontFamily: 'Poppins', fontWeight: 700, fontStyle: 'normal', fontSize: 800, letterSpacing: 0, color: '#03595a', opacity: 1 });
    expect(c.images.map(i => i.slotId)).toEqual(['pl-0000000001', 'pl-0000000002']);
    expect(c.images[0].asset).toEqual({ kind: 'master', file: 'logo-pl-0000000001.png' });
    expect(c.shapes).toHaveLength(1); expect(c.shapes[0].fill).toBe('#025658');
    expect(c.groups.map(g => [g.category, g.masterGroupId])).toEqual([['headline', 'pg-0000000001'], ['offer', 'pg-0000000002']]);
    // Plates below logos below words.
    expect(Math.max(...c.shapes.map(s => s.z))).toBeLessThan(Math.min(...c.images.map(i => i.z)));
    expect(Math.max(...c.images.map(i => i.z))).toBeLessThan(Math.min(...c.texts.map(t => t.z)));
  });
  it('rewrites a group with more words and lines than the master had, each word its own text, set smaller where a line is too wide', () => {
    const c = fresh(), r = rewriteGroup(c, 'pg-0000000001', 'Get instant\nCASHBACK\non UPI payments today.', estimateAdvance, { newId: () => newId('ct') });
    const head = r.texts.filter(t => t.groupId === 'pg-0000000001');
    expect(head.map(t => t.text)).toEqual(['Get', 'instant', 'CASHBACK', 'on', 'UPI', 'payments', 'today.']);
    expect(new Set(head.map(t => t.id)).size).toBe(7);
    // The first three take the old words' slots; the rest are new.
    expect(head.slice(0, 3).map(t => t.wordId)).toEqual(['pw-0000000001', 'pw-0000000002', 'pw-0000000003']);
    expect(head.slice(3).every(t => t.wordId === null)).toBe(true);
    // Line 2 (CASHBACK in EMI's 800 px style) needs about a third of its size to fit: set at the 55% floor, with a warning.
    expect(r.scale[1]).toBe(0.55);
    expect(r.warnings.join(' ')).toMatch(/Line 2 .*still wider/);
    // With a lower floor every line fits inside the group's original width.
    const width = Math.max(...['Easy', 'EMI', 'available.'].map(t => { const w = c.texts.find(x => x.text === t)!; return w.x + estimateAdvance(w.text, w.style); })) - 278;
    const fitted = rewriteGroup(c, 'pg-0000000001', 'Get instant\nCASHBACK\non UPI payments today.', estimateAdvance, { newId: () => newId('ct'), minScale: 0.2 }).texts.filter(t => t.groupId === 'pg-0000000001');
    for (const line of [0, 1, 2]) { const row = fitted.filter(t => t.line === line); expect(Math.max(...row.map(t => t.x + estimateAdvance(t.text, t.style))) - 278).toBeLessThanOrEqual(width * 1.011); }
    // Other groups unchanged; fewer words than before removes the leftovers.
    const later = (texts: CreativeInstance['texts']) => texts.filter(t => t.groupId === 'pg-0000000002');
    expect(later(r.texts).map(t => ({ ...t, order: 0 }))).toEqual(later(c.texts).map(t => ({ ...t, order: 0 })));
    expect(later(r.texts).map(t => t.order)).toEqual(later(c.texts).map(t => t.order + 4));
    expect(rewriteGroup(c, 'pg-0000000001', 'Sale', estimateAdvance, { newId: () => newId('ct') }).texts.filter(t => t.groupId === 'pg-0000000001').map(t => t.text)).toEqual(['Sale']);
  });
  it('keeps a plate around its rewritten line with the same padding', () => {
    const c = fresh(), r = rewriteGroup(c, 'pg-0000000002', '3 6 9 12 18 24 months', estimateAdvance, { newId: () => newId('ct') });
    expect(r.shapes[0].box.width).toBeGreaterThan(c.shapes[0].box.width);
    expect(r.shapes[0].box.x).toBeCloseTo(c.shapes[0].box.x, 5);
  });
  it('aligns a group to its own extent and spaces a line again', () => {
    const c = fresh(), centred = alignGroup(c, 'pg-0000000001', 'center', estimateAdvance);
    const mid = (t: CreativeInstance['texts'][number]) => t.x + estimateAdvance(t.text, t.style) / 2;
    const mids = centred.texts.filter(t => t.groupId === 'pg-0000000001').map(mid);
    expect(Math.max(...mids) - Math.min(...mids)).toBeLessThan(0.001);
    expect(centred.groups[0].align).toBe('center');
    const long = { ...c, texts: c.texts.map(t => t.text === '3' ? { ...t, text: '3-6-9-12-18-24' } : t) };
    const spaced = reflowLine(long, 'pg-0000000002', 0, estimateAdvance), first = spaced.find(t => t.text === '3-6-9-12-18-24')!, second = spaced.find(t => t.text === 'months')!;
    expect(second.x).toBeGreaterThan(first.x + estimateAdvance(first.text, first.style));
  });
  it('reports overlaps, text off the canvas and fonts without files', () => {
    const c = fresh();
    expect(masterCreativeIssues(c, estimateAdvance).filter(i => i.severity === 'error')).toEqual([]);
    const moved = { ...c, texts: c.texts.map(t => t.text === 'available.' ? { ...t, baselineY: 676 + 400 } : t.text === 'months' ? { ...t, x: 1900 } : t) };
    const codes = masterCreativeIssues(moved, estimateAdvance).map(i => i.code);
    expect(codes).toContain('OVERLAP'); expect(codes).toContain('OUT_OF_CANVAS');
    const font = { ...c, texts: c.texts.map((t, k) => k ? t : { ...t, style: { ...t.style, fontFamily: 'Anton', fontWeight: 700 as const } }) };
    expect(masterCreativeIssues(font, estimateAdvance).map(i => i.code)).toContain('FONT');
  });
  it('applies local typography presets to styles only', () => {
    const c = fresh(), black = applyTypographyPreset(c, 'all-black', snapshot);
    expect(black.every(t => t.style.color === '#000000')).toBe(true);
    expect(black.map(t => [t.text, t.x, t.baselineY])).toEqual(c.texts.map(t => [t.text, t.x, t.baselineY]));
    const geometric = applyTypographyPreset(c, 'geometric', snapshot);
    expect(geometric.find(t => t.text === 'EMI')!.style.fontFamily).toBe('Sora');
    expect(geometric.find(t => t.text === 'months')!.style.fontFamily).toBe('Outfit');
    expect(applyTypographyPreset({ ...c, texts: black }, 'original', snapshot).map(t => t.style.color)).toEqual(c.texts.map(t => t.style.color));
  });
});

describe('master templates: categories and fonts', () => {
  it('guesses categories from text, size and plates, never from fixed phrases', () => {
    const at = (text: string, h: number, plate = false) => guessTextCategory(text, { maxWordHeight: h, posterMaxWordHeight: 500, hasPlate: plate });
    expect(at('T&Cs apply', 30)).toBe('legal');
    expect(at('Mega festive sale', 400)).toBe('headline');
    expect(at('Scan the QR to view all available offers', 50)).toBe('cta');
    expect(at('Up to 50% off', 50)).toBe('offer');
    expect(at('anything', 50, true)).toBe('offer');
    expect(at('On selected credit cards.', 50)).toBe('supporting');
  });
  it('offers 16 families with real files, each in the catalogue, only in weights they have files for', () => {
    expect(OFFER_FONTS).toHaveLength(16);
    expect(offerFontsInCatalogue()).toBe(true);
    expect(offerWeights('Anton')).toEqual([400]);
    expect(drawableOfferStyle('Anton', 700, false)).toEqual({ weight: 400, italic: false });
    expect(drawableOfferStyle('Lora', 700, true)).toEqual({ weight: 700, italic: true });
    expect(drawableOfferStyle('Poppins', 700, true)).toEqual({ weight: 700, italic: false });
    expect(offerFace('Rubik', 600)!.file).toBe('rubik/Rubik-500.ttf');
  });
});

describe('master templates: scan again', () => {
  const analysis = (ws: DetectedWord[], slots: LogoSlot[], revision = 3): TextAnalysis => ({ version: 1, revision, analyzedAt: '', updatedAt: '', engine: { name: 'x', version: '1', model: 'x', modes: [], local: true },
    basis: { sourceSha256: 'x', regionsKey: 'x' }, words: ws, groups, logoSlots: slots, history: [] } as unknown as TextAnalysis);
  const current = analysis([
    ...words.map(w => w.text === 'months' ? { ...w, text: 'months!', style: { ...w.style, fontFamily: 'Anton', fontWeight: 400 as const, fontMatch: 'admin' as const } } : w),
    { ...word('pw-00000000aa', 'Added', 900, 1700, 60, 'pg-0000000002', 'pn-0000000004', 5), origin: 'admin' as const },
  ], [slot('pl-0000000001', 280, 'partner-logo'), slot('pl-0000000002', 490, 'partner-logo')]);
  // The new reading: other fonts on the headline, the T&C read again, a new word, one logo moved, one not found.
  const proposal = analysis([
    ...words.map(w => w.groupId === 'pg-0000000001' ? { ...w, box: { ...w.box, x: w.box.x + 4 }, style: { ...w.style, fontFamily: 'Rubik', fontWeight: 600 as const, fontSize: w.style.fontSize * 1.05, baseline: w.style.baseline + 3, originDx: -6 } } : w),
    word('pw-00000000bb', 'NEW', 300, 1900, 40, 'pg-0000000002', 'pn-0000000004', 6),
  ], [{ ...slot('pl-0000000001', 330, 'partner-logo') }, slot('pl-00000000cc', 700, 'qr')], 4);
  it('lists what a new reading would change, matched by element, and marks fonts picked by hand', () => {
    const c = rescanChanges(current, proposal);
    expect(c.fonts.map(f => [f.text, f.from.fontFamily, f.to.fontFamily, f.to.fontWeight])).toEqual([['Easy', 'Poppins', 'Rubik', 600], ['EMI', 'Poppins', 'Rubik', 600], ['available.', 'Poppins', 'Rubik', 600], ['months!', 'Anton', 'Poppins', 700]]);
    expect(c.fonts.find(f => f.text === 'months!')!.chosen).toBe(true);
    expect(c.fonts.filter(f => f.chosen)).toHaveLength(1);
    expect(c.text).toEqual([{ wordId: 'pw-0000000005', from: 'months!', to: 'months' }]);
    expect(c.missing).toEqual([{ wordId: 'pw-00000000aa', text: 'Added', manual: true }]);
    expect(c.added.map(a => [a.text, a.lineId])).toEqual([['NEW', 'pn-0000000004']]);
    expect(c.logos).toEqual({ added: 1, missing: 1, moved: 1 });
    expect(rescanChanges(current, current)).toEqual({ fonts: [], text: [], added: [], missing: [], plates: [], logos: { added: 0, missing: 0, moved: 0 } });
  });
  it('applies only the chosen words\' fonts, keeping their text, box, colour and review, at the same place on the poster', () => {
    const next = applyRescanFonts(current, proposal, ['pw-0000000002'], '2026-10-20T12:00:00.000Z');
    const before = current.words.find(w => w.id === 'pw-0000000002')!, after = next.words.find(w => w.id === 'pw-0000000002')!, newer = proposal.words.find(w => w.id === 'pw-0000000002')!;
    expect(after.style).toMatchObject({ fontFamily: 'Rubik', fontWeight: 600, fontSize: newer.style.fontSize, fontMatch: 'estimated', color: before.style.color });
    expect(after.box).toEqual(before.box); expect(after.text).toBe(before.text); expect(after.review).toEqual(before.review);
    // Where the text starts and sits: the new reading's place on the poster, measured from the current box.
    expect(after.box.x + after.style.originDx!).toBeCloseTo(newer.box.x + newer.style.originDx!, 1);
    expect(after.box.y + after.style.baseline).toBeCloseTo(newer.box.y + newer.style.baseline, 1);
    // Every other word, the logos and the groups exactly as they were.
    expect(next.words.filter(w => w.id !== 'pw-0000000002')).toEqual(current.words.filter(w => w.id !== 'pw-0000000002'));
    expect(next.logoSlots).toEqual(current.logoSlots); expect(next.groups).toEqual(current.groups);
    expect(next.revision).toBe(current.revision + 1); expect(next.history.at(-1)).toMatchObject({ action: 'corrected', detail: 'Fonts of 1 word(s) from a new scan.' });
    expect(applyRescanFonts(current, proposal, ['pw-00000000aa'], '')).toBe(current);
  });
  it('adds chosen findings to the lines and phrases they belong to: text the first scan missed, and the shape behind it', () => {
    const pill = { id: 'pp-00000000dd', groupId: 'pg-0000000002', box: { x: 300, y: 1450, width: 400, height: 100, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 }, fill: '#000000', stroke: null, radius: 50, confidence: 0.7, review: { status: 'needs-review' as const } };
    const found = { ...proposal, plates: [pill] }, c = rescanChanges(current, found);
    expect(c.plates).toEqual([{ plateId: 'pp-00000000dd', box: pill.box, fill: '#000000', groupId: 'pg-0000000002' }]);
    const next = addRescanFindings(current, found, { wordIds: ['pw-00000000bb'], plateIds: ['pp-00000000dd'] }, '2026-10-20T12:00:00.000Z');
    const added = next.words.find(w => w.id === 'pw-00000000bb')!;
    expect(added).toMatchObject({ text: 'NEW', groupId: 'pg-0000000002', lineId: 'pn-0000000004', review: { status: 'approved' } });
    // The line holds it in reading order (left to right); the phrase's label follows; everything else is as it was.
    const line = next.groups.find(g => g.id === 'pg-0000000002')!.lines[0];
    expect(line.wordIds.map(id => next.words.find(w => w.id === id)!.text)).toEqual(['NEW', '3', 'months!']);
    expect(next.groups.find(g => g.id === 'pg-0000000002')!.label).toBe('NEW 3 months!');
    expect(next.plates).toEqual([expect.objectContaining({ id: 'pp-00000000dd', groupId: 'pg-0000000002', review: expect.objectContaining({ status: 'approved' }) })]);
    expect(next.words.find(w => w.id === 'pw-00000000aa')).toEqual(expect.objectContaining({ text: 'Added', origin: 'admin' }));
    expect(next.revision).toBe(current.revision + 1);
    // Nothing chosen, or nothing that belongs anywhere: unchanged.
    expect(addRescanFindings(current, found, {}, '')).toBe(current);
  });
});
