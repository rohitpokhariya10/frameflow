import sharp from 'sharp';
import type { DiscoveryProviderName, DiscoverySourceRegistration } from '@frameflow/shared';
import { binaryMask, decodeMask, measureMask } from '../image/masks.js';
import type { Rect } from '../image/types.js';
import { endpointRegistry, ProviderError } from '../providers/adapters.js';
import type { ProviderLayerMetadata } from '../providers/adapters.js';
import type { Infer } from '../providers/inference.js';
import { createLayerProposals, type LayerProposal } from './proposals.js';

export const DISCOVERY_CONTRACT_VERSION = 'discovery-v1';
/** Proposal review accepts at most 12 targets; extra provider layers are dropped smallest-first. */
export const MAX_DISCOVERY_PROPOSALS = 12;
const SEEDREAM_MIN_SIDE = 512, SEEDREAM_MAX_SIDE = 6000, ASPECT_TOLERANCE = 0.01, BBOX_SIZE_TOLERANCE = 2;

export type DiscoveryPlan = { primary: DiscoveryProviderName; fallback?: DiscoveryProviderName };
/** Discovery evidence only: provider RGB is never used as final source pixels. */
export type DiscoveryProposal = LayerProposal & {
  provider: DiscoveryProviderName; providerModel: string; labelSource: 'provider' | 'generic';
  description?: string; zIndex?: number; providerOrder: number;
  /** Provider-declared box, mapped to analysis pixels. */
  providerBbox?: Rect;
  /** Box of nonzero proposal alpha in analysis pixels. */
  bounds: Rect | null; coverage: number;
  sourceRegistration: DiscoverySourceRegistration;
  /** Informational disagreements that do not block use as discovery evidence. */
  metadataWarnings: string[];
};
export type DiscoveryBaseLayer = { rgba: Buffer; width: number; height: number; zIndex: number; name?: string; description?: string; sourceRegistration: DiscoverySourceRegistration };
export type DiscoveryAttempt = { provider: DiscoveryProviderName; providerModel: string; outcome: 'used' | 'failed' | 'unreliable'; code?: string; providerRequestId?: string; proposalCount?: number };
export type DiscoveryResult = {
  provider: DiscoveryProviderName; providerModel: string; proposals: DiscoveryProposal[]; baseLayer?: DiscoveryBaseLayer;
  warnings: string[]; attempts: DiscoveryAttempt[]; fallbackFrom?: DiscoveryProviderName; providerRequestId?: string; deterministic: boolean;
};

/**
 * Errors after which a different discovery provider may safely be tried. Ambiguous submissions,
 * auth/credit/rate-limit failures, safety refusals, cancellation and stale leases never fall back:
 * they would duplicate a possibly charged call, fail identically, or bypass policy.
 */
const FALLBACK_CODES = new Set(['PROVIDER_EMPTY_OUTPUT', 'PROVIDER_INVALID_IMAGE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_SCHEMA_CHANGED', 'PROVIDER_CANDIDATE_LIMIT',
  'PROVIDER_REJECTED', 'PROVIDER_DEADLINE', 'PROVIDER_OUTPUT_UNAVAILABLE', 'PROVIDER_NETWORK', 'INVALID_PROVIDER_INPUT', 'DISCOVERY_INPUT_UNSUPPORTED']);
export function mayFallbackDiscovery(error: unknown): error is ProviderError {
  return error instanceof ProviderError && FALLBACK_CODES.has(error.code);
}

const usable = (proposals: DiscoveryProposal[]) => proposals.filter(p => p.registered && !p.warnings.length).length;
const modelOf = (provider: DiscoveryProviderName) => endpointRegistry[provider].endpoint;

