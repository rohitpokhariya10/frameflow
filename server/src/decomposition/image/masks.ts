import sharp from 'sharp';
import type { ImageTransform } from './coordinates.js';
import { assertMask, assertSameSize, assertSize, ImageValidationError } from './types.js';
import type { Mask, Point, Rect } from './types.js';
export type { Mask } from './types.js';

export function emptyMask(width: number, height: number, value = 0): Mask {
  assertSize(width, height);
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

export async function decodeMask(bytes: Buffer, options: { encoding: 'luminance' | 'alpha'; binary?: boolean; invert?: boolean; threshold?: number }): Promise<Mask> {
  const image = sharp(bytes, { limitInputPixels: 12_000_000, failOn: 'warning' });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1) throw new ImageValidationError('MASK_ENCODING', 'A mask must be a single static image.');
  if (options.encoding === 'alpha' && !metadata.hasAlpha) throw new ImageValidationError('MASK_ENCODING', 'The expected alpha mask is missing an alpha channel.');
  const decoded = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = emptyMask(decoded.info.width, decoded.info.height);
  const threshold = options.threshold ?? 128;
  for (let i = 0; i < mask.data.length; i++) {
    let value = options.encoding === 'alpha' ? decoded.data[i * 4 + 3] : Math.round(0.2126 * decoded.data[i * 4] + 0.7152 * decoded.data[i * 4 + 1] + 0.0722 * decoded.data[i * 4 + 2]);
    if (options.invert) value = 255 - value;
    mask.data[i] = options.binary ? value >= threshold ? 255 : 0 : value;
  }
  return mask;
}

export async function encodeMask(mask: Mask): Promise<Buffer> {
  assertMask(mask);
  return sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
}

export function binaryMask(mask: Mask, threshold = 128): Mask {
  assertMask(mask);
  return { ...mask, data: mask.data.map(value => value >= threshold ? 255 : 0) };
}

/** Pixel-center resampling, with clamped edge samples; binary masks can never acquire gray pixels. */
export function resizeMask(mask: Mask, width: number, height: number, mode: 'binary' | 'alpha' = 'binary'): Mask {
  assertMask(mask, mode === 'binary');
  const output = emptyMask(width, height);
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * mask.height / height - 0.5;
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) * mask.width / width - 0.5;
      if (mode === 'binary') {
        output.data[y * width + x] = mask.data[Math.min(mask.height - 1, Math.max(0, Math.floor(sy + 0.5))) * mask.width + Math.min(mask.width - 1, Math.max(0, Math.floor(sx + 0.5)))];
      } else {
        const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
        const sample = (px: number, py: number) => mask.data[Math.max(0, Math.min(mask.height - 1, py)) * mask.width + Math.max(0, Math.min(mask.width - 1, px))];
        output.data[y * width + x] = Math.round(sample(left, top) * (1 - fx) * (1 - fy) + sample(left + 1, top) * fx * (1 - fy) + sample(left, top + 1) * (1 - fx) * fy + sample(left + 1, top + 1) * fx * fy);
      }
    }
  }
  return output;
}

export function cropMask(mask: Mask, bbox: Rect): Mask {
  assertMask(mask);
  if (![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isSafeInteger) || bbox.x < 0 || bbox.y < 0 || bbox.width < 1 || bbox.height < 1 || bbox.x + bbox.width > mask.width || bbox.y + bbox.height > mask.height) throw new ImageValidationError('CROP_BOUNDS', 'Mask crop is outside the image.');
  const output = emptyMask(bbox.width, bbox.height);
  for (let y = 0; y < bbox.height; y++) output.data.set(mask.data.subarray((bbox.y + y) * mask.width + bbox.x, (bbox.y + y) * mask.width + bbox.x + bbox.width), y * bbox.width);
  return output;
}

export function mapMaskToNative(mask: Mask, transform: ImageTransform, mode: 'binary' | 'alpha' = 'binary'): Mask {
  assertSameSize(mask, { width: transform.modelWidth, height: transform.modelHeight });
  const unpadded = cropMask(mask, { x: transform.padding.left, y: transform.padding.top, width: transform.resizedWidth, height: transform.resizedHeight });
  const crop = resizeMask(unpadded, transform.crop.width, transform.crop.height, mode);
  const output = emptyMask(transform.nativeWidth, transform.nativeHeight);
  for (let y = 0; y < crop.height; y++) output.data.set(crop.data.subarray(y * crop.width, (y + 1) * crop.width), (y + transform.crop.y) * output.width + transform.crop.x);
  return output;
}

