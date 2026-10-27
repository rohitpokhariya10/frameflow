import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cleanFootprints, type Footprint } from './footprint.js';

// A product's footprint cleaned from the background it stood on: only what can be told apart from the artwork (the
// estimate's ghost of it, its old shadow), never the artwork itself. Synthetic scenes: a wall (white, or rays) over an
// orange podium with a black front; the old product a grey block standing on the podium.
const W = 320, H = 260, box = { x: 130, y: 60, width: 60, height: 140 }, contactY = 199;
type Rgb = [number, number, number];
const WHITE: Rgb = [250, 250, 250], ORANGE: Rgb = [250, 108, 60], FRONT: Rgb = [16, 16, 16];
const stage = (x: number, y: number, wall: (x: number, y: number) => Rgb = () => WHITE): Rgb => (y < 170 ? wall(x, y) : y < 220 ? ORANGE : FRONT);
const rays = (a: Rgb, b: Rgb) => (x: number, y: number): Rgb => ((x + y) % 40 < 20 ? a : b);
const inBox = (x: number, y: number, grow = 0) => x >= box.x - grow && x < box.x + box.width + grow && y >= box.y - grow && y < box.y + box.height + grow;
const png = (f: (x: number, y: number) => Rgb) => { const b = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b.set(f(x, y), (y * W + x) * 3); return sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(); };
const pixels = async (p: Buffer) => sharp(p).removeAlpha().raw().toBuffer();
const at = (b: Buffer, x: number, y: number): Rgb => { const i = (y * W + x) * 3; return [b[i], b[i + 1], b[i + 2]]; };
const apart = (p: Rgb, q: Rgb) => Math.max(...p.map((v, c) => Math.abs(v - q[c])));
const footprint = async (): Promise<Footprint> => ({ box, contactY, cutout: { png: await sharp({ create: { width: box.width, height: box.height, channels: 4, background: '#5a5a64' } }).png().toBuffer(), placement: box } });
// The original picture: the product, its shadow on the podium beside it (each channel darker by the same share).
const shadowed = (x: number, y: number, under: Rgb): Rgb => (y >= 195 && y < 212 && x >= 118 && x < 202 && !inBox(x, y) ? under.map(v => Math.round(v * 0.65)) as Rgb : under);
const original = (wall?: (x: number, y: number) => Rgb) => png((x, y) => (inBox(x, y) ? [90, 90, 100] : shadowed(x, y, stage(x, y, wall))));

describe('product footprint cleanup', () => {
  it('removes the estimate’s ghost (a lighter patch on the podium, a tint over the body) and the old shadow; the artwork around is untouched', async () => {
    // The base: the original outside the product; where it stood, an estimate keeping its shape.
    const ground = await png((x, y) => (inBox(x, y, 1) ? (y < 170 ? [244, 243, 238] : [253, 128, 84]) : shadowed(x, y, stage(x, y))));
    const r = await cleanFootprints(ground, [await footprint()], [], await original()), before = await pixels(ground), after = await pixels(r.png);
    expect(r.report.reference).toBe('original');
    expect(r.report.footprints[0]).toMatchObject({ kept: false });
    expect(r.report.footprints[0].ghost).toBeGreaterThan(0); expect(r.report.footprints[0].replaced).toBeGreaterThan(0); expect(r.report.footprints[0].shadow).toBeGreaterThan(0);
    // The patch on the podium and the shadow beside it are the podium again; the tint over the body is the wall.
    for (const [x, y] of [[160, 180], [140, 195], [180, 190]]) expect(apart(at(after, x, y), ORANGE)).toBeLessThanOrEqual(8);
    for (const [x, y] of [[124, 204], [196, 204], [160, 208]]) expect(apart(at(after, x, y), ORANGE)).toBeLessThanOrEqual(10);
    for (const [x, y] of [[160, 100], [140, 140]]) expect(apart(at(after, x, y), WHITE)).toBeLessThanOrEqual(4);
    // Away from the footprint and its shadow, every pixel is the original's.
    for (let y = 0; y < H; y++) for (const x of [0, 40, 90, 110, 214, 260, 319]) expect(at(after, x, y)).toEqual(at(before, x, y));
    // The podium's back rim and its black front stay where they are.
    expect(apart(at(after, 160, 166), WHITE)).toBeLessThanOrEqual(6); expect(apart(at(after, 160, 225), FRONT)).toBeLessThanOrEqual(6);
  });

  it('keeps the rays the estimate drew over the body (fainter): shifted at most a little, never filled flat along the rows', async () => {
    const wall = rays([227, 249, 160], [240, 252, 200]), faint = rays([229, 247, 166], [236, 249, 188]);
    const ground = await png((x, y) => (inBox(x, y, 1) && y < 170 ? faint(x, y) : stage(x, y, wall)));
    const r = await cleanFootprints(ground, [await footprint()], [], await original(wall)), before = await pixels(ground), after = await pixels(r.png);
    const spread = (b: Buffer, y: number) => { const v: number[] = []; for (let x = 136; x < 184; x++) v.push(at(b, x, y)[2]); const m = v.reduce((s, a) => s + a, 0) / v.length; return Math.sqrt(v.reduce((s, a) => s + (a - m) ** 2, 0) / v.length); };
    for (let y = 70; y < 150; y += 10) {
      expect(spread(after, y)).toBeGreaterThanOrEqual(spread(before, y) * 0.8);
      for (let x = box.x; x < box.x + box.width; x++) expect(apart(at(after, x, y), at(before, x, y))).toBeLessThanOrEqual(12);
    }
    // The rays beside it are the original's.
    for (let y = 0; y < 160; y++) for (const x of [0, 60, 120, 200, 300]) expect(at(after, x, y)).toEqual(at(before, x, y));
  });

  it('keeps what the estimate drew where the product stood when it is no shade of the surface (a riser’s top), and reports nothing found for a clean estimate', async () => {
    const riser: Rgb = [60, 160, 90];
    const drawn = await png((x, y) => (inBox(x, y, 1) && y >= 172 && y < 192 ? riser : stage(x, y)));
    const kept = await pixels((await cleanFootprints(drawn, [await footprint()], [], await original())).png);
    expect(at(kept, 160, 182)).toEqual(riser);
    // An estimate that is already the background: nothing of the old product told apart, nothing visibly changed.
    const clean = await png((x, y) => stage(x, y)), r = await cleanFootprints(clean, [await footprint()], [], await png((x, y) => (inBox(x, y) ? [90, 90, 100] : stage(x, y))));
    expect(r.report.footprints[0].kept).toBe(true);
    const a = await pixels(clean), b = await pixels(r.png);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(2);
  });

  it('without the original picture, changes nothing beyond the footprint’s grown pixels and its contact band', async () => {
    const ground = await png((x, y) => (inBox(x, y, 1) ? (y < 170 ? [244, 243, 238] : [253, 128, 84]) : stage(x, y)));
    const r = await cleanFootprints(ground, [await footprint()]), before = await pixels(ground), after = await pixels(r.png);
    expect(r.report.reference).toBe('none');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!inBox(x, y, 10) && (y < 185 || y > 215)) expect(at(after, x, y)).toEqual(at(before, x, y));
  });
});
