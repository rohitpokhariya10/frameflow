import { maskBounds, measureMask, morphMask } from '../image/masks.js';
import type { Mask, Rect } from '../image/types.js';

/** Straight RGBA pixels of the original source at native resolution. */
export type SourcePixels = { data: Uint8Array | Buffer; width: number; height: number };
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

function meanColor(pixels: SourcePixels, include: (i: number) => boolean) {
  let r = 0, g = 0, b = 0, n = 0, r2 = 0, g2 = 0, b2 = 0;
  for (let i = 0; i < pixels.width * pixels.height; i++) {
    if (!include(i)) continue;
    const p = i * 4; r += pixels.data[p]; g += pixels.data[p + 1]; b += pixels.data[p + 2];
    r2 += pixels.data[p] ** 2; g2 += pixels.data[p + 1] ** 2; b2 += pixels.data[p + 2] ** 2; n++;
  }
  if (!n) return undefined;
  const mean = [r / n, g / n, b / n];
  const deviation = Math.sqrt(((r2 / n - mean[0] ** 2) + (g2 / n - mean[1] ** 2) + (b2 / n - mean[2] ** 2)) / 3);
  return { mean, deviation, count: n };
}
const distance = (a: number[], b: number[]) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0) / 3);

function iou(mask: Mask, inside: (x: number, y: number) => boolean, box: Rect) {
  let inter = 0, union = 0;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    const a = mask.data[y * mask.width + x] > 0, b = inside(x + 0.5, y + 0.5);
    if (a && b) inter++; if (a || b) union++;
  }
  // Mask pixels outside the bbox cannot exist (bbox is the mask bounds).
  return union ? inter / union : 0;
}

export type ShapeFit = {
  shapeType: 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'raster'; bbox: Rect; fitIoU: number; confidence: number;
  radius?: number; fill?: string; gradient?: { from: string; to: string; angle: number }; reasons: string[];
};

/**
 * Fit a simple vector shape to a native binary mask and estimate its fill from source pixels. A shape is only returned
 * when geometry and colour both fit well; otherwise the caller keeps the source-pixel raster. `occluders` marks source
 * pixels owned by elements in front (e.g. a person over a panel): geometry still uses the full shape, but colour is
 * sampled only where the shape itself is visible.
 */