export function combineMasks(a: Mask, b: Mask, operation: 'union' | 'intersection' | 'subtract'): Mask {
  assertMask(a); assertMask(b); assertSameSize(a, b);
  const data = a.data.map((value, i) => operation === 'union' ? Math.max(value, b.data[i]) : operation === 'intersection' ? Math.min(value, b.data[i]) : Math.min(value, 255 - b.data[i]));
  return { ...a, data };
}
export const unionMasks = (a: Mask, b: Mask): Mask => combineMasks(a, b, 'union');
export const intersectMasks = (a: Mask, b: Mask): Mask => combineMasks(a, b, 'intersection');
export const subtractMasks = (a: Mask, b: Mask): Mask => combineMasks(a, b, 'subtract');
export const invertMask = (mask: Mask): Mask => { assertMask(mask); return { ...mask, data: mask.data.map(value => 255 - value) }; };

export function maskBounds(mask: Mask, padding = 0): Rect | null {
  assertMask(mask);
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 4096) throw new ImageValidationError('MASK_PADDING', 'Mask padding must be a nonnegative bounded integer.');
  let left = mask.width, top = mask.height, right = -1, bottom = -1;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) {
    const x = i % mask.width, y = Math.floor(i / mask.width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return null;
  left = Math.max(0, left - padding); top = Math.max(0, top - padding);
  return { x: left, y: top, width: Math.min(mask.width, right + 1 + padding) - left, height: Math.min(mask.height, bottom + 1 + padding) - top };
}

export function overlapMasks(a: Mask, b: Mask): { intersection: number; union: number; iou: number; inclusionA: number; inclusionB: number } {
  assertMask(a); assertMask(b); assertSameSize(a, b);
  let intersection = 0, union = 0, areaA = 0, areaB = 0;
  for (let i = 0; i < a.data.length; i++) {
    const av = a.data[i] > 0, bv = b.data[i] > 0;
    if (av) areaA++; if (bv) areaB++; if (av && bv) intersection++; if (av || bv) union++;
  }
  return { intersection, union, iou: union ? intersection / union : 0, inclusionA: areaA ? intersection / areaA : 0, inclusionB: areaB ? intersection / areaB : 0 };
}

export function measureMask(mask: Mask): { area: number; areaFraction: number; bbox: Rect | null; componentCount: number; components: { area: number; bbox: Rect }[] } {
  assertMask(mask);
  const visited = new Uint8Array(mask.data.length), queue = new Int32Array(mask.data.length);
  const components: { area: number; bbox: Rect }[] = [];
  let area = 0, componentCount = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i] || visited[i]) continue;
    componentCount++;
    let front = 0, back = 1, componentArea = 0, left = mask.width, top = mask.height, right = 0, bottom = 0;
    queue[0] = i; visited[i] = 1;
    while (front < back) {
      const index = queue[front++], x = index % mask.width, y = Math.floor(index / mask.width);
      componentArea++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < mask.width ? index + 1 : -1, y > 0 ? index - mask.width : -1, y + 1 < mask.height ? index + mask.width : -1]) {
        if (neighbor >= 0 && mask.data[neighbor] && !visited[neighbor]) { visited[neighbor] = 1; queue[back++] = neighbor; }
      }
    }
    area += componentArea;
    // Diagnostic metadata is bounded; the actual mask retains every component.
    if (components.length < 256) components.push({ area: componentArea, bbox: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } });
  }
  return { area, areaFraction: area / mask.data.length, bbox: maskBounds(mask), componentCount, components };
}

export function deduplicateMasks(candidates: { id: string; mask: Mask }[], threshold = 0.95): { selected: { id: string; mask: Mask }[]; rejected: { id: string; reason: string; duplicateOf?: string }[]; nested: [string, string][] } {
  if (candidates.length > 64) throw new ImageValidationError('CANDIDATE_LIMIT', 'More than 64 mask candidates require a bounded selection review.');
  const selected: { id: string; mask: Mask }[] = [], rejected: { id: string; reason: string; duplicateOf?: string }[] = [], nested: [string, string][] = [];
  for (const candidate of candidates) {
    const area = candidate.mask.data.reduce((total, value) => total + Number(value > 0), 0);
    if (!area || area === candidate.mask.data.length) { rejected.push({ id: candidate.id, reason: area ? 'FULL_CANVAS_MASK' : 'EMPTY_MASK' }); continue; }
    const duplicate = selected.find(previous => overlapMasks(candidate.mask, previous.mask).iou >= threshold);
    if (duplicate) { rejected.push({ id: candidate.id, reason: 'DUPLICATE_MASK', duplicateOf: duplicate.id }); continue; }
    for (const previous of selected) {
      const overlap = overlapMasks(candidate.mask, previous.mask);
      if (Math.max(overlap.inclusionA, overlap.inclusionB) > 0.98) nested.push([previous.id, candidate.id]);
    }
    selected.push(candidate);
  }
  return { selected, rejected, nested };
}

