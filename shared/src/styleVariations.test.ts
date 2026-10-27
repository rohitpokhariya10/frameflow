import { describe, expect, it } from 'vitest';
import { isCatalogFont } from './fonts/catalog.js';
import { migrateProtectedTemplate, ProtectedSchemaError, type ProtectedTemplate } from './protectedContent.js';
import { analysisProblems, boxIoU, guessWordRole, readingOrder, textTopForBaseline, type DetectedWord, type TextAnalysis, type WordGroup } from './protectedWords.js';
import { buildVariantLayout, contrastRatio, DEFAULT_PRESET_IDS, defaultVariationRequest, estimateTextWidth, retypeLayout, STYLE_PRESETS, typographyFor, validateLayout, variationRequestProblems } from './styleVariations.js';

const style = (over: Partial<DetectedWord['style']> = {}): DetectedWord['style'] => ({ fontFamily: 'Inter', fontMatch: 'estimated', fontSize: 100, fontWeight: 700, fontStyle: 'normal', color: '#03595a', opacity: 1, lineHeight: 1.2, letterSpacing: 0, baseline: 80, align: 'left', ...over });
const word = (n: number, text: string, box: [number, number, number, number], over: Partial<DetectedWord> = {}): DetectedWord => ({
  id: `pw-${String(n).padStart(10, '0')}`, text, recognized: { text, confidence: 0.95, mode: 'block' }, box: { x: box[0], y: box[1], width: box[2], height: box[3], rotation: 0 },
  normalized: { x: box[0] / 900, y: box[1] / 1200, width: box[2] / 900, height: box[3] / 1200 }, elementId: 'pe-0000000001', groupId: 'pg-0000000001', lineId: `pn-000000000${n}`, order: n - 1,
  style: style(), confidence: 0.95, styleConfidence: 0.8, role: 'copy', review: { status: 'approved' }, locked: false, protected: false, origin: 'ocr', ...over,
});
/** Easy / EMI / available. on three lines of one phrase, and a protected tenure on its own. */
function analysis(): TextAnalysis {
  const words = [
    word(1, 'Easy', [80, 100, 260, 120], { style: style({ fontSize: 120, fontStyle: 'italic', fontFamily: 'Fraunces' }) }),
    word(2, 'EMI', [80, 230, 700, 290], { style: style({ fontSize: 400, baseline: 290 }) }),
    word(3, 'available.', [80, 560, 460, 80], { style: style({ fontSize: 96, baseline: 78 }) }),
    word(4, 'months', [330, 700, 170, 46], { style: style({ fontSize: 48, baseline: 44 }), groupId: 'pg-0000000002', role: 'duration', protected: true }),
  ];
  const groups: WordGroup[] = [{ id: 'pg-0000000001', elementId: 'pe-0000000001', label: 'Easy EMI available.', align: 'left', lines: [1, 2, 3].map(n => ({ id: `pn-000000000${n}`, wordIds: [words[n - 1].id] })) },
    { id: 'pg-0000000002', elementId: 'pe-0000000001', label: 'months', align: 'left', lines: [{ id: 'pn-0000000004', wordIds: [words[3].id] }] }];
  return { version: 1, revision: 3, analyzedAt: '', updatedAt: '', engine: { name: 't', version: '1', model: 'm', modes: [], local: true }, basis: { sourceSha256: 's', regionsKey: 'k' }, words, groups, logoSlots: [], history: [] };
}
const canvas = { width: 900, height: 1200 };

describe('protected template schema', () => {
  it('reads schema 1 as schema 2 without changing anything else, and refuses unknown versions', () => {
    const v1 = { schemaVersion: 1, id: 'pt-0123456789ab', elements: [], runs: [] } as unknown as ProtectedTemplate;
    expect(migrateProtectedTemplate(v1)).toEqual({ ...v1, schemaVersion: 2 });
    expect(() => migrateProtectedTemplate({ ...v1, schemaVersion: 3 })).toThrow(ProtectedSchemaError);
  });
});

