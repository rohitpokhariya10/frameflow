import { validateCanvasSize, type CanvasSize } from './index.js';

export const AI_LIMITS = { prompt: 2000, imageBytes: 8 * 1024 * 1024, imagePixels: 16_000_000, imageSide: 16_384 } as const;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = typeof IMAGE_MIMES[number];
export type ImageProvider = 'gemini' | 'cloudflare';
export interface StyleBrief { theme: string; palette: string[]; motifs: string[]; mood: string }
export interface QuietRegion { x: number; y: number; width: number; height: number }
export interface GenerateRequest { prompt: string; target: CanvasSize; styleBrief: StyleBrief; quietRegion: QuietRegion }
// Application transport limits; the provider adapter owns multipart field names.
export const ADAPT_LIMITS = { referenceSide: 511, referenceBytes: 2 * 1024 * 1024, requestBytes: 3 * 1024 * 1024 } as const;
export type AdaptFormat = 'poster' | 'landscape' | 'story' | 'square' | 'custom';
export interface AdaptRequest extends GenerateRequest {
  format: AdaptFormat;
  source: { projectId: string; variantId: string; revision: number; assetId: string; width: number; height: number };
  referenceImage: { mimeType: 'image/png'; base64: string; width: number; height: number };
}
export interface ImageResponse {
  requestId: string;
  image: { mimeType: ImageMime; base64: string; width: number; height: number };
  generation: { mode: 'live'; provider?: ImageProvider; model: string; requestedAspectRatio: string; promptUsed: string };
}
export interface ApiError { error: { code: string; message: string; retryable: boolean; requestId: string } }
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const short = (v: unknown, limit: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= limit;
export function validStyleBrief(v: unknown): v is StyleBrief {
  return record(v) && short(v.theme, 100) && short(v.mood, 200)
    && [v.palette, v.motifs].every((list) => Array.isArray(list) && list.length <= 8 && list.every((item) => short(item, 100)));
}
export function validGenerateRequest(v: unknown): v is GenerateRequest {
  if (!record(v) || !short(v.prompt, AI_LIMITS.prompt) || !record(v.target) || !validStyleBrief(v.styleBrief) || !record(v.quietRegion)) return false;
  const { width, height } = v.target;
  if (typeof width !== 'number' || typeof height !== 'number' || !validateCanvasSize(width, height).valid) return false;
  const q = v.quietRegion;
  return [q.x, q.y, q.width, q.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
    && (q.width as number) > 0 && (q.height as number) > 0
    && (q.x as number) + (q.width as number) <= 1 && (q.y as number) + (q.height as number) <= 1;
}
export function validImageResponse(v: unknown): v is ImageResponse {
  if (!record(v) || !short(v.requestId, 200) || !record(v.image) || !record(v.generation)) return false;
  const i = v.image, g = v.generation;
  return IMAGE_MIMES.includes(i.mimeType as ImageMime) && short(i.base64, Math.ceil(AI_LIMITS.imageBytes / 3) * 4)
    && Number.isSafeInteger(i.width) && Number.isSafeInteger(i.height) && (i.width as number) > 0 && (i.height as number) > 0
    && (i.width as number) <= AI_LIMITS.imageSide && (i.height as number) <= AI_LIMITS.imageSide
    && (i.width as number) * (i.height as number) <= AI_LIMITS.imagePixels
    && g.mode === 'live' && (g.provider === undefined || g.provider === 'gemini' || g.provider === 'cloudflare')
    && short(g.model, 200) && short(g.requestedAspectRatio, 20) && short(g.promptUsed, 10_000);
}

export function validAdaptRequest(v: unknown): v is AdaptRequest {
  if (!validGenerateRequest(v)) return false;
  const a = v as unknown as Record<string, unknown>;
  if (!['poster', 'landscape', 'story', 'square', 'custom'].includes(a.format as string) || !record(a.source) || !record(a.referenceImage)) return false;
  const s = a.source, i = a.referenceImage;
  const presets: Record<string, CanvasSize> = { poster: { width: 1080, height: 1350 }, landscape: { width: 1600, height: 900 }, story: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } };
  const preset = presets[a.format as string];
  return (!preset || (preset.width === v.target.width && preset.height === v.target.height))
    && ['projectId', 'variantId', 'assetId'].every((key) => short(s[key], 200) && !/^(blob:|data:|https?:|\/)/i.test(s[key] as string))
    && Number.isSafeInteger(s.revision) && (s.revision as number) >= 0
    && typeof s.width === 'number' && typeof s.height === 'number' && validateCanvasSize(s.width, s.height).valid
    && i.mimeType === 'image/png' && short(i.base64, Math.ceil(ADAPT_LIMITS.referenceBytes / 3) * 4)
    && [i.width, i.height].every((n) => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= ADAPT_LIMITS.referenceSide);
}
