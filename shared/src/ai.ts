import { validateCanvasSize, type CanvasSize } from './index.js';

export const AI_LIMITS = { prompt: 2000, imageBytes: 8 * 1024 * 1024, imagePixels: 16_000_000, imageSide: 16_384 } as const;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = typeof IMAGE_MIMES[number];
export interface StyleBrief { theme: string; palette: string[]; motifs: string[]; mood: string }
export interface QuietRegion { x: number; y: number; width: number; height: number }
export interface GenerateRequest { prompt: string; target: CanvasSize; styleBrief: StyleBrief; quietRegion: QuietRegion }
export interface ImageResponse {
  requestId: string;
  image: { mimeType: ImageMime; base64: string; width: number; height: number };
  generation: { mode: 'live'; model: string; requestedAspectRatio: string; promptUsed: string };
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
    && g.mode === 'live' && short(g.model, 200) && short(g.requestedAspectRatio, 20) && short(g.promptUsed, 10_000);
}
