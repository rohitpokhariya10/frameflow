/** Verified against the linked fal model API pages on 2026-09-26. */
export const endpointRegistry = {
  qwen: { endpoint: 'fal-ai/qwen-image-layered', adapterVersion: '1', outputField: 'images', encoding: 'rgba-alpha' },
  sam2: { endpoint: 'fal-ai/sam2/auto-segment', adapterVersion: '1', outputField: 'individual_masks', encoding: 'luminance' },
  sam3: { endpoint: 'fal-ai/sam-3-1/image', adapterVersion: '2', outputField: 'masks', encoding: 'luminance' },
  birefnet: { endpoint: 'fal-ai/birefnet/v2', adapterVersion: '1', outputField: 'image', encoding: 'luminance' },
  finegrain: { endpoint: 'fal-ai/finegrain-eraser/mask', adapterVersion: '1', outputField: 'image', encoding: 'rgb' },
  flux: { endpoint: 'fal-ai/flux-pro/v1/fill', adapterVersion: '1', outputField: 'images', encoding: 'rgb' },
} as const;

export type Model = keyof typeof endpointRegistry;
export type ProviderInput = Record<string, unknown>;
export type ProviderImage = { url: string; width?: number; height?: number; contentType?: string };
export type NormalizedProviderOutput = {
  images: ProviderImage[];
  encoding: 'rgba-alpha' | 'luminance' | 'rgb';
  seed?: number;
  scores?: number[];
  /** Normalized cx,cy,w,h, NEVER pixel-space input boxes. */
  boxes?: [number, number, number, number][];
};

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false, public readonly status?: number, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type ProviderInputOptions = {
  imageUrl: string;
  width?: number;
  height?: number;
  maskUrl?: string;
  maskWidth?: number;
  maskHeight?: number;
  prompt?: string;
  highResolutionMatte?: boolean;
  numLayers?: number;
  maxMasks?: number;
  seed?: number;
  points?: { x: number; y: number; label: 0 | 1; objectId?: number }[];
  boxes?: { x: number; y: number; width: number; height: number; objectId?: number }[];
};

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProviderError('INVALID_PROVIDER_INPUT', `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function imageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new ProviderError('INVALID_PROVIDER_INPUT', 'A bounded HTTPS image URL is required.');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return value;
  } catch { throw new ProviderError('INVALID_PROVIDER_INPUT', 'A valid HTTPS image URL is required.'); }
}

function prompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new ProviderError('INVALID_PROVIDER_INPUT', 'Supply an explicit object or completion prompt (1–2000 characters).');
  }
  return value.trim();
}

/** Only these builders may create network input. Dimensions are local validation, never invented API fields. */
export function buildProviderInput(model: Model, options: ProviderInputOptions): ProviderInput {
  const input: ProviderInput = { image_url: imageUrl(options.imageUrl) };
  if (options.seed !== undefined && ['qwen', 'finegrain', 'flux'].includes(model)) input.seed = integer(options.seed, 0, 2147483647, 'seed');
  switch (model) {
    case 'qwen': return { ...input, num_layers: integer(options.numLayers ?? 4, 1, 6, 'numLayers'), output_format: 'png', enable_safety_checker: true };
    case 'sam2': return { ...input, output_format: 'png', points_per_side: 32, pred_iou_thresh: 0.88, stability_score_thresh: 0.95, min_mask_region_area: 0 };
    case 'sam3': {
      const width = integer(options.width, 1, 4096, 'width');
      const height = integer(options.height, 1, 4096, 'height');
      if ((options.points?.length ?? 0) > 128 || (options.boxes?.length ?? 0) > 8) throw new ProviderError('INVALID_PROVIDER_INPUT', 'Too many guidance points or boxes.');
      const point_prompts = (options.points ?? []).map(point => ({
        x: integer(point.x, 0, width - 1, 'point.x'), y: integer(point.y, 0, height - 1, 'point.y'),
        label: integer(point.label, 0, 1, 'point.label'),
        ...(point.objectId === undefined ? {} : { object_id: integer(point.objectId, 0, 63, 'objectId') }),
      }));
      const box_prompts = (options.boxes ?? []).map(box => {
        const x = integer(box.x, 0, width - 1, 'box.x');
        const y = integer(box.y, 0, height - 1, 'box.y');
        return { x_min: x, y_min: y, x_max: x + integer(box.width, 1, width - x, 'box.width'), y_max: y + integer(box.height, 1, height - y, 'box.height'),
          ...(box.objectId === undefined ? {} : { object_id: integer(box.objectId, 0, 63, 'objectId') }) };
      });
      return { ...input, prompt: prompt(options.prompt), point_prompts, box_prompts, apply_mask: false, output_format: 'png', return_multiple_masks: true, max_masks: integer(options.maxMasks ?? 3, 1, 6, 'maxMasks'), include_scores: true, include_boxes: true };
    }
    case 'birefnet': return { ...input, model: options.highResolutionMatte ? 'General Use (Dynamic)' : 'Matting', operating_resolution: options.highResolutionMatte ? '2048x2048' : '1024x1024', mask_only: true, output_format: 'png' };
    case 'finegrain':
    case 'flux': {
      const width = integer(options.width, 1, 4096, 'width');
      const height = integer(options.height, 1, 4096, 'height');
      if (options.maskWidth !== width || options.maskHeight !== height) throw new ProviderError('MASK_DIMENSION_MISMATCH', 'Image and white-means-edit mask must have identical dimensions.');
      const mask_url = imageUrl(options.maskUrl);
      return model === 'finegrain' ? { ...input, mask_url, mode: 'standard' } : { ...input, mask_url, prompt: prompt(options.prompt), num_images: 1, output_format: 'png' };
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Provider returned an invalid response object.');
  return value as Record<string, unknown>;
}

function parseImage(value: unknown): ProviderImage {
  const source = record(value);
  let url: string;
  try { url = imageUrl(source.url); } catch { throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Provider returned an invalid image URL.'); }
  const result: ProviderImage = { url };
  for (const dimension of ['width', 'height'] as const) {
    if (source[dimension] !== undefined) {
      if (!Number.isSafeInteger(source[dimension]) || (source[dimension] as number) < 1 || (source[dimension] as number) > 16384) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Provider image dimensions are invalid.');
      result[dimension] = source[dimension] as number;
    }
  }
  if (source.content_type !== undefined) {
    if (typeof source.content_type !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(source.content_type)) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Provider returned an unsupported image encoding.');
    result.contentType = source.content_type;
  }
  return result;
}

export function normalizeProviderOutput(model: Model, value: unknown, candidateCap = 64): NormalizedProviderOutput {
  const source = record(value);
  if (source.has_nsfw_concepts !== undefined) {
    if (!Array.isArray(source.has_nsfw_concepts) || source.has_nsfw_concepts.some(item => typeof item !== 'boolean')) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Invalid provider safety response.');
    if (source.has_nsfw_concepts.some(Boolean)) throw new ProviderError('PROVIDER_SAFETY_REFUSAL', 'The provider declined this image under its safety policy.');
  }
  const adapter = endpointRegistry[model];
  const raw = source[adapter.outputField];
  const list = adapter.outputField === 'image' ? [raw] : raw;
  if (!Array.isArray(list) || !list.length) throw new ProviderError('PROVIDER_EMPTY_OUTPUT', 'The provider returned no usable image candidates.');
  if (list.length > candidateCap || (model === 'qwen' && list.length > 6) || (model === 'flux' && list.length !== 1)) throw new ProviderError('PROVIDER_CANDIDATE_LIMIT', 'The provider returned too many candidates; select a narrower target and retry.');
  const output: NormalizedProviderOutput = { images: list.map(parseImage), encoding: adapter.encoding };
  const seed = source.seed ?? source.used_seed;
  if (seed !== undefined) {
    if (!Number.isSafeInteger(seed) || (seed as number) < 0) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Invalid provider seed.');
    output.seed = seed as number;
  }
  if (model === 'sam3' && source.scores !== undefined) {
    if (!Array.isArray(source.scores) || source.scores.length !== list.length || source.scores.some(score => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Invalid segmentation scores.');
    output.scores = source.scores as number[];
  }
  if (model === 'sam3' && source.boxes !== undefined) {
    if (!Array.isArray(source.boxes) || source.boxes.length !== list.length || source.boxes.some(box => !Array.isArray(box) || box.length !== 4 || box.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Invalid normalized segmentation boxes.');
    output.boxes = source.boxes as [number, number, number, number][];
  }
  return output;
}

export function normalizedBoxToPixels(box: [number, number, number, number], width: number, height: number) {
  const [cx, cy, w, h] = box;
  const left = Math.max(0, Math.floor((cx - w / 2) * width));
  const top = Math.max(0, Math.floor((cy - h / 2) * height));
  const right = Math.min(width, Math.ceil((cx + w / 2) * width));
  const bottom = Math.min(height, Math.ceil((cy + h / 2) * height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Only erase failure/schema/availability permits the configured fill fallback. */
export function mayFallbackErase(error: unknown): boolean {
  return error instanceof ProviderError && ['PROVIDER_SCHEMA_CHANGED', 'PROVIDER_EMPTY_OUTPUT', 'PROVIDER_INVALID_IMAGE', 'PROVIDER_ALIGNMENT', 'PROVIDER_UNAVAILABLE'].includes(error.code);
}