export async function discoverLayers(analysis: Buffer, infer: Infer, options: { plan: DiscoveryPlan; count?: number }): Promise<DiscoveryResult> {
  const order = [...new Set([options.plan.primary, ...(options.plan.fallback ? [options.plan.fallback] : [])])];
  const attempts: DiscoveryAttempt[] = [];
  let unreliable: DiscoveryResult | undefined;
  for (const [index, provider] of order.entries()) {
    const last = index === order.length - 1;
    let result: DiscoveryResult;
    try {
      result = provider === 'seedream' ? await seedreamDiscovery(analysis, infer) : await qwenDiscovery(analysis, infer, options.count ?? 4);
    } catch (error) {
      if (!mayFallbackDiscovery(error)) throw error;
      attempts.push({ provider, providerModel: modelOf(provider), outcome: 'failed', code: error.code });
      if (!last) continue;
      if (unreliable) return finish(unreliable, attempts, order[0]);
      // Same contract as Qwen-only discovery: proceed to review with no proposals rather than fail the job.
      return finish({ provider, providerModel: modelOf(provider), proposals: [], warnings: ['PROPOSAL_UNRELIABLE', error.code], attempts: [], deterministic: provider === 'qwen' }, attempts, order[0]);
    }
    const count = usable(result.proposals);
    // Qwen reports its own recoverable failures as empty proposals with warnings.
    const qwenFailure = provider === 'qwen' && !result.proposals.length ? result.warnings.find(w => w !== 'PROPOSAL_UNRELIABLE') : undefined;
    attempts.push({ provider, providerModel: result.providerModel, outcome: count ? 'used' : qwenFailure ? 'failed' : 'unreliable', code: count ? undefined : qwenFailure ?? 'DISCOVERY_UNRELIABLE', providerRequestId: result.providerRequestId, proposalCount: result.proposals.length });
    if (count || last) {
      // Keep richer earlier evidence when the fallback also found nothing usable.
      return finish(!count && unreliable && unreliable.proposals.length >= result.proposals.length ? unreliable : result, attempts, order[0]);
    }
    unreliable ??= result;
  }
  throw new Error('Discovery plan has no providers.');
}

function finish(result: DiscoveryResult, attempts: DiscoveryAttempt[], primary: DiscoveryProviderName): DiscoveryResult {
  const warnings = new Set(result.warnings);
  if (result.provider !== primary) warnings.add('DISCOVERY_FALLBACK_USED');
  return { ...result, attempts, warnings: [...warnings], ...(result.provider !== primary ? { fallbackFrom: primary } : {}) };
}

async function qwenDiscovery(analysis: Buffer, infer: Infer, count: number): Promise<DiscoveryResult> {
  const result = await createLayerProposals(analysis, infer, count);
  const proposals = result.proposals.map((proposal, providerOrder): DiscoveryProposal => {
    const measured = measureMask(proposal.alpha);
    return { ...proposal, provider: 'qwen', providerModel: modelOf('qwen'), labelSource: 'generic', providerOrder, bounds: measured.bbox, coverage: measured.areaFraction, metadataWarnings: [],
      sourceRegistration: { method: proposal.registered ? 'full-canvas' : 'unregistered', providerWidth: proposal.width, providerHeight: proposal.height, scaleX: 1, scaleY: 1 } };
  });
  return { provider: 'qwen', providerModel: modelOf('qwen'), proposals, warnings: result.warnings, attempts: [], deterministic: true };
}

/** Seedream accepts 512–6000 px sides with aspect 1/16–16; upscale small analysis images uniformly, never distort. */
export async function prepareSeedreamInput(analysis: Buffer): Promise<{ image: Buffer; width: number; height: number; analysisWidth: number; analysisHeight: number }> {
  const { width = 0, height = 0 } = await sharp(analysis).metadata();
  if (!width || !height || width / height > 16 || height / width > 16) throw new ProviderError('DISCOVERY_INPUT_UNSUPPORTED', 'Seedream layerize requires an aspect ratio between 1/16 and 16.');
  const scale = Math.max(1, SEEDREAM_MIN_SIDE / Math.min(width, height));
  const targetWidth = Math.round(width * scale), targetHeight = Math.round(height * scale);
  if (Math.max(targetWidth, targetHeight) > SEEDREAM_MAX_SIDE || Math.min(targetWidth, targetHeight) < SEEDREAM_MIN_SIDE) throw new ProviderError('DISCOVERY_INPUT_UNSUPPORTED', 'The analysis image cannot meet Seedream size limits without distortion.');
  const image = scale === 1 ? analysis : await sharp(analysis).resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  return { image, width: targetWidth, height: targetHeight, analysisWidth: width, analysisHeight: height };
}

