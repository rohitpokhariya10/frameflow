import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeRgba } from '../pixels.js';
import { splitArtwork, splitByLayers } from './artworkObjects.js';
import { artwork, leafAndFlowerMasks } from './artworkObjects.fixture.js';

const colourAt = (png: { data: Buffer; width: number }, x: number, y: number) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]; };

describe('background artwork split into its objects (local)', { timeout: 120_000 }, () => {
  it('makes a base, a border and one layer per illustration; the layers over each other are the picture, pixel for pixel', async () => {
    const { png, W, H } = await artwork(), source = await decodeRgba(png), split = await splitArtwork(source);
    // Back to front: the border first, then the illustrations (each where it is drawn).
    expect(split.objects[0]).toMatchObject({ kind: 'border', name: 'Border' });
    const objects = split.objects.slice(1), inside = (x: number, y: number) => objects.find(o => x >= o.placement.x && x < o.placement.x + o.placement.width && y >= o.placement.y && y < o.placement.y + o.placement.height);
    expect(objects.every(o => o.kind === 'object')).toBe(true);
    const leaves = inside(790, 120), boat = inside(700, 1100), star = inside(200, 650);
    expect(leaves && boat && star && new Set([leaves, boat, star]).size).toBe(3);
    // The flower on the leaves is one illustration with them; names say where each is.
    expect(inside(760, 190)).toBe(leaves);
    expect([leaves!.name, boat!.name, star!.name]).toEqual(['Artwork · top right', 'Artwork · bottom right', 'Artwork · middle left']);
    // The layers over each other look like the picture: rims are blends, so a few pixels differ slightly, none visibly.
    const recon = await sharp(split.base).composite(split.objects.map(o => ({ input: o.png, left: o.placement.x, top: o.placement.y }))).removeAlpha().raw().toBuffer(), picture = await sharp(png).removeAlpha().raw().toBuffer();
    let visible = 0; for (let i = 0; i < picture.length; i += 3) if (Math.max(...[0, 1, 2].map(c => Math.abs(recon[i + c] - picture[i + c]))) > 24) visible++;
    expect(visible / (W * H)).toBeLessThan(0.002);
    expect(split.reconstruction.visiblePercent).toBeLessThan(0.2);
    // Rebuilt from the structure: the page white, the panel's lattice from its own repeats; and the border made whole.
    expect(split.rebuiltPercent).toBeGreaterThan(95);
    expect(split.borderDotsAdded).toBeGreaterThan(0);
    // The white dots on the boat are the boat's (white inside a drawing is part of it, not the page).
    const boatPx = await decodeRgba(boat!.png), dot = colourAt(boatPx, 700 - boat!.placement.x, 1105 - boat!.placement.y);
    expect(dot).toEqual([255, 255, 255, 255]);
    // The base keeps no object: the panel and its lattice continue where the star, the leaves and the dots were.
    const base = await decodeRgba(split.base);
    let objectColour = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const [r, g, b] = colourAt(base, x, y); if ((r > 200 && g < 140) || (r < 160 && b > 200 && g < 120) || (g > 200 && r > 150 && b < 60) || (r < 120 && g < 120 && b < 120)) objectColour++; }
    expect(objectColour).toBe(0);
    expect(colourAt(base, 200, 650).slice(0, 3).every((v, k) => Math.abs(v - [186, 245, 215][k]) < 30 || Math.abs(v - [252, 250, 215][k]) < 30)).toBe(true);
    // Every dot of the border is in its layer: the visible ones, and the ones the leaves (top right) and the boat hide.
    const border = await decodeRgba(split.objects[0].png), at = (x: number, y: number) => colourAt(border, x - split.objects[0].placement.x, y - split.objects[0].placement.y)[3];
    expect([at(60, 80), at(60, 1120), at(840, 1120), at(450, 80), at(840, 590)].every(a => a === 255)).toBe(true);
    expect([at(780, 80), at(810, 80), at(840, 110), at(840, 140), at(720, 1120), at(840, 1040), at(840, 1070)].every(a => a === 255)).toBe(true);
    // A rim is transparent where it meets the panel, so a moved object carries no mint fringe.
    const leafPx = await decodeRgba(leaves!.png);
    let soft = 0, mint = 0;
    for (let i = 0; i < leafPx.width * leafPx.height; i++) { const a = leafPx.data[i * 4 + 3]; if (a > 0 && a < 255) soft++; if (a === 255 && Math.abs(leafPx.data[i * 4] - 186) < 10 && Math.abs(leafPx.data[i * 4 + 1] - 245) < 10 && Math.abs(leafPx.data[i * 4 + 2] - 215) < 10) mint++; }
    expect(soft).toBeGreaterThan(50); expect(mint).toBe(0);
    expect(split.filledPercent).toBeGreaterThan(0);
  });
  it('splits along a decomposition\'s layer shapes: the flower apart from the leaves it lies on, still pixel for pixel', async () => {
    const { png, W, H } = await artwork(), source = await decodeRgba(png), { leaves, flower } = leafAndFlowerMasks(W, H);
    const split = await splitByLayers(source, [{ name: 'Artwork · Leaves', mask: leaves }, { name: 'Artwork · Flower', mask: flower }]);
    expect(split.objects.map(o => o.name)).toEqual(['Artwork · Leaves', 'Artwork · Flower']);
    const [leafLayer, flowerLayer] = split.objects, opaque = async (o: typeof leafLayer, x: number, y: number) => colourAt(await decodeRgba(o.png), x - o.placement.x, y - o.placement.y)[3];
    // The flower's centre is the flower's, a leaf tip the leaves'.
    expect(await opaque(flowerLayer, 760, 190)).toBe(255);
    expect(await opaque(leafLayer, 845, 85)).toBe(255);
    expect(flowerLayer.placement.width).toBeLessThan(90);
    expect(split.reconstruction.visiblePercent).toBeLessThan(0.2);
  });
  it('leaves a plain picture whole (nothing to split)', async () => {
    const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#f5e6d3' } }).png().toBuffer();
    const split = await splitArtwork(await decodeRgba(png));
    expect(split.objects).toEqual([]);
    expect((await sharp(split.base).removeAlpha().raw().toBuffer()).equals(await sharp(png).removeAlpha().raw().toBuffer())).toBe(true);
  });
});
