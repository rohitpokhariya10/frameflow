/**
 * New background artwork for a recomposed variation (composition.ts), without text:
 *
 *   ai       one OpenAI image request (the image model, aiModels.ts; gpt-image-2 by default) per variation, only when the
 *            person approved its cost. The prompt asks for artwork only (no text, letters, numbers, logos, products or
 *            people) and for empty space where the products and the text will be placed.
 *   local    a preset backdrop drawn here (free, no AI): the template's own colours as a soft gradient, a stage under the
 *            products' zone and a gentle light; always labelled as a preset, never as AI artwork.
 *
 * Every AI artwork is read back with the local word reader (artwork-check) before it is used: text drawn by the model
 * fails the variation's checks (it would duplicate or contradict the editable text).
 */
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { imageFailure, ImageOperationError } from './imageOperation.js';
import type { Rgba } from '../pixels.js';
import type { WordRecognizer } from '../../../textRecognition/recognizer.js';
import { createOpenAIClient } from '../../../services/openAIClient.js';
import { imageModel } from '../../aiModels.js';
import type { ProductComposition } from './composition.js';

export type Save = (file: string, value: object) => void;
export interface ArtworkGenerator { model: string; offline: boolean; generate(input: { prompt: string; size: { width: number; height: number }; operationId?: string; signal?: AbortSignal }, save: Save): Promise<{ png: Buffer; costUsd?: number; requestId?: string }> }
/** One medium-quality artwork, an estimate from the price table (gpt-image-2, $30 / million output tokens): not measured. */
export const ARTWORK_COST_USD = 0.06;

/** The size an artwork is generated at for a canvas (the model's sizes; the picture is then cropped to the canvas). */
export function artworkSize(canvas: { width: number; height: number }) {
  const r = canvas.width / canvas.height;
  return r > 1.4 ? { width: 1536, height: 864 } : r > 1.1 ? { width: 1536, height: 1024 } : r > 0.9 ? { width: 1024, height: 1024 } : r > 0.7 ? { width: 1216, height: 1520 } : { width: 864, height: 1536 };
}

/** The artwork prompt: the direction, the theme and palette, where the products and text will go; never text itself. */
export function artworkPrompt(input: { direction: string; theme: string; palette: string[]; composition: ProductComposition; mood: string }) {
  const space = input.composition === 'stage-top' ? 'a calm open area across the top third for a headline, and a stage or floor across the lower middle where products will stand'
    : input.composition === 'stage-bottom' ? 'a stage or floor across the upper half where products will stand, and a calm open area across the lower third for text'
    : input.composition === 'split-left' ? 'a calm open area on the left half for text, and a stage or floor on the right half where products will stand'
    : 'a calm open area on the right half for text, and a stage or floor on the left half where products will stand';
  return [`Background artwork for a retail advertisement: ${input.theme}.`, input.direction ? `Creative direction: ${input.direction.slice(0, 400)}.` : '',
    `Mood: ${input.mood}. Palette: ${input.palette.slice(0, 5).join(', ') || 'the brand colours'}.`, `Composition: ${space}; keep the edges decorative and the centre of those areas uncluttered.`,
    'Artwork only: no text, no letters, no numbers, no words, no logos, no brand marks, no products, no appliances, no people or characters, no watermark.'].filter(Boolean).join(' ');
}

/** The live image model (one request, no retry); sent only after the person approved the cost. */
export function liveArtworkGenerator(options: { client?: ReturnType<typeof createOpenAIClient>; timeoutMs?: number } = {}): ArtworkGenerator {
  const model = imageModel(), timeoutMs = options.timeoutMs ?? 240_000;
  return { model, offline: false, async generate({ prompt, size, operationId = randomUUID(), signal }, save) {
    const request = { model, prompt, size: `${size.width}x${size.height}`, n: 1, quality: 'medium', output_format: 'png' } as const;
    const started = Date.now(); let providerRequestId: string | undefined, received = false;
    save('artwork.openai-request.json', { ...request, clientRequestId: operationId, startedAt: new Date(started).toISOString(), timeoutMs, maxRetries: 0 });
    try {
      const pending = (options.client ?? createOpenAIClient(process.env.OPENAI_API_KEY, timeoutMs)).images.generate(request as never, { maxRetries: 0, timeout: timeoutMs, signal, headers: { 'X-Client-Request-Id': operationId } });
      // Observe headers on the SAME request before JSON parsing. A truncated body can otherwise lose the request ID.
      const headers = pending.asResponse().then(response => {
        const id = response.headers.get('x-request-id');
        if (id && /^req_[a-zA-Z0-9_-]{1,96}$/.test(id)) providerRequestId = id;
        save('artwork.openai-headers.json', { clientRequestId: operationId, requestId: providerRequestId, status: response.status, elapsedMs: Date.now() - started });
      }).catch(() => undefined);
      const response = await pending as unknown as { data?: { b64_json?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } }; _request_id?: string };
      await headers; received = true;
      save('artwork.openai-response.json', { usage: response.usage, images: response.data?.length ?? 0, requestId: providerRequestId, elapsedMs: Date.now() - started, clientRequestId: operationId });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image returned');
      const u = response.usage, costUsd = u ? ((u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0) * 5 + (u.input_tokens_details?.image_tokens ?? 0) * 8 + (u.output_tokens ?? 0) * 30) / 1e6 : undefined;
      return { png: Buffer.from(b64, 'base64'), ...(costUsd !== undefined ? { costUsd } : {}), ...(providerRequestId ? { requestId: providerRequestId } : {}) };
    } catch (error) {
      const failure = imageFailure(error, received, providerRequestId);
      const diagnostic = { ...failure, clientRequestId: operationId, model, elapsedMs: Date.now() - started, timeoutMs, maxRetries: 0 };
      save('artwork.openai-error.json', diagnostic);
      console.error('OpenAI product image failed', diagnostic);
      throw new ImageOperationError(failure);
    }
  } };
}

