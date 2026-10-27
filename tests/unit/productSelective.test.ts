import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import type { ProductObject } from '@frameflow/shared';
import { parseProductScene } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { fillOverlayPixels, isolatedObjectInput, providerExclusionMask } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { logoSlot } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { detectedPoster } from '../../server/src/decomposition/protectedTemplates/product/productPoster.fixture.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';
import { loadGaneshHandmade } from '../fixtures/privateHandmade.js';

describe('product-only AI manifest and actual request buffers', () => {
  it.skipIf(!HAS_PRIVATE_FIXTURES)('validates individually measured Ganesh words and individual products; refuses invalid word coordinates', async () => {
    const { ganeshWordManifest } = (await loadGaneshHandmade())!;
    const original = readFileSync('Ganesh-Chaturthi.png');
    const { findSheetCreatives } = await import('../../server/src/decomposition/protectedTemplates/product/sheet.js');
    const sheet = await decodeRgba(original), crop = findSheetCreatives(sheet).boxes[0];
    const png = await sharp(original).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toBuffer();
    const size = await sharp(png).metadata(), answer = ganeshWordManifest({ width: size.width!, height: size.height! });
    const manifest = parseProductScene(answer, { width: size.width!, height: size.height! });
    expect(manifest.objects.filter(o => o.kind === 'character')).toHaveLength(1);
    expect(manifest.objects.filter(o => o.kind === 'product')).toHaveLength(8);
    expect(manifest.words!.filter(w => w.group === 'headline').map(w => w.text)).toEqual('A grand welcome for Bappa calls for equally grand savings.'.split(' '));
    expect(manifest.words!.every(w => !/\s/.test(w.text))).toBe(true);
    expect(manifest.marks.filter(m => m.overlay)).toHaveLength(18);
    answer.words[0].box.x = -10;
    expect(() => parseProductScene(answer, { width: size.width!, height: size.height! })).toThrow('invalid');
    expect(readFileSync('Ganesh-Chaturthi.png').equals(original)).toBe(true);
  });
  it('preserves source logo bytes and changes only masked pixels during narrow overlay repair', async () => {
    const source = { width: 20, height: 20, data: Buffer.alloc(20*20*4, 255) };
    for (let y=5;y<10;y++) for (let x=5;x<10;x++) source.data.set([10,90,40,255], (y*20+x)*4);
    const original = Buffer.from(source.data), saved = new Map<string, Buffer>();
    const slot = await logoSlot(source, { x:5,y:5,width:5,height:5 }, 'Brand', 'brand-logo', (f,p) => saved.set(f,p), 0);
    expect(slot.original.placement).toEqual({ x:5,y:5,width:5,height:5 });
    const crop = await sharp(saved.get(slot.original.file)!).ensureAlpha().raw().toBuffer();
    expect([...crop]).toEqual(Array.from({length:25}, () => [10,90,40,255]).flat());
    const rgb = new Uint8Array(20*20*3), mask = new Uint8Array(400);
    for(let i=0;i<400;i++) { rgb.set(source.data.subarray(i*4,i*4+3),i*3); if (i%20>=5 && i%20<10 && i>=100 && i<200) mask[i]=1; }
    const repaired = fillOverlayPixels(rgb,20,20,mask,[{ id:'logo',box:slot.box }]);
    for(let i=0;i<400;i++) expect([...repaired.rgb.subarray(i*3,i*3+3)]).toEqual(mask[i] ? [255,255,255] : [...rgb.subarray(i*3,i*3+3)]);
    expect(source.data.equals(original)).toBe(true);
    const rotated = providerExclusionMask(source, { sourceExclusions: [{ x:5,y:5,width:5,height:5,rotation:45 }], words:[],logoSlots:[] } as never);
    expect(rotated[7*20+2]).toBe(1); // corner beyond the original rectangle
  });
  it('zeroes RGB and alpha for every overlapping word/logo pixel in the actual encoded input', async () => {
    const { source, analysis } = await detectedPoster();
    const mask = new Uint8Array(source.width * source.height).fill(1), excluded = providerExclusionMask(source, analysis);
    // Deliberately overlap a logo and text with a supposed product. Test bytes, not target names.
    const target: ProductObject = { id: 'po-test', kind: 'product', label: 'Overlap fixture', box: { x: 0, y: 900, width: 1000, height: 300 }, confidence: 1, z: 0, covers: [], origin: 'user', review: { status: 'accepted', by: 'user' } };
    const png = await isolatedObjectInput(source, target, mask, excluded), { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1000, 300]);
    let checked = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 1000; x++) if (excluded[(y + 900) * source.width + x]) {
      expect([...data.subarray((y * 1000 + x) * 4, (y * 1000 + x) * 4 + 4)]).toEqual([0, 0, 0, 0]); checked++;
    }
    expect(checked).toBeGreaterThan(10000);
    for (const kind of ['brand-logo', 'podium', 'frame', 'decoration'] as const) await expect(isolatedObjectInput(source, { ...target, kind }, mask, excluded)).rejects.toThrow('Only approved');
    await expect(isolatedObjectInput(source, target, mask, new Uint8Array(mask.length).fill(1))).rejects.toThrow('Cannot isolate');
  }, 120000);
});
