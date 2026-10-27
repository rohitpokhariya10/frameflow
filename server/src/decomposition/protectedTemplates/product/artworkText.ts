/**
 * Lettering that is part of a decoration's artwork (a festival badge's "GANESH CHATURTHI golden deals"): text groups
 * lying wholly inside one compact decoration of the template. They are never set again as live text — the editable
 * words' estimated faces, sizes and colours drew them crowded and overlapping on the badge — and the badge keeps the
 * original picture's own pixels: where the master's text removal changed it (a flat panel fill, ghost letters, the
 * ribbon's dots), the original is put back. Only those changed pixels near the lettering; nothing else of the base
 * (a removed product or stand beside the badge) comes back. The words stay in the data (hidden).
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { ProductSnapshot } from '@frameflow/shared';

export type Box = { x: number; y: number; width: number; height: number };
export interface ArtworkGroup { groupId: string; decoration: Box; words: Box[] }
/** Bumped when what restoreArtwork draws changes (a new cached file per revision). */
export const ARTWORK_TEXT_VERSION = 1;

const inside = (b: Box, k: Box, slack = 4) => b.x >= k.x - slack && b.y >= k.y - slack && b.x + b.width <= k.x + k.width + slack && b.y + b.height <= k.y + k.height + slack;

/**
 * The groups that are a decoration's own lettering: every word of the group inside one decoration that is compact (at
 * most 12 % of the canvas: a badge, a sticker, a seal — never a frame or border holding the poster's text).
 */
export function artworkGroups(canvas: { width: number; height: number }, decorations: { label: string; box: Box }[], words: { groupId: string; box: Box }[]): ArtworkGroup[] {
  const compact = decorations.filter(d => !/^Shadow · /.test(d.label) && d.box.width * d.box.height <= canvas.width * canvas.height * 0.12);
  const out: ArtworkGroup[] = [];
  for (const gid of [...new Set(words.map(w => w.groupId))]) {
    const mine = words.filter(w => w.groupId === gid).map(w => ({ x: w.box.x, y: w.box.y, width: w.box.width, height: w.box.height }));
    const decoration = compact.find(d => mine.length > 0 && mine.every(w => inside(w, d.box)));
    if (decoration) out.push({ groupId: gid, decoration: { ...decoration.box }, words: mine });
  }
  return out;
}

/**
 * `base` (RGB or RGBA, 3 or 4 channels) with the original's pixels put back where it differs from `source` (RGB) around
 * each artwork group: the changed areas (8-connected) within the group's lines (a word height to the sides for the
 * ribbon's ornaments, a third above and below) inside its decoration, except those touching the decoration's edge
 * (what was removed beside it), each grown by 2 px for the letters' soft edges. Changes `base` in place; returns how many
 * pixels were restored.
 */
