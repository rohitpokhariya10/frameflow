/**
 * Offline stand-ins for the paid parts of a creative variant, for tests and visual fixtures only (the app never imports
 * this file). Nothing here makes a network call.
 *
 *   syntheticCreative   a creative with textured products drawn pixel-exactly, and each product's exact mask
 *   maskedEdit          image models that behave like a real masked edit in the ways that matter (maskedEditTruth also
 *                       says where it drew its own copy of the products and its own shadow):
 *                         obeys-mask  keeps the opaque (protected) area exactly and paints textured scenery elsewhere
 *                         drifts      also re-renders the protected products shifted, enlarged and lighter (a ghost)
 *                                     with its own shadow under that copy, as image models do
 *                         adds-text   paints a block of dark "lettering" bars into the scenery
 *   imagesClient        the same models behind the OpenAI SDK's images.edit shape (multipart files in, b64 out)
 *   falSegmentation     a fal transport for the mask providers, answering each request from a callback
 *   mijiaReplay         a real saved creative from this machine (image, its real analysis, real product cutouts),
 *                       or undefined where those artifacts do not exist (tests then skip)
 *   writeVisual         side-by-side panels for a person to look at, written only when FRAMEFLOW_VISUAL_OUT is set
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { SceneDescription } from '@frameflow/shared';
import type { FalTransport } from '../providers/falClient.js';
import { band, type PixelBox } from './variantCompose.js';

type RGB = [number, number, number];
const hex = (color: string): RGB => [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];

export type Shape = { kind: 'rect' | 'ellipse'; box: PixelBox; color: string };
/** A creative: a flat background and textured products, each with its exact (hard-edged) mask. */
export async function syntheticCreative(width: number, height: number, background: string, shapes: Shape[]): Promise<{ png: Buffer; rgb: Buffer; masks: Uint8Array[] }> {
  const rgb = Buffer.alloc(width * height * 3), bg = hex(background), masks = shapes.map(() => new Uint8Array(width * height));
  for (let i = 0; i < width * height; i++) rgb.set(bg, i * 3);
  shapes.forEach((s, k) => {
    const [r, g, b] = hex(s.color), cx = s.box.x + s.box.width / 2, cy = s.box.y + s.box.height / 2;
    for (let y = Math.max(0, s.box.y); y < Math.min(height, s.box.y + s.box.height); y++) for (let x = Math.max(0, s.box.x); x < Math.min(width, s.box.x + s.box.width); x++) {
      if (s.kind === 'ellipse' && ((x + 0.5 - cx) / (s.box.width / 2)) ** 2 + ((y + 0.5 - cy) / (s.box.height / 2)) ** 2 > 1) continue;
      // A texture of fine stripes and a logo-like dot pattern: identity details a redraw would change.
      const t = ((x * 7 + y * 3) % 23) - 11, dot = (x % 17 < 3 && y % 13 < 3) ? -60 : 0, i = y * width + x;
      rgb[i * 3] = Math.max(0, Math.min(255, r + t + dot)); rgb[i * 3 + 1] = Math.max(0, Math.min(255, g + t)); rgb[i * 3 + 2] = Math.max(0, Math.min(255, b - t + dot));
      for (const m of masks) m[i] = 0;
      masks[k][i] = 255;
    }
  });
  return { png: await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer(), rgb, masks };
}
/** A soft (matted) version of a hard mask: an outward ramp of `radius` pixels, as a matting model returns. */
export function softEdges(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x] === 255) continue;
    let nearest = Infinity;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && mask[yy * width + xx] === 255) nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    if (nearest <= radius) out[y * width + x] = Math.round(255 * (1 - nearest / (radius + 1)));
  }
  return out;
}

/** Textured scenery a fill can be told apart from: a diagonal gradient with a fine checker. */
export const sceneryAt = (x: number, y: number): RGB => { const c = ((x >> 3) + (y >> 3)) % 2 ? 14 : -14; return [40 + (x % 200) / 2 + c, 120 + c, 140 + (y % 160) / 2 + c]; };
export type MaskedEditKind = 'obeys-mask' | 'drifts' | 'adds-text';
/** What a fake masked edit drew besides the scenery, at the model's size: its own copy of the products, and its own shadow. */
export type MaskedEditTruth = { png: Buffer; ghost: Uint8Array; shadow: Uint8Array; width: number; height: number };
/**
 * One masked image edit: `image` and `mask` exactly as sent (the mask's opaque area is kept), at the requested size.
 *   obeys-mask  the kept area exactly, new scenery elsewhere (with `contactShadow`, a soft shadow hugging each product's base)
 *   drifts      as a real model often does: it also re-renders the kept products a little brighter, shifted and slightly
 *               enlarged about their centre (its own copy, a ghost), with its own shadow under that copy
 *   adds-text   a block of dark "lettering" bars in the scenery
 */