async function seedreamDiscovery(analysis: Buffer, infer: Infer): Promise<DiscoveryResult> {
  const input = await prepareSeedreamInput(analysis);
  const outputs = await infer('seedream', { image: input.image, imageSize: 'auto', key: 'phase03-discovery' });
  const normalized = await normalizeSeedreamLayers(input.analysisWidth, input.analysisHeight, outputs, outputs.layers);
  return { provider: 'seedream', providerModel: modelOf('seedream'), ...normalized, attempts: [], providerRequestId: outputs.requestId, deterministic: false };
}

function scaleRect(box: [number, number, number, number], sx: number, sy: number, width: number, height: number): Rect | undefined {
  const x = Math.max(0, Math.floor(box[0] * sx)), y = Math.max(0, Math.floor(box[1] * sy));
  const right = Math.min(width, Math.ceil(box[2] * sx)), bottom = Math.min(height, Math.ceil(box[3] * sy));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
function iou(a: Rect, b: Rect) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / (a.width * a.height + b.width * b.height - w * h);
}

/**
 * Register Seedream layers onto the analysis canvas. Layers are accepted either at full provider-canvas size or
 * as crops whose pixel size matches their absolute bbox. The provider canvas must share the analysis aspect ratio;
 * otherwise every layer stays unregistered rather than being stretched.
 */
