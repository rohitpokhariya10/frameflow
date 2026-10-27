import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CreativeInstance, MasterSnapshot } from '@frameflow/shared';
import { fileProtectedStore } from '../store.js';
import { createCreativeRun, existingCreativeRun } from './creativeRun.js';
import { readRun, saveRunRecord } from '../../layerizeExperiment.js';
import { artwork, leafAndFlowerMasks } from './artworkObjects.fixture.js';

const ID = 'pt-0123456789ab';
/** A store with the drawn artwork as a published revision's background, and its leaves and flower as decomposition layers. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'creative-run-')), store = fileProtectedStore(join(root, 'protected')), runsDir = join(root, 'runs'), { png, W, H } = await artwork();
  store.write(ID, 'base-0123456789ab.png', png);
  const { leaves, flower } = leafAndFlowerMasks(W, H), rgba = await sharp(png).ensureAlpha().raw().toBuffer();
  // A decomposition's layer: the artwork's pixels where the mask is, transparent elsewhere, cropped to its box.
  const layer = async (mask: Uint8Array) => {
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const x = i % W, y = (i - x) / W; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y + y0) * W + x + x0; if (mask[i]) rgba.copy(out, (y * w + x) * 4, i * 4, i * 4 + 4); }
    return { png: await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), x: x0, y: y0, width: w, height: h };
  };
  const l1 = await layer(leaves), l2 = await layer(flower);
  store.write(ID, 'layer-leaves.png', l1.png); store.write(ID, 'layer-flower.png', l2.png); store.write(ID, 'layer-base.png', png);
  const plain = { masterId: ID, revision: 1, canvas: { width: W, height: H }, background: { file: 'base-0123456789ab.png' }, layers: [] } as unknown as MasterSnapshot;
  const decomposed = { ...plain, revision: 2, layers: [
    { id: 'ml-base', name: 'Base', file: 'layer-base.png', sha256: '', x: 0, y: 0, width: W, height: H, zIndex: 0 },
    { id: 'ml-leaves', name: 'Leaves', file: 'layer-leaves.png', sha256: '', x: l1.x, y: l1.y, width: l1.width, height: l1.height, zIndex: 1 },
    { id: 'ml-flower', name: 'Flower', file: 'layer-flower.png', sha256: '', x: l2.x, y: l2.y, width: l2.width, height: l2.height, zIndex: 2 },
  ] } as unknown as MasterSnapshot;
  // A 9:16 AI creative: the artwork whole in the middle (1.2×), a warm ground around it.
  store.write(ID, 'cra-aaaaaaaaaaaa-art-1.png', await sharp(png).resize(1080, 1440).png().toBuffer());
  const ai = { masterId: ID, masterRevision: 1, id: 'cr-aaaaaaaaaaaa', revision: 1, name: 'Story', canvas: { width: 1080, height: 1920 }, backgroundColor: '#f3e6d6', origin: { kind: 'ai', jobId: 'job', index: 0 },
    texts: [], shapes: [], groups: [], images: [{ id: 'ci-art', artwork: true, hidden: false, locked: true, z: 0, label: 'Template artwork', category: 'other', box: { x: 0, y: 240, width: 1080, height: 1440, rotation: 0 }, asset: { kind: 'creative', file: 'cra-aaaaaaaaaaaa-art-1.png' } }] } as unknown as CreativeInstance;
  const manual = { masterId: ID, masterRevision: 2, id: 'cr-bbbbbbbbbbbb', revision: 1, name: 'Manual', canvas: { width: W, height: H }, origin: { kind: 'master' }, texts: [], shapes: [], groups: [], images: [] } as unknown as CreativeInstance;
  return { store, runsDir, plain, decomposed, ai, manual };
}
const files = (dir: string, run: { creative?: { layers: { file: string; kind: string }[] } }) => run.creative!.layers.filter(l => l.kind === 'background' || l.kind === 'artwork').map(l => join(dir, l.file));
/** The run's background layers composited, against the run's original: no pixel visibly different (rims are blends). */
async function exact(runsDir: string, run: { id: string; layers?: { file: string; placement: { x: number; y: number } }[]; creative?: { layers: { file: string; kind: string }[] } }) {
  const dir = join(runsDir, run.id), [base, ...rest] = files(dir, run);
  const recon = await sharp(base).composite(rest.map(f => { const p = run.layers!.find(l => join(dir, l.file) === f)!.placement; return { input: f, left: p.x, top: p.y }; })).removeAlpha().raw().toBuffer();
  const original = await sharp(join(dir, 'original.png')).removeAlpha().raw().toBuffer();
  let visible = 0; for (let i = 0; i < original.length; i += 3) if (Math.max(...[0, 1, 2].map(c => Math.abs(recon[i + c] - original[i + c]))) > 24) visible++;
  return visible / (original.length / 3) < 0.002;
}

