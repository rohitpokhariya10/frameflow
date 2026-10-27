import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { DetectedWord, SceneDescription } from '@frameflow/shared';
import type { Rgba } from '../pixels.js';
import { fakeRecognizer } from '../../../textRecognition/recognizer.js';
import { fitLines, letterColumns, lineLimits, lineShift } from './wordFit.js';
import { fakeProductAnalyzer, PRODUCT_WORDS, productPosterPng } from './productPoster.fixture.js';
import { setup, type View } from './productServer.fixture.js';

// AI word boxes fitted to the letters they name (wordFit.ts), on synthetic pictures: words are rows of dark letter
// strokes on a light page, optionally over a faint diagonal pattern (the creative's diamond background); the recognizer
// is the offline fake, reading the words where they really are. Everything runs here; no provider is involved.
type Box = { x: number; y: number; width: number; height: number };
type Word = Box & { text: string };
const PAGE = [234, 246, 238], INK = [24, 24, 24], PATTERN = [188, 212, 197];

function picture(width: number, height: number, words: Word[], extra: { pattern?: boolean; rules?: Box[] } = {}): Rgba {
  const data = new Uint8Array(width * height * 4);
  const paint = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, extra.pattern && ((x + y) % 24 < 2 || (x - y + 2400) % 24 < 2) ? PATTERN : PAGE);
  for (const w of words) {
    // One stroke a letter: a vertical bar, every other letter with a bar across its top.
    const n = Math.max(1, w.text.length), pitch = w.width / n, stroke = Math.max(2, Math.round(w.height * 0.12));
    for (let k = 0; k < n; k++) {
      const x0 = Math.round(w.x + k * pitch + pitch * 0.2);
      for (let y = Math.round(w.y + w.height * 0.15); y < Math.round(w.y + w.height * 0.85); y++) for (let x = x0; x < x0 + stroke; x++) paint(x, y, INK);
      if (k % 2) for (let y = Math.round(w.y + w.height * 0.15); y < Math.round(w.y + w.height * 0.15) + stroke; y++) for (let x = x0; x < Math.round(x0 + pitch * 0.6); x++) paint(x, y, INK);
    }
  }
  for (const r of extra.rules ?? []) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) paint(x, y, INK);
  return { width, height, data } as Rgba;
}
const line = (y: number, height: number, ...spans: [string, number, number][]): Word[] => spans.map(([text, x, width]) => ({ text, x, y, width, height }));
const reader = (words: Word[]) => fakeRecognizer(words.map(w => ({ text: w.text, confidence: 0.95, box: { x: w.x, y: w.y, width: w.width, height: w.height } })));
const ai = (words: Word[], move: (w: Word, left: number) => Box) => { const left = Math.min(...words.map(w => w.x)); return words.map(w => ({ text: w.text, box: move(w, left) })); };
const close = (a: Box, b: Box, px = 1) => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every(d => Math.abs(d) <= px);

