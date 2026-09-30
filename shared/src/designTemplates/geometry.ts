/**
 * Normalized ↔ pixel geometry for design templates: pure functions, no React, no Konva.
 *
 *   toPixels      pixelX = x × canvasWidth        pixelY = y × canvasHeight
 *                 pixelWidth = width × canvasWidth    pixelHeight = height × canvasHeight
 *   toNormalized  x = pixelX / canvasWidth        y = pixelY / canvasHeight   (and the same for width and height)
 *
 * The stored form is always normalized. Pixels are derived for one canvas and thrown away; they are converted back
 * only when the author drops or resizes an element, once, and only for the values that gesture changed. Stored values
 * are rounded to 6 decimals (finer than 1/100 px on a 4096 px canvas), which makes the round trip exact: converting a
 * stored layout to pixels and back returns the same numbers, however often and in whichever aspect ratio.
 */
import type { CanvasSize } from '../index.js';
import { LAYOUT_LIMITS, DESIGN_ASPECT_RATIOS, TemplateError, isDesignAspectRatio, type ImageFit, type NormalizedLayout, type DesignAspectRatio } from './schema.js';

/** A box in the pixels of one canvas: x, y is the top-left corner of the unrotated box; rotation in degrees about its centre. */
export interface PixelBox { x: number; y: number; width: number; height: number; rotation: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** A normalized value as stored: 6 decimals. */
export const roundNormalized = (value: number) => Math.round(value * LAYOUT_LIMITS.precision) / LAYOUT_LIMITS.precision;
/** Degrees in -180..180 (180 itself becomes -180), 2 decimals. */
export const normalizeRotation = (degrees: number) => Math.round(((((degrees + 180) % 360) + 360) % 360 - 180) * 100) / 100;

function requireCanvas(canvas: CanvasSize) {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) throw new TemplateError('INVALID_CANVAS', `The canvas size ${canvas.width} × ${canvas.height} is not valid.`);
}
function requireFinite(values: Record<string, number>, what: string) {
  for (const [key, value] of Object.entries(values)) if (typeof value !== 'number' || !Number.isFinite(value)) throw new TemplateError('INVALID_LAYOUT', `${what}: ${key} must be a finite number, not ${String(value)}.`);
}

/**
 * The nearest valid stored layout: sizes within minSize..1, the box kept inside the canvas (so x and y are never
 * negative and never push the box past the right or bottom edge), rotation within ±180°, all rounded for storage.
 * Values that are not finite numbers are refused, never guessed.
 */
export function clampLayout(layout: NormalizedLayout): NormalizedLayout {
  requireFinite({ x: layout.x, y: layout.y, width: layout.width, height: layout.height, rotation: layout.rotation }, 'Layout');
  const width = roundNormalized(clamp(layout.width, LAYOUT_LIMITS.minSize, 1)), height = roundNormalized(clamp(layout.height, LAYOUT_LIMITS.minSize, 1));
  return { x: roundNormalized(clamp(layout.x, 0, 1 - width)), y: roundNormalized(clamp(layout.y, 0, 1 - height)), width, height, rotation: normalizeRotation(layout.rotation) };
}

/** Normalized → pixels of this canvas. Never rounded: 5% of a 1250 px height is 62.5 px. */
export function toPixels(layout: NormalizedLayout, canvas: CanvasSize): PixelBox {
  requireCanvas(canvas);
  return { x: layout.x * canvas.width, y: layout.y * canvas.height, width: layout.width * canvas.width, height: layout.height * canvas.height, rotation: layout.rotation };
}
/** Pixels of this canvas → the stored normalized layout (rounded and clamped). */
export function toNormalized(box: PixelBox, canvas: CanvasSize): NormalizedLayout {
  requireCanvas(canvas);
  requireFinite({ x: box.x, y: box.y, width: box.width, height: box.height, rotation: box.rotation }, 'Pixel box');
  return clampLayout({ x: box.x / canvas.width, y: box.y / canvas.height, width: box.width / canvas.width, height: box.height / canvas.height, rotation: box.rotation });
}