/** Separable square morphology. The caller chooses a small scale-aware radius; no component is silently discarded. */
export function morphMask(mask: Mask, radius: number, operation: 'dilate' | 'erode'): Mask {
  assertMask(mask, true);
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > 64) throw new ImageValidationError('MASK_RADIUS', 'Morphology radius must be an integer between 0 and 64.');
  if (!radius) return { ...mask, data: mask.data.slice() };
  const pass = (input: Uint8Array, width: number, height: number, vertical: boolean): Uint8Array => {
    const output = new Uint8Array(input.length), length = vertical ? height : width, lines = vertical ? width : height;
    const at = (line: number, pos: number) => vertical ? pos * width + line : line * width + pos;
    for (let line = 0; line < lines; line++) {
      let count = 0;
      for (let pos = -radius; pos < length + radius; pos++) {
        if (pos >= 0 && pos < length && input[at(line, pos)]) count++;
        const departed = pos - 2 * radius - 1;
        if (departed >= 0 && departed < length && input[at(line, departed)]) count--;
        const center = pos - radius;
        if (center >= 0 && center < length) output[at(line, center)] = operation === 'dilate' ? count ? 255 : 0 : count === 2 * radius + 1 ? 255 : 0;
      }
    }
    return output;
  };
  return { ...mask, data: pass(pass(mask.data, mask.width, mask.height, false), mask.width, mask.height, true) };
}

export function constrainMatte(support: Mask, proposal: Mask, radius = 2, exclusions?: Mask): Mask {
  assertMask(support, true); assertMask(proposal); assertSameSize(support, proposal);
  if (exclusions) { assertMask(exclusions); assertSameSize(support, exclusions); }
  const foreground = morphMask(support, radius, 'erode'), permitted = morphMask(support, radius, 'dilate');
  return { ...support, data: support.data.map((_, i) => exclusions?.data[i] ? 0 : foreground.data[i] ? 255 : permitted.data[i] ? proposal.data[i] : 0) };
}

export function validateGuidance(mask: Mask, guidance: { positivePoints?: Point[]; negativePoints?: Point[]; excludedMask?: Mask; requiredMask?: Mask }): string[] {
  assertMask(mask);
  const warnings: string[] = [];
  const sample = (point: Point): number => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= mask.width || point.y >= mask.height) throw new ImageValidationError('GUIDANCE_BOUNDS', 'Guidance points must be inside the native image.');
    return mask.data[Math.floor(point.y) * mask.width + Math.floor(point.x)];
  };
  if (guidance.positivePoints?.some(point => sample(point) < 128)) warnings.push('POSITIVE_POINT_OUTSIDE_MASK');
  if (guidance.negativePoints?.some(point => sample(point) > 0)) warnings.push('NEGATIVE_GUIDANCE_LEAK');
  if (guidance.excludedMask && overlapMasks(mask, guidance.excludedMask).intersection > 0) warnings.push('PROTECTED_REGION_LEAK');
  if (guidance.requiredMask && overlapMasks(mask, guidance.requiredMask).inclusionB < 0.99) warnings.push('REQUIRED_VISIBLE_REGION_MISSING');
  const bounds = maskBounds(mask);
  if (!bounds) warnings.push('EMPTY_MASK');
  if (mask.data.every(value => value > 0)) warnings.push('FULL_CANVAS_MASK');
  return warnings;
}

export function applyBrush(mask: Mask, strokes: { mode: 'add' | 'subtract'; radius: number; points: Point[] }[]): Mask {
  assertMask(mask);
  if (strokes.length > 100 || strokes.reduce((count, stroke) => count + stroke.points.length, 0) > 10_000) throw new ImageValidationError('REVIEW_LIMIT', 'Reduce this correction to at most 100 strokes and 10,000 points.');
  const output = { ...mask, data: mask.data.slice() };
  for (const stroke of strokes) {
    if (!Number.isFinite(stroke.radius) || stroke.radius < 0.5 || stroke.radius > 256 || !['add', 'subtract'].includes(stroke.mode)) throw new ImageValidationError('REVIEW_BRUSH', 'Brush radius or mode is invalid.');
    let previous: Point | undefined;
    for (const point of stroke.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= mask.width || point.y >= mask.height) throw new ImageValidationError('GUIDANCE_BOUNDS', 'Brush points must use native image coordinates.');
      const start = previous ?? point, distance = Math.hypot(point.x - start.x, point.y - start.y), steps = Math.max(1, Math.ceil(distance / Math.max(0.5, stroke.radius / 2)));
      for (let step = 0; step <= steps; step++) {
        const cx = start.x + (point.x - start.x) * step / steps, cy = start.y + (point.y - start.y) * step / steps;
        for (let y = Math.max(0, Math.floor(cy - stroke.radius)); y < Math.min(mask.height, Math.ceil(cy + stroke.radius)); y++) for (let x = Math.max(0, Math.floor(cx - stroke.radius)); x < Math.min(mask.width, Math.ceil(cx + stroke.radius)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= stroke.radius ** 2) output.data[y * mask.width + x] = stroke.mode === 'add' ? 255 : 0;
        }
      }
      previous = point;
    }
  }
  return output;
}
