/**
 * A word's box corrected in the review: its face, size and spacing are found again from the letters in the new box
 * (RECORDED real AI answer for the LG creative at 4096 px, replayed; no network). The answer's box for "CHATURTHI" took in
 * the divider drawn under it in the same colour: the word was set a third too tall, in a thin face squeezed by negative
 * letter spacing, and ran out of its badge. Scaling that style to a corrected box kept the wrong face.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { creativeStyleOf, type DetectedWord } from '@frameflow/shared';
import { liveProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { recordedResponsesClient } from '../../server/src/decomposition/protectedTemplates/product/responsesClient.fixture.js';
import { setup, type View } from '../../server/src/decomposition/protectedTemplates/product/productServer.fixture.js';
import { textInkExact } from '../../server/src/templateStudio/masterCreatives/render.js';
import { overlappingWords } from '../../server/src/decomposition/protectedTemplates/product/service.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

describe('a corrected word box re-fits the word', { timeout: 300_000 }, () => {
  it.skipIf(!HAS_PRIVATE_FIXTURES)('“CHATURTHI”: its box drawn round its letters gives a heavy face of their height that stays inside them', async () => {
    const response = JSON.parse(readFileSync('tests/fixtures/recorded/ganesh-lg-4096-b-gpt-5.6-sol-2026-10-22.response.json', 'utf8'));
    const sheet = readFileSync('Ganesh-Chaturthi.png'), c = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
    const png = await sharp(sheet).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).resize(4096, null, { kernel: 'lanczos3' }).png().toBuffer(), source = await decodeRgba(png);
    const s = await setup({ analyzer: liveProductAnalyzer({ client: recordedResponsesClient(response, { width: 2048, height: 2048 }) }) });
    try {
      const made = await s.form<View>('', png, { name: 'LG 4096 (recorded answer)' });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const v = await s.detected(made.body.template.id), id = v.template.id;
      const stored = () => JSON.parse(readFileSync(join(s.protectedDir, id, 'template.json'), 'utf8')).textAnalysis.words as DetectedWord[];
      const before = stored().find(w => w.text === 'CHATURTHI')!;
      expect(before).toBeTruthy();
      // Where its letters are (measured here): the rows of its box most inked in its colour, from the top, down to the first
      // row with almost none (the gap above the divider).
      const ink = [1, 3, 5].map(k => parseInt(before.style.color.slice(k, k + 2), 16)), b = before.box, rows: number[] = [];
      for (let y = Math.round(b.y); y < Math.round(b.y + b.height); y++) { let n = 0; for (let x = Math.round(b.x); x < Math.round(b.x + b.width); x++) { const i = (y * source.width + x) * 4; if (Math.max(Math.abs(source.data[i] - ink[0]), Math.abs(source.data[i + 1] - ink[1]), Math.abs(source.data[i + 2] - ink[2])) < 65) n++; } rows.push(n); }
      const peak = Math.max(...rows), top = rows.findIndex(n => n > peak * 0.1); let bottom = top; while (bottom + 1 < rows.length && rows[bottom + 1] > peak * 0.1) bottom++;
      const letters = { x: Math.round(b.x), y: Math.round(b.y) + top - 2, width: Math.round(b.width), height: bottom - top + 5 };
      expect(letters.height, 'the letters are well short of the answer’s box').toBeLessThan(b.height * 0.8);
      const saved = await s.send<View>('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true,
        words: [{ wordId: before.id, box: letters }] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const after = stored().find(w => w.id === before.id)!;
      expect(after.corrected?.box).toBe(true);
      // A face of the letters' weight and height: not the thin one squeezed by negative spacing; its ink within the letters'
      // box (it ran out of the badge), not a third taller.
      expect(after.style.fontWeight).toBeGreaterThanOrEqual(600);
      expect(after.style.letterSpacing).toBeGreaterThan(-0.05 * after.style.fontSize);
      expect(after.style.fontSize).toBeLessThan(before.style.fontSize * 0.85);
      const drawn = textInkExact({ id: after.id, wordId: after.id, groupId: after.groupId, line: 0, order: after.order, text: after.text, x: after.box.x + (after.style.originDx ?? 0), baselineY: after.box.y + after.style.baseline, rotation: after.box.rotation, style: creativeStyleOf(after.style), hidden: false, locked: false, z: 0 } as never)!;
      expect(drawn.height).toBeLessThan(letters.height * 1.1);
      expect(drawn.x + drawn.width).toBeLessThan(letters.x + letters.width * 1.03 + 1);
    } finally { await s.close(); }
  });
});

describe('words that would be drawn over others are named for the review', () => {
  const word = (text: string, x: number, y: number, width: number, height = 25) => ({ text, box: { x, y, width, height, rotation: 0 } });
  it('two words read onto one place, and a word read in the gap above its line (Ganesh creative 4: “Ld”, “On”)', () => {
    // As the local reader gave creative 4's second headline line: "Ld" and "On" are pieces of the line above, boxed in the
    // gap between the lines; set on this line's baseline they were drawn over "pays you".
    expect(overlappingWords([word('Ld', 180, 102, 28, 15), word('pays', 187, 124, 73), word('On', 256, 97, 28, 14), word('you', 269, 124, 56), word('back.', 336, 117, 83)]))
      .toEqual(['“Ld” (off its line)', '“On” (off its line)']);
    expect(overlappingWords([word('Accept', 100, 50, 60), word('customer', 130, 50, 80), word('payments,', 230, 50, 90)])).toEqual(['“Accept” and “customer”']);
    // A good line: words side by side, one a little higher (a capital, punctuation) or a little overlapping (kerning).
    expect(overlappingWords([word('Get', 10, 50, 40), word('26%', 52, 46, 44, 29), word('cashback', 98, 50, 100), word('on', 196, 52, 25, 23)])).toEqual([]);
  });
});