describe('words', () => {
  it('orders phrases top to bottom and lines and words within them', () => {
    const a = analysis(), shuffled = [a.words[3], a.words[2], a.words[0], a.words[1]];
    expect(readingOrder(shuffled, a.groups).map(w => [w.text, w.order])).toEqual([['Easy', 0], ['EMI', 1], ['available.', 2], ['months', 3]]);
  });
  it('guesses claims, durations and legal text so they are protected', () => {
    expect(guessWordRole('T&Cs', 'text')).toBe('legal'); expect(guessWordRole('months', 'text')).toBe('duration'); expect(guessWordRole('3-6-9-12', 'text')).toBe('duration');
    expect(guessWordRole('25+', 'text')).toBe('claim'); expect(guessWordRole('available.', 'text')).toBe('copy'); expect(guessWordRole('HDFC', 'logo')).toBe('partner');
  });
  it('reports a word with spaces, and a word off the canvas', () => {
    const a = analysis();
    a.words[0] = { ...a.words[0], text: 'Easy EMI' }; a.words[2] = { ...a.words[2], box: { ...a.words[2].box, x: 5000 } };
    const codes = analysisProblems(a, canvas, [{ id: 'pe-0000000001', box: { x: 0, y: 0, width: 900, height: 1200, rotation: 0 }, label: 'Copy' }]).map(p => p.code);
    expect(codes).toEqual(expect.arrayContaining(['INVALID_TEXT', 'OFF_CANVAS']));
  });
  it('places a text box so its first baseline lands on the word\'s baseline', () => {
    expect(textTopForBaseline(500, 100, 1)).toBeCloseTo(500 - 100 * (0.5 + 0.3635), 6);
    expect(boxIoU({ x: 0, y: 0, width: 10, height: 10, rotation: 0 }, { x: 5, y: 0, width: 10, height: 10, rotation: 0 })).toBeCloseTo(1 / 3, 6);
  });
});

describe('style presets and typography', () => {
  it('has four distinct defaults (A–D) and more presets, every font in the licensed catalogue', () => {
    expect(DEFAULT_PRESET_IDS).toEqual(['original-festive', 'premium-minimal', 'modern-fintech', 'creative-promo']);
    const defaults = DEFAULT_PRESET_IDS.map(id => STYLE_PRESETS.find(p => p.id === id)!);
    expect(new Set(defaults.map(p => p.direction)).size).toBe(4);
    expect(new Set(defaults.map(p => JSON.stringify(p.typography))).size).toBe(4);
    expect(STYLE_PRESETS.length).toBeGreaterThan(4);
    for (const p of STYLE_PRESETS) for (const f of [p.typography.headline, p.typography.body, p.typography.accent]) expect(isCatalogFont(f), `${p.id}: ${f}`).toBe(true);
    // No preset tells the model to draw words.
    for (const p of STYLE_PRESETS) expect(p.direction).not.toMatch(/\b(text|headline|letters?|logo)\b/i);
  });
  it('defaults to four AI variations of A–D with the original typography, and validates requests', () => {
    expect(defaultVariationRequest().slots.map(s => [s.presetId, s.source])).toEqual(DEFAULT_PRESET_IDS.map(id => [id, 'ai']));
    expect(variationRequestProblems(defaultVariationRequest('medium', 9))).toEqual([expect.stringMatching(/1–8/)]);
    expect(variationRequestProblems({ ...defaultVariationRequest(), typographyMode: 'custom', customTypography: { headline: 'Not A Font', body: 'Inter', headlineWeight: 700, bodyWeight: 400 } })[0]).toMatch(/catalogue/);
    expect(variationRequestProblems({ ...defaultVariationRequest(), slots: [{ presetId: 'custom', source: 'ai' }] })[0]).toMatch(/custom direction/);
  });
  it('never changes text: match keeps every style, suggested changes fonts only', () => {
    const a = analysis(), preset = STYLE_PRESETS[2];
    const match = typographyFor('match', a.words, preset), suggested = typographyFor('suggested', a.words, preset);
    for (const w of a.words) expect(match.get(w.id)).toEqual(w.style);
    expect(suggested.get(a.words[1].id)!.fontFamily).toBe(preset.typography.headline);
    expect(suggested.get(a.words[3].id)!.fontFamily).toBe(preset.typography.body);
    const layout = buildVariantLayout(a, canvas, 'suggested', preset);
    expect(layout.words.map(w => w.text)).toEqual(a.words.map(w => w.text));
  });
});