export function fitShape(mask: Mask, pixels: SourcePixels, occluders?: Mask): ShapeFit {
  const bbox = maskBounds(mask);
  if (!bbox) return { shapeType: 'raster', bbox: { x: 0, y: 0, width: 0, height: 0 }, fitIoU: 0, confidence: 0, reasons: ['EMPTY_REGION'] };
  const area = measureMask(mask).area, boxArea = bbox.width * bbox.height, w = bbox.width, h = bbox.height;
  const cx = bbox.x + w / 2, cy = bbox.y + h / 2;
  const rectangle = area / boxArea;
  // Four corners each missing r²(1-π/4) pixels for a rounded rectangle of radius r.
  const radius = Math.min(Math.sqrt(Math.max(0, boxArea - area) / 4 / (1 - Math.PI / 4)), Math.min(w, h) / 2);
  const rounded = (x: number, y: number) => {
    const dx = Math.max(bbox.x + radius - x, 0, x - (bbox.x + w - radius)), dy = Math.max(bbox.y + radius - y, 0, y - (bbox.y + h - radius));
    return dx * dx + dy * dy <= radius * radius;
  };
  const candidates: { shapeType: ShapeFit['shapeType']; fit: number; radius?: number }[] = [
    { shapeType: 'rectangle', fit: rectangle },
    { shapeType: 'rounded-rectangle', fit: radius >= 2 ? iou(mask, rounded, bbox) : 0, radius },
    { shapeType: 'ellipse', fit: iou(mask, (x, y) => ((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2 <= 1, bbox) },
  ];
  const reasons: string[] = [];
  let best = [...candidates].sort((a, b) => b.fit - a.fit)[0];
  // Resampling nibbles a pixel or two off sharp corners; a near-zero radius is still a rectangle.
  if (best.shapeType === 'rounded-rectangle' && best.radius! < Math.max(3, Math.min(w, h) * 0.03) && candidates[0].fit >= 0.95) best = candidates.find(c => c.shapeType === 'rectangle')!;
  // Colour: interior only (edges carry antialiasing and neighbours). Quadrant means detect a linear gradient.
  const eroded = morphMask(mask, Math.max(1, Math.round(Math.min(w, h) * 0.03)), 'erode');
  const interior = occluders ? { ...eroded, data: eroded.data.map((v, i) => (v && !occluders.data[i] ? 255 : 0)) } : eroded;
  if (occluders && measureMask(interior).area < measureMask(eroded).area * 0.15) reasons.push('SHAPE_MOSTLY_OCCLUDED');
  const inQuadrant = (qx: number, qy: number) => (i: number) => {
    if (!interior.data[i]) return false;
    const x = i % mask.width, y = Math.floor(i / mask.width);
    return (qx < 0 || (x < cx) === (qx === 0)) && (qy < 0 || (y < cy) === (qy === 0));
  };
  const all = meanColor(pixels, i => interior.data[i] > 0);
  if (!all) return { shapeType: 'raster', bbox, fitIoU: best.fit, confidence: 0, reasons: [...reasons, 'NO_INTERIOR'] };
  const [left, right, top, bottom, topLeft, bottomRight] = [inQuadrant(0, -1), inQuadrant(1, -1), inQuadrant(-1, 0), inQuadrant(-1, 1), inQuadrant(0, 0), inQuadrant(1, 1)].map(fn => meanColor(pixels, fn));
  const pairs = [
    { angle: 0, from: left, to: right }, { angle: 90, from: top, to: bottom }, { angle: 45, from: topLeft, to: bottomRight },
  ].filter(p => p.from && p.to).map(p => ({ ...p, delta: distance(p.from!.mean, p.to!.mean) })).sort((a, b) => b.delta - a.delta);
  const gradient = pairs[0] && pairs[0].delta > 18 ? { from: hex(...(pairs[0].from!.mean as [number, number, number])), to: hex(...(pairs[0].to!.mean as [number, number, number])), angle: pairs[0].angle } : undefined;
  // Texture that neither a flat fill nor a two-stop gradient explains (photos, patterns) cannot become a vector.
  const residual = gradient ? Math.max(pairs[0].from!.deviation, pairs[0].to!.deviation) : all.deviation;
  if (residual > 26) reasons.push('TEXTURED_FILL');
  if (best.fit < 0.93) reasons.push('GEOMETRY_NOT_SIMPLE');
  const confidence = reasons.length ? Math.min(0.4, best.fit * 0.4) : best.fit >= 0.97 ? 0.9 : 0.7;
  if (reasons.length) return { shapeType: 'raster', bbox, fitIoU: best.fit, confidence, reasons };
  return { shapeType: best.shapeType, bbox, fitIoU: best.fit, confidence, ...(best.shapeType === 'rounded-rectangle' ? { radius: Math.round(best.radius!) } : {}),
    fill: hex(...(all.mean as [number, number, number])), ...(gradient ? { gradient } : {}), reasons };
}

export type TextEstimate = { text: string; textConfidence: 'none' | 'low'; suggestionSource?: 'provider-description' | 'provider-label'; color?: string; fontSize?: number; fontWeight?: 400 | 600 | 700; alignment: 'left'; confidence: number };

const STOP = /\s+(?:below|above|under|over|at|on|in|positioned|located|with|near|beside|next to|across)\b.*$/i;
/**
 * Suggest text content from provider wording only (no OCR is available). Every suggestion is low confidence and the
 * source-pixel raster stays the faithful representation until a user confirms or edits the text.
 */
export function suggestText(label: string, description = ''): Pick<TextEstimate, 'text' | 'textConfidence' | 'suggestionSource'> {
  const quoted = description.match(/["“']([^"”']{1,200})["”']/);
  if (quoted) return { text: quoted[1].trim(), textConfidence: 'low', suggestionSource: 'provider-description' };
  const reading = description.match(/\breading\s+(.{1,200}?)(?:[.;]|$)/i);
  if (reading) return { text: reading[1].replace(STOP, '').replace(/[\s,;:]+$/, '').trim(), textConfidence: 'low', suggestionSource: 'provider-description' };
  const list = description.match(/\btexts?\b[^:]{0,60}:\s*(.{1,400}?)(?:\.\s|\.$|$)/i);
  if (list) return { text: list[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean).join('\n'), textConfidence: 'low', suggestionSource: 'provider-description' };
  const shouted = (description.match(/\b([A-Z0-9][A-Z0-9&'!-]{1,}(?:\s+[A-Z0-9][A-Z0-9&'!-]+)*)\s+text\b/) ?? label.match(/\b([A-Z0-9][A-Z0-9&'!-]{1,}(?:\s+[A-Z0-9][A-Z0-9&'!-]+)*)\b/));
  if (shouted) return { text: shouted[1], textConfidence: 'low', suggestionSource: description.includes(shouted[0]) ? 'provider-description' : 'provider-label' };
  return { text: '', textConfidence: 'none' };
}

/** Style estimate from glyph pixels: colour from the source under confident alpha, size/weight from geometry. */
export function estimateTextStyle(alpha: Mask, pixels: SourcePixels): Pick<TextEstimate, 'color' | 'fontSize' | 'fontWeight'> {
  const strong: Mask = { ...alpha, data: alpha.data.map(v => (v >= 200 ? 255 : 0)) };
  const bbox = maskBounds(strong) ?? maskBounds(alpha);
  if (!bbox) return {};
  const color = meanColor(pixels, i => strong.data[i] > 0);
  const density = measureMask(strong).area / (bbox.width * bbox.height);
  return { ...(color ? { color: hex(...(color.mean as [number, number, number])) } : {}), fontSize: Math.max(8, Math.round(bbox.height * 0.8)), fontWeight: density >= 0.42 ? 700 : density >= 0.3 ? 600 : 400 };
}