export async function maskedEditTruth(kind: MaskedEditKind, image: Buffer, mask: Buffer, size: { width: number; height: number }, options: { drift?: { dx: number; dy: number; scale: number }; contactShadow?: boolean } = {}): Promise<MaskedEditTruth> {
  const { width, height } = size, drift = options.drift ?? { dx: 14, dy: 6, scale: 1.04 };
  const input = await sharp(image).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const keep = await band(sharp(mask).ensureAlpha().extractChannel(3).resize(width, height, { fit: 'fill' }));
  const out = Buffer.alloc(width * height * 3), ghost = new Uint8Array(width * height), shadow = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (keep[i] === 255) { out[i * 3] = input[i * 3]; out[i * 3 + 1] = input[i * 3 + 1]; out[i * 3 + 2] = input[i * 3 + 2]; }
    else out.set(sceneryAt(x, y).map(v => Math.max(0, Math.min(255, Math.round(v)))), i * 3);
  }
  // Under a set of drawn pixels, darken a few rows below each column's lowest one: a shadow hugging the base.
  const shade = (drawn: (i: number) => boolean) => {
    for (let x = 0; x < width; x++) {
      let low = -1; for (let y = height - 1; y >= 0; y--) if (drawn(y * width + x)) { low = y; break; }
      if (low < 0) continue;
      for (let y = low + 1; y < Math.min(height, low + 1 + Math.round(height * 0.012)); y++) { const i = y * width + x; if (drawn(i)) continue; shadow[i] = 1; for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(out[i * 3 + c] * 0.55); }
    }
  };
  if (kind === 'drifts') {
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < keep.length; i++) if (keep[i] === 255) { sx += i % width; sy += Math.floor(i / width); k++; }
    const cx = sx / Math.max(1, k), cy = sy / Math.max(1, k);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const fx = Math.round(cx + (x - drift.dx - cx) / drift.scale), fy = Math.round(cy + (y - drift.dy - cy) / drift.scale);
      if (fx < 0 || fy < 0 || fx >= width || fy >= height || keep[fy * width + fx] !== 255) continue;
      const i = y * width + x, j = fy * width + fx;
      ghost[i] = 1;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, input[j * 3 + c] + 10);
    }
    shade(i => ghost[i] === 1);
  } else if (options.contactShadow) shade(i => keep[i] === 255);
  if (kind === 'adds-text') for (let y = Math.round(height * 0.06); y < Math.round(height * 0.12); y++) for (let x = Math.round(width * 0.08); x < Math.round(width * 0.6); x++) if ((x >> 2) % 3 !== 0 && keep[y * width + x] !== 255) out.set([10, 10, 10], (y * width + x) * 3);
  return { png: await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer(), ghost, shadow, width, height };
}
export const maskedEdit = async (kind: MaskedEditKind, image: Buffer, mask: Buffer, size: { width: number; height: number }, options: Parameters<typeof maskedEditTruth>[4] = {}) => (await maskedEditTruth(kind, image, mask, size, options)).png;
/** The OpenAI SDK's images.edit, answered by a fake masked edit (it records every request it is sent). */
export function imagesClient(kind: MaskedEditKind | ((request: { prompt: string; size: string }) => MaskedEditKind | Error)) {
  const requests: { prompt: string; size: string; hasMask: boolean }[] = [];
  const edit = async (request: { image: { arrayBuffer(): Promise<ArrayBuffer> }; mask?: { arrayBuffer(): Promise<ArrayBuffer> }; size: string; prompt: string }) => {
    requests.push({ prompt: request.prompt, size: request.size, hasMask: !!request.mask });
    const chosen = typeof kind === 'function' ? kind(request) : kind;
    if (chosen instanceof Error) throw chosen;
    const [width, height] = request.size.split('x').map(Number);
    const image = Buffer.from(await request.image.arrayBuffer());
    const mask = request.mask ? Buffer.from(await request.mask.arrayBuffer()) : await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const bytes = await maskedEdit(chosen, image, mask, { width, height });
    return { data: [{ b64_json: bytes.toString('base64') }], usage: { input_tokens: 1000, output_tokens: 400, input_tokens_details: { image_tokens: 800, text_tokens: 200 } } };
  };
  return { requests, client: { images: { edit, generate: async () => { throw new Error('Variants use images.edit.'); } } } };
}

/** fal for the mask providers: every submission answered by `answer` (masks as PNGs, optional SAM-3 scores). */
export function falSegmentation(answer: (input: Record<string, unknown>, n: number) => { masks: Buffer[]; scores?: number[] }) {
  const submitted: Record<string, unknown>[] = [], files = new Map<string, Buffer>(), results = new Map<string, unknown>();
  let uploads = 0;
  const transport: FalTransport = {
    upload: async () => `https://v3b.fal.media/files/kit/upload-${++uploads}.png`,
    submit: async (endpoint, input) => {
      const n = submitted.length, id = `kit-${n + 1}`, { masks, scores } = answer(input as Record<string, unknown>, n);
      submitted.push(input as Record<string, unknown>);
      masks.forEach((png, k) => files.set(`https://v3b.fal.media/files/kit/${id}-${k}.png`, png));
      const images = masks.map((_, k) => ({ url: `https://v3b.fal.media/files/kit/${id}-${k}.png` }));
      results.set(id, endpoint.includes('birefnet') ? { image: images[0] } : { masks: images, ...(scores ? { scores } : {}) });
      return { requestId: id };
    },
    status: async () => 'COMPLETED', result: async (_endpoint, id) => results.get(id), cancel: async () => undefined,
    download: async url => { const png = files.get(url); if (!png) throw new Error(`No fake file at ${url}.`); return png; },
  };
  return { transport, submitted };
}

