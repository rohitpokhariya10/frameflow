import { assertSize, ImageValidationError } from './types.js';
import type { Point, Rect } from './types.js';

export type ImageTransform = {
  nativeWidth: number; nativeHeight: number;
  crop: Rect;
  resizedWidth: number; resizedHeight: number;
  scaleX: number; scaleY: number;
  padding: { left: number; top: number; right: number; bottom: number };
  modelWidth: number; modelHeight: number;
  sampling: 'pixel-centers';
};

export function createTransform(width: number, height: number, maxSide = 1024, crop: Rect = { x: 0, y: 0, width, height }, padding = { left: 0, top: 0, right: 0, bottom: 0 }): ImageTransform {
  assertSize(width, height);
  if (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > 4096) throw new ImageValidationError('ANALYSIS_SIZE', 'Analysis size must be between 1 and 4096 pixels.');
  if (![crop.x, crop.y, crop.width, crop.height, ...Object.values(padding)].every(Number.isSafeInteger)
    || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height
    || Object.values(padding).some(value => value < 0)) throw new ImageValidationError('CROP_BOUNDS', 'Crop and padding must use integer native pixels inside the image.');
  const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
  const resizedWidth = Math.max(1, Math.round(crop.width * scale));
  const resizedHeight = Math.max(1, Math.round(crop.height * scale));
  const modelWidth = resizedWidth + padding.left + padding.right;
  const modelHeight = resizedHeight + padding.top + padding.bottom;
  assertSize(modelWidth, modelHeight);
  return { nativeWidth: width, nativeHeight: height, crop, resizedWidth, resizedHeight, scaleX: resizedWidth / crop.width,
    scaleY: resizedHeight / crop.height, padding, modelWidth, modelHeight, sampling: 'pixel-centers' };
}

/** Continuous coordinates; pixel i is sampled at i + 0.5. Boxes use exclusive right/bottom edges. */
export function nativeToModel(point: Point, transform: ImageTransform): Point {
  return { x: (point.x - transform.crop.x) * transform.scaleX + transform.padding.left,
    y: (point.y - transform.crop.y) * transform.scaleY + transform.padding.top };
}

export function modelToNative(point: Point, transform: ImageTransform): Point {
  return { x: (point.x - transform.padding.left) / transform.scaleX + transform.crop.x,
    y: (point.y - transform.padding.top) / transform.scaleY + transform.crop.y };
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
  if (!Object.values(rect).every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new ImageValidationError('CROP_BOUNDS', 'Bounds must be finite and nonnegative.');
  const snap = (value: number) => Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8 ? Math.round(value) : value;
  const x = Math.max(0, Math.min(width, Math.floor(snap(rect.x))));
  const y = Math.max(0, Math.min(height, Math.floor(snap(rect.y))));
  const right = Math.max(x, Math.min(width, Math.ceil(snap(rect.x + rect.width))));
  const bottom = Math.max(y, Math.min(height, Math.ceil(snap(rect.y + rect.height))));
  return { x, y, width: right - x, height: bottom - y };
}

export function modelRectToNative(rect: Rect, transform: ImageTransform): Rect {
  const topLeft = modelToNative(rect, transform);
  return clampRect({ ...topLeft, width: rect.width / transform.scaleX, height: rect.height / transform.scaleY }, transform.nativeWidth, transform.nativeHeight);
}

/** SAM3 output boxes are normalized center-x, center-y, width, height. */
export function normalizedCenterBoxToPixels(box: readonly [number, number, number, number], width: number, height: number): Rect {
  if (box.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new ImageValidationError('PROVIDER_BOX', 'Provider box coordinates are invalid.');
  return clampRect({ x: (box[0] - box[2] / 2) * width, y: (box[1] - box[3] / 2) * height, width: box[2] * width, height: box[3] * height }, width, height);
}