describe('fitting AI text lines to their letters', () => {
  it('moves a raised, squeezed line onto its letters when the recognizer reads them', async () => {
    const truth = line(120, 40, ['Grand', 100, 150], ['Savings', 270, 210], ['today', 500, 140]);
    const given = ai(truth, (w, left) => ({ x: left + (w.x - left) * 0.88, y: w.y - 18, width: w.width * 0.88, height: w.height }));
    const [fit] = await fitLines(picture(800, 300, truth), [given], reader(truth));
    expect(fit.method).toBe('letters');
    fit.boxes.forEach((b, k) => expect(close(b, truth[k]), JSON.stringify([b, truth[k]])).toBe(true));
    expect(fit.dy).toBe(18);
  });

  it('keeps a short line between two longer ones sharing its words on its own letters', async () => {
    const above = line(100, 40, ['offers', 60, 130], ['across', 210, 130], ['leading', 360, 150], ['festive', 530, 150]);
    const short = line(160, 40, ['offers', 230, 130], ['across', 380, 130], ['leading', 530, 150]);
    const below = line(220, 40, ['offers', 80, 130], ['waiting', 230, 150], ['leading', 400, 150], ['brands', 570, 140]);
    const image = picture(800, 320, [...above, ...short, ...below]), raised = ai(short, w => ({ ...w, y: w.y - 30 }));
    // Read by the recognizer: its own letters, though the same words stand on the lines above and below.
    const read = await fitLines(image, [above.map(w => ({ text: w.text, box: w })), raised, below.map(w => ({ text: w.text, box: w }))], reader([...above, ...short, ...below]));
    read[1].boxes.forEach((b, k) => expect(close(b, short[k])).toBe(true));
    expect(read[0].moved).toBeLessThanOrEqual(1);
    expect(read[2].moved).toBeLessThanOrEqual(1);
    // By its strokes alone: never onto the line above (at most into the gap), and onto its letters or left as it is.
    const strokes = await fitLines(image, [above.map(w => ({ text: w.text, box: w })), raised, below.map(w => ({ text: w.text, box: w }))]);
    expect(strokes[1].dy).toBeGreaterThanOrEqual(0);
    if (strokes[1].method !== 'kept') expect(Math.abs(strokes[1].dy - 30)).toBeLessThanOrEqual(3);
  });

  it('places a line it cannot read by its letter strokes, through a faint background pattern', async () => {
    const truth = line(140, 44, ['Shop', 90, 120], ['across', 230, 160], ['brands', 410, 170]), lowered = ai(truth, w => ({ ...w, y: w.y + 18 }));
    const [fit] = await fitLines(picture(720, 320, truth, { pattern: true }), [lowered]);
    expect(fit.method).toBe('strokes');
    expect(Math.abs(fit.dy + 18)).toBeLessThanOrEqual(2);
    fit.boxes.forEach((b, k) => expect(close(b, truth[k], 3)).toBe(true));
  });

  it('leaves boxes that already sit on their letters', async () => {
    const truth = line(100, 40, ['Valid', 80, 130], ['till', 230, 90], ['Sunday', 340, 160]), given = truth.map(w => ({ text: w.text, box: { ...w } }));
    const image = picture(640, 240, truth, { pattern: true });
    const [read] = await fitLines(image, [given], reader(truth)), [strokes] = await fitLines(image, [given]);
    expect(read.moved).toBeLessThanOrEqual(1);
    expect(strokes.method).toBe('kept');
    expect(strokes.boxes).toEqual(given.map(g => g.box));
  });

  it('works at the picture\'s edges', async () => {
    const top = line(6, 30, ['Top', 0, 90], ['edge', 110, 120]), right = line(200, 30, ['Right', 470, 110], ['edge', 600, 40]);
    const image = picture(640, 236, [...top, ...right]);
    const fits = await fitLines(image, [ai(top, w => ({ ...w, y: 0 })), ai(right, w => ({ ...w, y: w.y + 6 }))], reader([...top, ...right]));
    for (const f of fits) for (const b of f.boxes) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(640); expect(b.y + b.height).toBeLessThanOrEqual(236); }
    fits[0].boxes.forEach((b, k) => expect(close(b, top[k])).toBe(true));
    // Without the recognizer either: no error, and nothing outside the picture.
    for (const f of await fitLines(image, [ai(top, w => ({ ...w, y: 0 })), ai(right, w => ({ ...w, y: w.y + 6 }))])) for (const b of f.boxes) expect(b.y).toBeGreaterThanOrEqual(0);
  });

  it('keeps a line with no letters to find, or with two places that fit as well', async () => {
    const words = line(120, 40, ['Hello', 100, 140], ['there', 260, 140]);
    // Nothing printed: no letters, no strokes.
    const [blank] = await fitLines(picture(600, 300, []), [ai(words, w => ({ ...w }))], reader([]));
    expect(blank).toMatchObject({ method: 'kept', moved: 0 });
    // The same line printed twice, 60 px apart; the analysis's line exactly between them.
    const twice = [...line(90, 40, ['Hello', 100, 140], ['there', 260, 140]), ...line(150, 40, ['Hello', 100, 140], ['there', 260, 140])];
    const between = ai(words, w => ({ ...w })), image = picture(600, 300, twice);
    const [read] = await fitLines(image, [between], reader(twice)), [strokes] = await fitLines(image, [between]);
    expect(read.method === 'letters').toBe(false);
    expect(read.reason ?? '').toMatch(/ambiguous|clearly better/);
    expect(strokes.method).toBe('kept');
  });

  it('keeps a rule read with a word out of the word\'s box', async () => {
    // "of" read together with the rule beside it, three times as wide as its letters: its edges come from its letters.
    const truth = line(100, 50, ['A', 100, 40], ['season', 160, 240], ['of', 420, 70]), rule = { x: 495, y: 124, width: 160, height: 4 };
    const image = picture(800, 260, truth, { rules: [rule] }), given = ai(truth, w => ({ ...w, y: w.y - 10 }));
    const read = [...truth.slice(0, 2), { ...truth[2], width: rule.x + rule.width - truth[2].x }];
    const [fit] = await fitLines(image, [given], reader(read));
    expect(fit.method).toBe('letters');
    const of = fit.boxes[2];
    expect(of.x + of.width).toBeLessThan(rule.x + 8);
    expect(of.x + of.width).toBeGreaterThan(truth[2].x + truth[2].width * 0.6);
    expect(letterColumns(image, { x: 420, y: 100, width: 240, height: 50 })).toEqual([expect.any(Number), expect.any(Number)]);
    const [first, last] = letterColumns(image, { x: 420, y: 100, width: 240, height: 50 })!;
    expect(first).toBeGreaterThanOrEqual(420); expect(last).toBeLessThanOrEqual(rule.x + 2);
  });

  it('never lets a line move onto another one, and gives the same answer every time', async () => {
    const a = line(100, 40, ['First', 100, 150]), b = line(150, 40, ['Second', 100, 180]);
    const limits = lineLimits([a, b]);
    expect(limits[0].down).toBeLessThanOrEqual(10 + 20);
    expect(limits[1].up).toBeLessThanOrEqual(10 + 20);
    const image = picture(500, 300, [...a, ...b], { pattern: true }), given = [ai(a, w => ({ ...w, y: w.y - 12 })), ai(b, w => ({ ...w, y: w.y - 12 }))];
    expect(await fitLines(image, given, reader([...a, ...b]))).toEqual(await fitLines(image, given, reader([...a, ...b])));
    expect(lineShift(image, given[1].map(g => g.box), limits[1])).toEqual(lineShift(image, given[1].map(g => g.box), limits[1]));
  });
});