const here = dirname(fileURLToPath(import.meta.url));
/** Where this machine keeps saved runs (the main checkout's artifacts by default; FRAMEFLOW_REPLAY_ARTIFACTS overrides it). */
export const replayRoot = () => process.env.FRAMEFLOW_REPLAY_ARTIFACTS?.trim() || resolve(here, '../../../../artifacts/decomposition');
const REPLAY = { upload: 'template-executions/2026-10-09T05-53-16-448Z-f07c6a/upload.png', analysis: 'scene-analyses/2026-10-09T05-57-10-343Z-765fa9/analysis.json', run: 'layerize-experiment/2026-10-09T05-53-16-453Z-634021' };
type ReplayLayer = { file: string; name: string; placement: { kind: string; x: number; y: number; width: number; height: number }; semantic?: { type?: string } };
/**
 * The Mijia appliance creative of 2026-10-09: its upload (1254×1254), the real gpt-5.6-sol scene analysis of it, and a
 * real cutout of each product (the alpha of Seedream's own layer of it, placed on the canvas). Each cutout is matched to
 * the analysis object whose box centre is nearest. Undefined where these files are not on this machine.
 */
export async function mijiaReplay(root = replayRoot()) {
  const at = (path: string) => join(root, path);
  if (![REPLAY.upload, REPLAY.analysis, `${REPLAY.run}/run.json`].every(p => existsSync(at(p)))) return undefined;
  const source = readFileSync(at(REPLAY.upload)), meta = await sharp(source).metadata(), width = meta.width!, height = meta.height!;
  const scene = (JSON.parse(readFileSync(at(REPLAY.analysis), 'utf8')) as { scene: SceneDescription }).scene;
  const run = JSON.parse(readFileSync(at(`${REPLAY.run}/run.json`), 'utf8')) as { canvas: { width: number; height: number }; outputLayers: ReplayLayer[] };
  const sx = width / run.canvas.width, sy = height / run.canvas.height, products = [];
  for (const layer of run.outputLayers.filter(l => /product/.test(l.semantic?.type ?? '') && l.placement.kind !== 'base')) {
    const p = { x: Math.round(layer.placement.x * sx), y: Math.round(layer.placement.y * sy), width: Math.round(layer.placement.width * sx), height: Math.round(layer.placement.height * sy) };
    const alpha = await band(sharp(at(`${REPLAY.run}/${layer.file}`)).ensureAlpha().extractChannel(3).resize(p.width, p.height, { fit: 'fill' }));
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) { const X = p.x + x, Y = p.y + y; if (X >= 0 && Y >= 0 && X < width && Y < height) mask[Y * width + X] = alpha[y * p.width + x] >= 128 ? 255 : 0; }
    const cx = (p.x + p.width / 2) / width, cy = (p.y + p.height / 2) / height;
    const object = scene.objects.filter(o => o.kind === 'product').sort((a, b) => Math.hypot(a.box.x + a.box.w / 2 - cx, a.box.y + a.box.h / 2 - cy) - Math.hypot(b.box.x + b.box.w / 2 - cx, b.box.y + b.box.h / 2 - cy))[0];
    products.push({ id: object.id, label: object.label, layer: layer.name, mask });
  }
  return { source, width, height, scene, products };
}

/** Panels side by side with their labels, for a person to look at; written only when FRAMEFLOW_VISUAL_OUT is set. */
export async function writeVisual(name: string, panels: { label: string; png: Buffer }[], side = 420): Promise<string | undefined> {
  const dir = process.env.FRAMEFLOW_VISUAL_OUT?.trim();
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  const tiles = await Promise.all(panels.map(async p => {
    const image = await sharp(p.png).resize(side, side, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="28"><rect width="100%" height="100%" fill="#ffffff"/><text x="6" y="19" font-family="Helvetica, Arial" font-size="15" fill="#111">${p.label.replace(/[<&>]/g, '')}</text></svg>`);
    return sharp({ create: { width: side, height: side + 28, channels: 3, background: '#ffffff' } }).composite([{ input: label, left: 0, top: 0 }, { input: image, left: 0, top: 28 }]).png().toBuffer();
  }));
  const file = join(dir, `${name}.png`);
  writeFileSync(file, await sharp({ create: { width: tiles.length * (side + 8), height: side + 28, channels: 3, background: '#ffffff' } })
    .composite(tiles.map((t, k) => ({ input: t, left: k * (side + 8), top: 0 }))).png().toBuffer());
  return file;
}
