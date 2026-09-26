import { LAYER_LIMITS, TEXT_FONTS, TEXT_LIMITS, validateCanvasSize, type ProjectDocument } from '@frameflow/shared';

type Check = (value: unknown) => boolean;
const string: Check = (v) => typeof v === 'string' && v.length <= 10_000;
const id: Check = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/^(blob:|data:)/i.test(v);
const finite: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (min: number, max: number): Check => (v) => finite(v) && (v as number) >= min && (v as number) <= max;
const choice = (...values: unknown[]): Check => (v) => values.includes(v);
const date: Check = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const color: Check = (v) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
const array = (check: Check, max: number): Check => (v) => Array.isArray(v) && v.length <= max && v.every(check);
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  return Object.entries(required).every(([key, check]) => check(record[key]))
    && Object.entries(record).every(([key, value]) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](value)));
};
const text = object({
  id, type: choice('text'), role: choice('eyebrow', 'title', 'date', 'venue', 'body', 'custom'),
  text: (v) => typeof v === 'string' && v.length <= TEXT_LIMITS.maxCharacters,
  x: finite, y: finite, width: range(TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth),
  fontFamily: choice(...TEXT_FONTS), fontSize: range(TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize),
  fontWeight: choice(400, 600, 700), fill: color, align: choice('left', 'center', 'right'),
  lineHeight: (v) => finite(v) && (v as number) > 0, letterSpacing: finite,
});
const size = range(LAYER_LIMITS.minSide, LAYER_LIMITS.maxSide);
const layerBase = { id, name: string, x: finite, y: finite, width: size, height: size, rotation: range(-360, 360), opacity: range(0, 1), visible: choice(true, false), locked: choice(true, false) };
const layerSource = object({ jobId: id, layerId: id, kind: choice('image', 'text', 'shape') });
const imageLayer = object({ ...layerBase, type: choice('image'), assetId: id }, { source: layerSource,
  textSuggestion: object({ text: (v) => typeof v === 'string' && v.length <= TEXT_LIMITS.maxCharacters, confidence: choice('none', 'low') }, { fill: color, fontSize: range(TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize), fontWeight: choice(400, 600, 700) }) });
const shapeLayer = object({ ...layerBase, type: choice('shape'), shapeType: choice('rectangle', 'rounded-rectangle', 'ellipse'), fill: color, radius: range(0, LAYER_LIMITS.maxSide) }, { source: layerSource,
  gradient: object({ from: color, to: color, angle: range(-360, 360) }), stroke: object({ color, width: range(0, 1000) }) });
const layer: Check = (v) => imageLayer(v) || shapeLayer(v);
const uniqueIds: Check = (v) => Array.isArray(v) && new Set(v.map((item: { id: string }) => item.id)).size === v.length;
const canvas: Check = (v) => object({ width: finite, height: finite, backgroundColor: color }, { transparent: choice(true, false) })(v)
  && validateCanvasSize((v as { width: number }).width, (v as { height: number }).height).valid;
const variant = object({
  id, name: string, revision: (v) => Number.isSafeInteger(v) && (v as number) >= 0, canvas,
  elements: (v) => array(text, TEXT_LIMITS.maxElements)(v) && uniqueIds(v),
}, {
  background: object({ assetId: id, fit: choice('cover', 'contain'), focalPoint: object({ x: range(0, 1), y: range(0, 1) }) }),
  sourceVariantId: id,
  decomposition: object({ jobId: id, mode: choice('blank', 'original') }),
  layers: (v) => array(layer, LAYER_LIMITS.maxLayers)(v) && uniqueIds(v),
  generation: object({ mode: choice('live', 'example'), promptUsed: string, requestedAspectRatio: string,
    returnedWidth: range(1, 16384), returnedHeight: range(1, 16384) }, { provider: choice('gemini', 'cloudflare'), model: string, sourceAssetId: id }),
});
const project = object({
  schemaVersion: choice(1), id, name: string, createdAt: date, updatedAt: date,
  variants: (v) => Array.isArray(v) && v.length > 0 && array(variant, 30)(v) && uniqueIds(v),
}, { originalPrompt: string, styleBrief: object({ theme: string, palette: array(string, 50), motifs: array(string, 50), mood: string }) });

/** A single editable layer, with the same rules as persisted documents. */
export function isDesignLayer(value: unknown): boolean { return layer(value); }
/** A whole design version, with the same rules as persisted documents. */
export function isDesignVariant(value: unknown): boolean { return variant(value); }
/** A single text element, with the same rules as persisted documents. */
export function isTextElement(value: unknown): boolean { return text(value); }
/** Version 1 only. Unknown fields are rejected so runtime/UI data cannot leak into JSON. */
export function isProjectDocument(value: unknown): value is ProjectDocument { return project(value); }