/** The picture cropped to the canvas from its centre (never stretched). */
export async function fitArtwork(png: Buffer, canvas: { width: number; height: number }) {
  return sharp(png).resize(canvas.width, canvas.height, { fit: 'cover', position: 'centre' }).ensureAlpha().png().toBuffer();
}

/** A few colours of the template's own artwork (median colours of a coarse grid), lightest first. */
export function paletteOf(base: Rgba, count = 4): string[] {
  const cells: number[][] = [], step = Math.max(8, Math.round(Math.min(base.width, base.height) / 12));
  for (let y = 0; y + step <= base.height; y += step) for (let x = 0; x + step <= base.width; x += step) {
    const ch: number[][] = [[], [], []];
    for (let yy = y; yy < y + step; yy += 2) for (let xx = x; xx < x + step; xx += 2) { const i = (yy * base.width + xx) * 4; if (base.data[i + 3] < 200) continue; for (let c = 0; c < 3; c++) ch[c].push(base.data[i + c]); }
    if (ch[0].length) cells.push(ch.map(v => [...v].sort((a, b) => a - b)[v.length >> 1]));
  }
  const buckets = new Map<string, { c: number[]; n: number }>();
  for (const c of cells) { const k = c.map(v => v >> 5).join(','); const b = buckets.get(k); if (b) b.n++; else buckets.set(k, { c, n: 1 }); }
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count).map(b => b.c).sort((a, b) => lum(b) - lum(a)).map(c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`);
}

/** The free preset backdrop: a soft gradient of the palette, a light behind the products and a stage under them. */
export async function localBackdrop(canvas: { width: number; height: number }, palette: string[], stage: { x: number; y: number; width: number; height: number }, floor: number): Promise<Buffer> {
  const [light = '#ffffff', mid = '#e5e7eb', , deep = '#9ca3af'] = palette, W = canvas.width, H = canvas.height, cx = stage.x + stage.width / 2, fy = floor * H;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="0.65" stop-color="${mid}"/><stop offset="1" stop-color="${deep}"/></linearGradient>
    <radialGradient id="glow" cx="${cx / W}" cy="${(stage.y + stage.height * 0.45) / H}" r="0.45"><stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
    <ellipse cx="${cx}" cy="${fy}" rx="${stage.width * 0.6}" ry="${Math.max(8, stage.height * 0.09)}" fill="${deep}" opacity="0.45"/>
    <ellipse cx="${cx}" cy="${fy - Math.max(3, stage.height * 0.02)}" rx="${stage.width * 0.58}" ry="${Math.max(6, stage.height * 0.07)}" fill="${light}" opacity="0.9"/></svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().png().toBuffer();
}

/** Text the model drew into its artwork (the local word reader, free): words it reads with confidence. */
export async function artworkText(recognizer: WordRecognizer, png: Buffer): Promise<string[]> {
  const meta = await sharp(png).metadata();
  const words = await recognizer.recognize({ image: png, region: { x: 0, y: 0, width: meta.width ?? 1, height: meta.height ?? 1 }, purpose: 'artwork-check' });
  return words.filter(w => w.confidence >= 0.6 && w.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 3).map(w => w.text);
}

/**
 * A logo cut from the template's page (its crop keeps the page around it) knocked out for new artwork: when the crop's
 * border is one light colour (a white page), that colour becomes transparent, softly at the edges of the mark. Logos on
 * their own coloured tile (a bank's navy card) keep their tile. Null: nothing to knock out.
 */
export async function knockOutLogo(png: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), { width: w, height: h } = info;
  const border: number[][] = [];
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) border.push([...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)]);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) border.push([...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)]);
  const bg = [0, 1, 2].map(c => [...border.map(p => p[c])].sort((a, b) => a - b)[border.length >> 1]);
  const near = border.filter(p => Math.max(...[0, 1, 2].map(c => Math.abs(p[c] - bg[c]))) <= 18).length;
  if (Math.min(...bg) < 230 || near < border.length * 0.7) return null;
  let kept = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.max(...[0, 1, 2].map(c => Math.abs(data[i * 4 + c] - bg[c])));
    const a = d <= 14 ? 0 : d >= 60 ? 255 : Math.round((d - 14) / 46 * 255);
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], a); if (a > 0) kept++;
  }
  // A logo that is mostly the light colour itself (white letters on nothing) is left as it was.
  if (kept < w * h * 0.04) return null;
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/**
 * RECORDED artwork replayed (no network): pictures an approved live request returned, chosen by the canvas shape asked
 * for (wide, square, tall). Labelled as a replay, cost 0; for tests and demonstrations on real model output.
 */
export function replayArtworkGenerator(recorded: { wide?: Buffer; square?: Buffer; tall?: Buffer; model?: string }): ArtworkGenerator & { calls: number } {
  const g = { model: `${recorded.model ?? 'gpt-image-2'} (recorded artwork, replayed)`, offline: true, calls: 0, async generate({ size }: { prompt: string; size: { width: number; height: number } }, save: Save) {
    g.calls++;
    const r = size.width / size.height, png = r > 1.2 ? recorded.wide : r < 0.85 ? recorded.tall : recorded.square;
    if (!png) throw new Error(`No recorded artwork for a ${size.width}×${size.height} picture.`);
    save('artwork.replay.json', { replayed: true, size });
    return { png, costUsd: 0 };
  } };
  return g;
}