export async function normalizeSeedreamLayers(analysisWidth: number, analysisHeight: number, outputs: Buffer[], layers?: ProviderLayerMetadata[]): Promise<{ proposals: DiscoveryProposal[]; baseLayer?: DiscoveryBaseLayer; warnings: string[] }> {
  if (!layers || layers.length !== outputs.length) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Seedream layer metadata does not match its images.');
  const warnings = new Set<string>();
  const decoded = [];
  for (const [i, rgba] of outputs.entries()) {
    const meta = await sharp(rgba, { limitInputPixels: 16_777_216, failOn: 'warning' }).metadata();
    if (!meta.width || !meta.height || (meta.pages ?? 1) !== 1) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Seedream returned an undecodable layer.');
    decoded.push({ rgba: meta.hasAlpha ? rgba : await sharp(rgba).ensureAlpha().png().toBuffer(), width: meta.width, height: meta.height, layer: layers[i] });
  }
  const minZ = Math.min(...decoded.map(d => d.layer.zIndex));
  const base = decoded.find(d => d.layer.zIndex === minZ && !d.layer.bboxAbsolute && !d.layer.bboxNormalized);
  const sizes = new Map<string, number>();
  for (const d of decoded) sizes.set(`${d.width}x${d.height}`, (sizes.get(`${d.width}x${d.height}`) ?? 0) + 1);
  const [canvasWidth, canvasHeight] = base ? [base.width, base.height] : [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0].split('x').map(Number);
  const aspectOk = Math.abs(canvasWidth / canvasHeight - analysisWidth / analysisHeight) / (analysisWidth / analysisHeight) <= ASPECT_TOLERANCE;
  if (!aspectOk) warnings.add('DISCOVERY_CANVAS_MISMATCH');
  const sx = analysisWidth / canvasWidth, sy = analysisHeight / canvasHeight;
  const toAnalysis = async (canvas: Buffer) => canvasWidth === analysisWidth && canvasHeight === analysisHeight ? canvas : sharp(canvas).resize(analysisWidth, analysisHeight, { fit: 'fill', kernel: 'linear' }).png().toBuffer();

  let baseLayer: DiscoveryBaseLayer | undefined;
  if (base) {
    const registered = aspectOk;
    baseLayer = { rgba: registered ? await toAnalysis(base.rgba) : base.rgba, width: registered ? analysisWidth : base.width, height: registered ? analysisHeight : base.height, zIndex: base.layer.zIndex,
      ...(base.layer.name ? { name: base.layer.name } : {}), ...(base.layer.description ? { description: base.layer.description } : {}),
      sourceRegistration: { method: registered ? 'full-canvas' : 'unregistered', providerWidth: base.width, providerHeight: base.height, scaleX: sx, scaleY: sy } };
  }

  const proposals: DiscoveryProposal[] = [];
  for (const d of decoded) {
    if (d === base) continue;
    const box = d.layer.bboxAbsolute;
    let method: DiscoverySourceRegistration['method'] = 'unregistered';
    let canvas = d.rgba;
    if (aspectOk && d.width === canvasWidth && d.height === canvasHeight) method = 'full-canvas';
    else if (aspectOk && box && box[2] <= canvasWidth && box[3] <= canvasHeight && Math.abs(d.width - (box[2] - box[0])) <= BBOX_SIZE_TOLERANCE && Math.abs(d.height - (box[3] - box[1])) <= BBOX_SIZE_TOLERANCE) {
      const left = Math.round(box[0]), top = Math.round(box[1]);
      const crop = await sharp(d.rgba).extract({ left: 0, top: 0, width: Math.min(d.width, canvasWidth - left), height: Math.min(d.height, canvasHeight - top) }).png().toBuffer();
      canvas = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: crop, left, top }]).png().toBuffer();
      method = 'bbox-placed';
    }
    const registered = method !== 'unregistered';
    const rgba = registered ? await toAnalysis(canvas) : d.rgba;
    const alpha = await decodeMask(rgba, { encoding: 'alpha' });
    // Measure the thresholded support so resampling fringes do not inflate bounds or coverage.
    const measured = measureMask(binaryMask(alpha));
    const defects = [...(!registered ? ['PROPOSAL_GEOMETRY_MISMATCH'] : []), ...(measured.areaFraction === 0 || measured.areaFraction === 1 ? ['PROPOSAL_NON_OBJECT_SUPPORT'] : [])];
    if (defects.length) warnings.add('PROPOSAL_UNRELIABLE');
    const providerBbox = registered ? box ? scaleRect(box, sx, sy, analysisWidth, analysisHeight)
      : d.layer.bboxNormalized ? scaleRect(d.layer.bboxNormalized, analysisWidth / 1000, analysisHeight / 1000, analysisWidth, analysisHeight) : undefined : undefined;
    const metadataWarnings = providerBbox && measured.bbox && iou(providerBbox, measured.bbox) < 0.5 ? ['PROVIDER_BBOX_DISAGREES_WITH_ALPHA'] : [];
    proposals.push({ id: '', label: d.layer.name ?? '', labelSource: d.layer.name ? 'provider' : 'generic', rgba, alpha, width: registered ? analysisWidth : d.width, height: registered ? analysisHeight : d.height,
      registered, warnings: defects, provider: 'seedream', providerModel: modelOf('seedream'), zIndex: d.layer.zIndex, providerOrder: decoded.indexOf(d),
      ...(d.layer.description ? { description: d.layer.description } : {}), ...(providerBbox ? { providerBbox } : {}),
      bounds: measured.bbox, coverage: measured.areaFraction, metadataWarnings,
      sourceRegistration: { method, providerWidth: d.width, providerHeight: d.height, scaleX: sx, scaleY: sy } });
  }
  let kept = proposals;
  if (kept.length > MAX_DISCOVERY_PROPOSALS) {
    kept = [...kept].sort((a, b) => b.coverage - a.coverage).slice(0, MAX_DISCOVERY_PROPOSALS);
    warnings.add('DISCOVERY_LAYERS_TRUNCATED');
  }
  // Back-to-front by provider z-index; ids follow that order. Provider order is evidence, not ground truth.
  kept.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  kept.forEach((proposal, i) => { proposal.id = `proposal-${i + 1}`; if (!proposal.label) proposal.label = `Object ${i + 1}`; });
  if (!kept.length) warnings.add('PROPOSAL_UNRELIABLE');
  return { proposals: kept, ...(baseLayer ? { baseLayer } : {}), warnings: [...warnings] };
}

/**
 * Fix the provider plan once per job. Mock mode only has the owned Qwen fixture, and jobs that already
 * attempted Qwen before discovery-v1 keep Qwen so historical recovery never switches providers mid-job.
 */
export function resolveDiscoveryPlan(data: Record<string, unknown>, config: { providerMode: 'mock' | 'live'; discoveryProvider: DiscoveryProviderName; discoveryFallback: 'qwen' | 'none' }): DiscoveryPlan {
  const saved = data.discoveryPlan as DiscoveryPlan | undefined;
  if (saved && ['seedream', 'qwen'].includes(saved.primary)) return saved;
  if (data.verificationMode === 'mock' || config.providerMode === 'mock' || data.qwenRequest || data.qwenInference) return { primary: 'qwen' };
  return config.discoveryProvider === 'seedream' && config.discoveryFallback === 'qwen' ? { primary: 'seedream', fallback: 'qwen' } : { primary: config.discoveryProvider };
}