describe('variant layouts', () => {
  it('starts from the original boxes in its own copy, and keeps the original record untouched', () => {
    const a = analysis(), before = JSON.stringify(a), layout = buildVariantLayout(a, canvas, 'match', STYLE_PRESETS[0]);
    expect(layout.words.map(w => w.box)).toEqual(a.words.map(w => w.box));
    layout.words[0].box.x = 400;
    expect(JSON.stringify(a)).toBe(before);
    expect(layout.analysisRevision).toBe(3);
  });
  it('reflows a line for a wider font around its anchor, keeping the baseline', () => {
    const a = analysis(), layout = buildVariantLayout(a, canvas, 'custom', STYLE_PRESETS[0], { headline: 'Bebas Neue', body: 'Bebas Neue', headlineWeight: 400, bodyWeight: 400 });
    const emi = layout.words.find(w => w.text === 'EMI')!, original = a.words[1];
    expect(emi.box.x).toBe(original.box.x);
    expect(emi.box.width).toBeLessThan(original.box.width);
    expect(emi.box.y + emi.style.baseline).toBeCloseTo(original.box.y + original.style.baseline, 6);
    const retyped = retypeLayout(layout, a, 'match', STYLE_PRESETS[0]);
    expect(retyped.words.map(w => w.box)).toEqual(a.words.map(w => w.box));
  });
  it('checks every pair for collisions, the canvas, the safe margin, protected text and drawn text', () => {
    const a = analysis(), layout = buildVariantLayout(a, canvas, 'match', STYLE_PRESETS[0]);
    expect(validateLayout(layout, { analysis: a, artworkText: [] })).toMatchObject({ collisionFree: true, checks: { collisions: 'pass', canvas: 'pass', artworkText: 'pass', contrast: 'not_checked' } });
    layout.words[3].box = { ...a.words[2].box };
    layout.words[3].text = 'weeks';
    const v = validateLayout(layout, { analysis: a, artworkText: [{ text: 'SALE', confidence: 0.9 }] });
    expect(v.collisionFree).toBe(false);
    expect(v.issues.map(i => i.code)).toEqual(expect.arrayContaining(['COLLISION', 'PROTECTED_CHANGED', 'TEXT_IN_ARTWORK']));
    expect(validateLayout(layout, { analysis: a, confirmedProtectedEdits: [a.words[3].id] }).issues.find(i => i.code === 'PROTECTED_CHANGED')!.severity).toBe('warning');
    layout.words[0].box = { ...layout.words[0].box, x: 880 };
    expect(validateLayout(layout, { analysis: a }).checks.canvas).toBe('fail');
    expect(validateLayout(buildVariantLayout(a, canvas, 'match', STYLE_PRESETS[0]), { analysis: a, background: new Map([[a.words[0].id, '#04585a']]) }).issues.some(i => i.code === 'LOW_CONTRAST')).toBe(true);
  });
  it('estimates widths and contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
    expect(estimateTextWidth('EMI', { fontFamily: 'Inter', fontSize: 100, fontWeight: 400, fontStyle: 'normal', letterSpacing: 0 })).toBeGreaterThan(estimateTextWidth('EMI', { fontFamily: 'Bebas Neue', fontSize: 100, fontWeight: 400, fontStyle: 'normal', letterSpacing: 0 }));
  });
});