/** width / height of "W:H". Throws for anything that is not two positive numbers. */
export function aspectRatioValue(ratio: string): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio), width = Number(match?.[1]), height = Number(match?.[2]);
  if (!match || !(width > 0) || !(height > 0)) throw new TemplateError('INVALID_ASPECT_RATIO', `"${ratio}" is not an aspect ratio; use width:height, e.g. 4:5.`);
  return width / height;
}
/** The short edge, in pixels, of the canvases the template tools render and export. */
export const TEMPLATE_SHORT_EDGE = 1080;
/** The canvas of a supported aspect ratio: its short edge is `shortEdge` (1:1 1080², 4:5 1080×1350, 3:4 1080×1440, 9:16 1080×1920, 16:9 1920×1080). */
export function designCanvasSize(ratio: DesignAspectRatio, shortEdge = TEMPLATE_SHORT_EDGE): CanvasSize {
  if (!isDesignAspectRatio(ratio)) throw new TemplateError('INVALID_ASPECT_RATIO', `Unsupported aspect ratio ${JSON.stringify(ratio)}; supported: ${DESIGN_ASPECT_RATIOS.join(', ')}.`);
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) throw new TemplateError('INVALID_CANVAS', `The canvas short edge ${shortEdge} is not valid.`);
  const value = aspectRatioValue(ratio);
  return value >= 1 ? { width: Math.round(shortEdge * value), height: shortEdge } : { width: shortEdge, height: Math.round(shortEdge / value) };
}

export const canvasShortEdge = (canvas: CanvasSize) => Math.min(canvas.width, canvas.height);
/**
 * Text scales with the canvas, not with a fixed pixel size: a font size is stored as a fraction of the canvas SHORT
 * edge, fontPx = fontSize × min(canvasWidth, canvasHeight). The short edge is used because it is what a portrait and a
 * landscape canvas of the same family share, so a heading keeps its visual weight when the ratio changes.
 */
export const fontPixels = (fontSize: number, canvas: CanvasSize) => fontSize * canvasShortEdge(canvas);
/** A corner radius of 0..1 (1 = pill) in pixels of a box: a fraction of half its shorter side. */
export const cornerRadiusPixels = (cornerRadius: number, box: Pick<PixelBox, 'width' | 'height'>) => clamp(cornerRadius, 0, 1) * Math.min(box.width, box.height) / 2;

/**
 * How an image fills a fixed box without being distorted. `crop` is the part of the image drawn (image pixels); `dest`
 * is where it is drawn, relative to the box. cover fills the box and crops what does not fit, keeping the focal point
 * in view; contain shows the whole image inside the box, placed by the focal point. The box itself never changes.
 */
export function imageFit(image: CanvasSize, box: CanvasSize, fit: ImageFit, focalX = 0.5, focalY = 0.5) {
  if (!(image.width > 0) || !(image.height > 0) || !(box.width > 0) || !(box.height > 0)) throw new TemplateError('INVALID_IMAGE', 'An image and its box need a positive size.');
  const fx = clamp(focalX, 0, 1), fy = clamp(focalY, 0, 1);
  if (fit === 'contain') {
    const scale = Math.min(box.width / image.width, box.height / image.height), width = image.width * scale, height = image.height * scale;
    return { crop: { x: 0, y: 0, width: image.width, height: image.height }, dest: { x: (box.width - width) * fx, y: (box.height - height) * fy, width, height } };
  }
  const scale = Math.max(box.width / image.width, box.height / image.height), width = box.width / scale, height = box.height / scale;
  return { crop: { x: (image.width - width) * fx, y: (image.height - height) * fy, width, height }, dest: { x: 0, y: 0, width: box.width, height: box.height } };
}

/** The centre of a box. Rotation turns the box about this point. */
export const boxCenter = (box: Pick<PixelBox, 'x' | 'y' | 'width' | 'height'>) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
/**
 * Where the top-left corner of a box ends up once it is rotated about its centre: the origin of a node that, like the
 * editor's elements, turns about its own top-left corner. An unrotated box is returned as it is, exactly.
 */
export function rotatedOrigin(box: PixelBox): { x: number; y: number } {
  if (!box.rotation) return { x: box.x, y: box.y };
  const radians = box.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians), center = boxCenter(box);
  return { x: center.x - (box.width / 2) * cos + (box.height / 2) * sin, y: center.y - (box.width / 2) * sin - (box.height / 2) * cos };
}
/** The inverse of rotatedOrigin: the unrotated box (turning about its centre) of a node at `origin` that turns about that origin. */
export function boxFromOrigin(origin: { x: number; y: number }, width: number, height: number, rotation: number): PixelBox {
  if (!rotation) return { x: origin.x, y: origin.y, width, height, rotation: 0 };
  const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const center = { x: origin.x + (width / 2) * cos - (height / 2) * sin, y: origin.y + (width / 2) * sin + (height / 2) * cos };
  return { x: center.x - width / 2, y: center.y - height / 2, width, height, rotation };
}