export function restoreArtworkRaw(source: Uint8Array, base: Uint8Array, channels: 3 | 4, w: number, h: number, groups: ArtworkGroup[]): number {
  let restored = 0;
  for (const g of groups) {
    const lh = Math.max(...g.words.map(b => b.height)), gx0 = Math.min(...g.words.map(b => b.x)), gy0 = Math.min(...g.words.map(b => b.y));
    const gx1 = Math.max(...g.words.map(b => b.x + b.width)), gy1 = Math.max(...g.words.map(b => b.y + b.height)), d = g.decoration;
    const x0 = Math.max(0, Math.ceil(d.x), Math.floor(gx0 - lh)), x1 = Math.min(w - 1, Math.floor(d.x + d.width) - 1, Math.ceil(gx1 + lh));
    const y0 = Math.max(0, Math.ceil(d.y), Math.floor(gy0 - lh * 0.35)), y1 = Math.min(h - 1, Math.floor(d.y + d.height) - 1, Math.ceil(gy1 + lh * 0.35));
    if (x1 <= x0 || y1 <= y0) continue;
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1, changed = new Uint8Array(rw * rh), label = new Int32Array(rw * rh).fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x, b = i * channels, s = i * 3;
      if (Math.max(Math.abs(base[b] - source[s]), Math.abs(base[b + 1] - source[s + 1]), Math.abs(base[b + 2] - source[s + 2])) > 24) changed[(y - y0) * rw + x - x0] = 1;
    }
    // Components; one touching the decoration's edge is left as the base has it.
    const keep = new Uint8Array(rw * rh), edge = (x: number, y: number) => x - d.x < 3 || d.x + d.width - 1 - x < 3 || y - d.y < 3 || d.y + d.height - 1 - y < 3;
    for (let start = 0, n = 0; start < rw * rh; start++) {
      if (!changed[start] || label[start] >= 0) continue;
      const stack = [start], members: number[] = []; let touches = false; label[start] = n;
      while (stack.length) {
        const k = stack.pop()!, kx = k % rw, ky = (k - kx) / rw; members.push(k);
        if (edge(x0 + kx, y0 + ky)) touches = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx, ny = ky + dy; if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const j = ny * rw + nx; if (changed[j] && label[j] < 0) { label[j] = n; stack.push(j); }
        }
      }
      if (!touches) for (const k of members) keep[k] = 1;
      n++;
    }
    for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) {
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = rx + dx, ny = ry + dy; if (nx >= 0 && ny >= 0 && nx < rw && ny < rh && keep[ny * rw + nx]) { near = true; break; } }
      if (!near) continue;
      const i = (ry + y0) * w + rx + x0, b = i * channels, s = i * 3;
      base[b] = source[s]; base[b + 1] = source[s + 1]; base[b + 2] = source[s + 2]; if (channels === 4) base[b + 3] = 255;
      restored++;
    }
  }
  return restored;
}

/** The PNG form: `base` with the artwork groups' lettering restored from `source` (same size; else `base` unchanged). */
export async function restoreArtwork(sourceImage: Buffer, basePng: Buffer, groups: ArtworkGroup[]): Promise<{ png: Buffer; restored: number }> {
  const [{ data: src, info: si }, { data, info }] = await Promise.all([sharp(sourceImage).removeAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(basePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
  if (!groups.length || si.width !== info.width || si.height !== info.height) return { png: basePng, restored: 0 };
  const px = new Uint8Array(data.buffer, data.byteOffset, data.length), restored = restoreArtworkRaw(src, px, 4, info.width, info.height, groups);
  return { png: restored ? await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer() : basePng, restored };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/**
 * A saved template revision's background with its artwork lettering restored (a cached file of its own,
 * `pbadge-<revision>-<hash>.png`; the template's files are never changed), and the groups that are artwork. Undefined:
 * none, an edited master (its own creative decides), or no original picture to restore from.
 */
export async function artworkBase(files: { has: (f: string) => boolean; read: (f: string) => Buffer; write: (f: string, b: Buffer) => void }, snapshot: ProductSnapshot): Promise<{ file: string; sha256: string; groups: Set<string> } | undefined> {
  if (snapshot.editorCreative || !snapshot.source?.file || !files.has(snapshot.source.file) || !files.has(snapshot.base.file)) return undefined;
  const decorations = [...(snapshot.backgroundStructure ?? []), ...snapshot.objects].filter(o => o.kind === 'decoration').map(o => ({ label: o.label, box: o.box }));
  const groups = artworkGroups(snapshot.canvas, decorations, snapshot.words.map(w => ({ groupId: w.groupId, box: w.box })));
  if (!groups.length) return undefined;
  const file = `pbadge-${snapshot.revision}-${sha256(JSON.stringify([snapshot.base.sha256, snapshot.source.sha256, groups, ARTWORK_TEXT_VERSION])).slice(0, 12)}.png`;
  if (!files.has(file)) files.write(file, (await restoreArtwork(files.read(snapshot.source.file), files.read(snapshot.base.file), groups)).png);
  return { file, sha256: sha256(files.read(file)), groups: new Set(groups.map(g => g.groupId)) };
}