describe('a creative sent to decomposition: its background artwork in objects', { timeout: 180_000 }, () => {
  it('finds the objects locally when the master has no decomposition (an AI creative in another format)', async () => {
    const s = await setup(), run = await createCreativeRun(s.runsDir, s.store, s.plain, s.ai), names = run.creative!.layers.filter(l => l.kind === 'artwork').map(l => run.layers!.find(x => x.file === l.file)!.name);
    expect(run.creative!.artwork).toMatchObject({ method: 'local', objects: names.length });
    expect(names).toEqual(expect.arrayContaining(['Border', 'Artwork · top right', 'Artwork · bottom right']));
    expect(run.layers![0].name).toBe('Background base');
    expect(await exact(s.runsDir, run)).toBe(true);
  });
  it('cuts an AI creative\'s own artwork along a decomposed master\'s layers (the flower apart from the leaves)', async () => {
    const s = await setup(), run = await createCreativeRun(s.runsDir, s.store, s.decomposed, { ...s.ai, masterRevision: 2 } as CreativeInstance);
    const art = run.creative!.layers.filter(l => l.kind === 'artwork'), named = art.map(l => run.layers!.find(x => x.file === l.file)!);
    expect(run.creative!.artwork).toMatchObject({ method: 'master-layers', objects: 2 });
    expect(named.map(l => l.name)).toEqual(['Artwork · Leaves', 'Artwork · Flower']);
    // Mapped onto the 9:16 canvas: the flower (760, 190 on the master) is at 760 × 1.2, 240 + 190 × 1.2.
    const flower = named[1].placement;
    expect(912).toBeGreaterThanOrEqual(flower.x); expect(912).toBeLessThan(flower.x + flower.width);
    expect(468).toBeGreaterThanOrEqual(flower.y); expect(468).toBeLessThan(flower.y + flower.height);
    expect(await exact(s.runsDir, run)).toBe(true);
  });
  it('reuses a run of the same creative revision, but not one made before the artwork was split (that run stays)', async () => {
    const s = await setup(), run = await createCreativeRun(s.runsDir, s.store, s.plain, s.ai);
    expect(existingCreativeRun(s.runsDir, ID, s.ai)?.id).toBe(run.id);
    const old = readRun(join(s.runsDir, run.id)); delete old.creative!.version; saveRunRecord(join(s.runsDir, run.id), old);
    expect(existingCreativeRun(s.runsDir, ID, s.ai)).toBeNull();
    const next = await createCreativeRun(s.runsDir, s.store, s.plain, s.ai);
    expect(next.id).not.toBe(run.id); expect(existingCreativeRun(s.runsDir, ID, s.ai)?.id).toBe(next.id);
    expect(readRun(join(s.runsDir, run.id)).creative!.creativeId).toBe(s.ai.id);
  });
  it('gives a manual creative of a decomposed master that decomposition\'s own layers', async () => {
    const s = await setup(), run = await createCreativeRun(s.runsDir, s.store, s.decomposed, s.manual), art = run.creative!.layers.filter(l => l.kind === 'artwork');
    expect(run.creative!.artwork).toEqual({ method: 'master-layers', objects: 2 });
    expect(art.map(l => run.layers!.find(x => x.file === l.file)!.name)).toEqual(['Artwork · Leaves', 'Artwork · Flower']);
    expect(await exact(s.runsDir, run)).toBe(true);
  });
});