describe('fitting text in a template', { timeout: 120_000 }, () => {
  // The poster's own text lines, as the AI analysis would list them; two lines raised and squeezed, the legal line right.
  const LINES = [{ group: 'headline', id: 'h1', role: 'headline', words: ['Grand', 'Savings'] }, { group: 'offer', id: 'o1', role: 'offer', words: ['Get', '26%', 'cashback'] }, { group: 'legal', id: 'l1', role: 'legal', words: ['T&Cs', 'apply'] }];
  const truth = (text: string) => PRODUCT_WORDS.find(w => w.text === text)!.box;
  const analyzer = () => {
    const base = fakeProductAnalyzer();
    const a = { model: 'offline-test-analyser', calls: 0, async analyze(image: Buffer, mime: string, save: (file: string, value: object) => void) {
      a.calls++;
      const scene = await base.analyze(image, mime, save);
      const words = LINES.flatMap(l => { const left = Math.min(...l.words.map(t => truth(t).x)); return l.words.map((t, k) => { const b = truth(t);
        const box = l.group === 'legal' ? b : { x: left + (b.x - left) * 0.9, y: b.y - b.height * 0.45, width: b.width * 0.9, height: b.height };
        return { id: `${l.id}-${k}`, text: t, group: l.group, line: l.id, role: l.role, confidence: 0.95, z: 10, box: { ...box, rotation: 0 } }; }); });
      return { ...scene, words } as SceneDescription;
    } };
    return a;
  };
  const shape = (b: Box) => ({ x: b.x, y: b.y, width: b.width, height: b.height });

  it('fits the AI words while detecting, and fits an older template\'s text only when asked', async () => {
    const s = await setup({ analyzer: analyzer() });
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Fit' });
      let v = await s.detected(made.body.template.id);
      const id = v.template.id, file = join(s.protectedDir, id, 'template.json');
      // Detection: every AI word on its letters (the misplaced lines moved; the legal line as given).
      const t = JSON.parse(readFileSync(file, 'utf8')) as { revision: number; textAnalysis: { revision: number; words: DetectedWord[]; history: { action: string; detail?: string }[] }; product: { history: { action: string; detail?: string }[] } };
      for (const l of LINES) for (const text of l.words) { const w = t.textAnalysis.words.find(x => x.text === text)!; expect(w.origin).toBe('ai'); expect(shape(w.box), text).toEqual(truth(text)); }
      // An older template: the offer line saved 45 px above its letters with the panel's colour as its ink; "T&Cs" moved
      // by a person (kept as they put it).
      const offer = t.textAnalysis.words.filter(w => ['Get', '26%', 'cashback'].includes(w.text)), panel = '#bdf0dc';
      for (const w of offer) { w.box = { ...w.box, y: w.box.y - 45 }; w.source = { ...w.source!, box: { ...w.box } }; w.style = { ...w.style, color: panel }; }
      const tcs = t.textAnalysis.words.find(w => w.text === 'T&Cs')!; tcs.box = { ...tcs.box, y: tcs.box.y - 12 }; tcs.source = { ...tcs.source!, box: { ...tcs.box } }; tcs.corrected = { at: new Date().toISOString(), box: true };
      writeFileSync(file, JSON.stringify(t));
      v = (await s.call<View>(`/${id}`)).body;
      expect((await s.send('POST', `/${id}/text/fit`, { expectedRevision: v.template.revision - 1 })).status).toBe(409);
      const fitted = await s.send<View & { fit: { moved: number; lines: { text: string; method: string; reason?: string }[] } }>('POST', `/${id}/text/fit`, { expectedRevision: v.template.revision });
      expect(fitted.status).toBe(200);
      expect(fitted.body.fit.moved).toBe(1);
      expect(fitted.body.fit.lines.find(l => l.text.startsWith('T&Cs'))).toMatchObject({ method: 'kept', reason: expect.stringMatching(/corrected by a person/) });
      expect(fitted.body.template.revision).toBe(v.template.revision + 1);
      const after = JSON.parse(readFileSync(file, 'utf8')) as typeof t;
      expect(after.textAnalysis.revision).toBe(t.textAnalysis.revision + 1);
      expect(after.textAnalysis.history.at(-1)).toMatchObject({ action: 'corrected', detail: expect.stringMatching(/1 line/) });
      expect(after.product.history.at(-1)).toMatchObject({ action: 'reviewed', detail: expect.stringMatching(/no AI request/) });
      const source = await sharp(readFileSync(join(s.protectedDir, id, (JSON.parse(readFileSync(file, 'utf8')) as { source: { inputFile: string } }).source.inputFile))).raw().toBuffer({ resolveWithObject: true });
      for (const w of after.textAnalysis.words.filter(x => ['Get', '26%', 'cashback'].includes(x.text))) {
        expect(shape(w.box), w.text).toEqual(truth(w.text));
        expect(w.source!.box).toEqual(w.box);
        // Its ink measured where its letters are (not the panel), and its crop is the source's pixels there.
        expect(w.style.color).not.toBe(panel);
        const crop = await sharp(readFileSync(join(s.protectedDir, id, w.source!.crop))).raw().toBuffer({ resolveWithObject: true });
        expect([crop.info.width, crop.info.height]).toEqual([w.box.width, w.box.height]);
        const at = (x: number, y: number) => { const i = ((w.box.y + y) * source.info.width + w.box.x + x) * source.info.channels; return [...source.data.subarray(i, i + 3)]; };
        for (const [x, y] of [[2, 2], [Math.floor(w.box.width / 2), Math.floor(w.box.height / 2)], [w.box.width - 3, w.box.height - 3]]) { const i = (y * crop.info.width + x) * crop.info.channels; expect([...crop.data.subarray(i, i + 3)]).toEqual(at(x, y)); }
      }
      const kept = after.textAnalysis.words.find(x => x.text === 'T&Cs')!;
      expect(kept.box).toEqual(tcs.box);
      // Nothing more to do: unchanged, no new revision.
      const again = await s.send<View & { fit: { moved: number } }>('POST', `/${id}/text/fit`, { expectedRevision: fitted.body.template.revision });
      expect(again.body.fit.moved).toBe(0);
      expect(again.body.template.revision).toBe(fitted.body.template.revision);
      for (const w of after.textAnalysis.words) expect(existsSync(join(s.protectedDir, id, w.source!.crop))).toBe(true);
    } finally { await s.close(); }
  });

  it('has nothing to fit when the text was read without the AI analysis', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Local' });
      const v = await s.detected(made.body.template.id);
      const r = await s.send<{ error: { code: string } }>('POST', `/${v.template.id}/text/fit`, { expectedRevision: v.template.revision });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body.error.code).toBe('NOTHING_TO_FIT');
    } finally { await s.close(); }
  });
});
