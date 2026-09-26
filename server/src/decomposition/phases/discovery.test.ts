import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { discoverLayers, normalizeSeedreamLayers, prepareSeedreamInput, resolveDiscoveryPlan, MAX_DISCOVERY_PROPOSALS } from './discovery.js';
import { ProviderError } from '../providers/adapters.js';
import type { ProviderLayerMetadata } from '../providers/adapters.js';
import type { Infer, InferenceOutput } from '../providers/inference.js';
import { measureMask } from '../image/masks.js';
import { readDecompositionConfig } from '../config.js';

type Box = { x: number; y: number; width: number; height: number };
/** Opaque colored RGBA of the given size, with alpha only inside `box` (or everywhere). */
async function layerPng(width: number, height: number, box?: Box, color = [200, 40, 40]) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, inside = !box || (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
    data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = inside ? 255 : 0;
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
const output = (buffers: Buffer[], layers: ProviderLayerMetadata[], requestId = 'seedream-1') => Object.assign(buffers, { layers, requestId }) as InferenceOutput;
const analysisPng = (width = 256, height = 256) => sharp({ create: { width, height, channels: 3, background: '#789abc' } }).png().toBuffer();

/** A poster-like Seedream response on a 512 canvas: base, full-canvas woman, cropped phone, PRO text. */
async function posterResponse() {
  const buffers = [await layerPng(512, 512), await layerPng(512, 512, { x: 100, y: 60, width: 200, height: 400 }), await layerPng(80, 120), await layerPng(512, 512, { x: 320, y: 40, width: 150, height: 80 }, [255, 255, 255])];
  const layers: ProviderLayerMetadata[] = [
    { zIndex: 0, description: 'Blurred interior background' },
    { zIndex: 1, name: 'Woman', description: 'Woman in a jacket', bboxAbsolute: [100, 60, 300, 460] },
    { zIndex: 3, name: 'Phone', bboxAbsolute: [240, 200, 320, 320] },
    { zIndex: 2, bboxNormalized: [625, 78.125, 917.96875, 234.375] },
  ];
  return output(buffers, layers);
}

describe('seedream discovery normalization', () => {
  it('registers full-canvas and bbox-cropped layers onto the analysis canvas, separates the base layer and orders by z-index', async () => {
    const response = await posterResponse();
    const result = await normalizeSeedreamLayers(256, 256, response, response.layers);
    expect(result.baseLayer).toMatchObject({ zIndex: 0, width: 256, height: 256, description: 'Blurred interior background', sourceRegistration: { method: 'full-canvas', providerWidth: 512, scaleX: 0.5 } });
    expect(result.proposals.map(p => [p.id, p.label, p.labelSource, p.zIndex, p.sourceRegistration.method])).toEqual([
      ['proposal-1', 'Woman', 'provider', 1, 'full-canvas'], ['proposal-2', 'Object 2', 'generic', 2, 'full-canvas'], ['proposal-3', 'Phone', 'provider', 3, 'bbox-placed']]);
    for (const p of result.proposals) { expect([p.width, p.height, p.alpha.width, p.alpha.height]).toEqual([256, 256, 256, 256]); expect(p.registered).toBe(true); expect(p.warnings).toEqual([]); expect(p.provider).toBe('seedream'); }
    const [woman, text, phone] = result.proposals;
    expect(woman.providerBbox).toEqual({ x: 50, y: 30, width: 100, height: 200 });
    expect(woman.bounds).toEqual({ x: 50, y: 30, width: 100, height: 200 });
    expect(woman.description).toBe('Woman in a jacket');
    expect(text.providerBbox).toEqual({ x: 160, y: 20, width: 75, height: 40 });
    // The cropped phone lands exactly at its declared box, scaled to analysis pixels.
    expect(phone.bounds).toEqual({ x: 120, y: 100, width: 40, height: 60 });
    expect(phone.metadataWarnings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('never stretches a provider canvas with a different aspect ratio into place', async () => {
    const response = await posterResponse();
    const result = await normalizeSeedreamLayers(256, 320, response, response.layers);
    expect(result.warnings).toEqual(expect.arrayContaining(['DISCOVERY_CANVAS_MISMATCH', 'PROPOSAL_UNRELIABLE']));
    expect(result.proposals.every(p => !p.registered && p.warnings.includes('PROPOSAL_GEOMETRY_MISMATCH') && p.sourceRegistration.method === 'unregistered')).toBe(true);
    expect(result.baseLayer?.sourceRegistration.method).toBe('unregistered');
  });

  it('leaves a cropped layer unregistered when its pixels do not match its declared box', async () => {
    const buffers = [await layerPng(512, 512), await layerPng(90, 120, { x: 10, y: 10, width: 60, height: 90 })];
    const result = await normalizeSeedreamLayers(256, 256, buffers, [{ zIndex: 0 }, { zIndex: 1, name: 'Phone', bboxAbsolute: [240, 200, 320, 320] }]);
    expect(result.proposals[0]).toMatchObject({ registered: false, warnings: ['PROPOSAL_GEOMETRY_MISMATCH'], width: 90, height: 120 });
  });

  it('flags provider boxes that disagree with alpha, and non-object full-canvas layers, without inventing geometry', async () => {
    const buffers = [await layerPng(512, 512), await layerPng(512, 512, { x: 0, y: 0, width: 50, height: 50 }), await layerPng(512, 512)];
    const result = await normalizeSeedreamLayers(512, 512, buffers, [{ zIndex: 0 }, { zIndex: 1, bboxAbsolute: [300, 300, 500, 500] }, { zIndex: 2, bboxAbsolute: [0, 0, 512, 512] }]);
    expect(result.proposals[0].metadataWarnings).toEqual(['PROVIDER_BBOX_DISAGREES_WITH_ALPHA']);
    expect(result.proposals[0].warnings).toEqual([]);
    expect(result.proposals[1].warnings).toEqual(['PROPOSAL_NON_OBJECT_SUPPORT']);
  });

  it('keeps the largest layers within the review limit and reports truncation', async () => {
    const buffers = [await layerPng(512, 512)], layers: ProviderLayerMetadata[] = [{ zIndex: 0 }];
    for (let i = 0; i < 16; i++) { buffers.push(await layerPng(512, 512, { x: i * 30, y: 0, width: 10 + i, height: 10 + i })); layers.push({ zIndex: i + 1, name: `L${i}` }); }
    const result = await normalizeSeedreamLayers(512, 512, buffers, layers);
    expect(result.proposals).toHaveLength(MAX_DISCOVERY_PROPOSALS);
    expect(result.proposals.map(p => p.label)).toEqual(Array.from({ length: 12 }, (_, i) => `L${i + 4}`));
    expect(result.warnings).toContain('DISCOVERY_LAYERS_TRUNCATED');
  });

  it('rejects responses whose metadata does not align with images', async () => {
    await expect(normalizeSeedreamLayers(256, 256, [await layerPng(512, 512)], [])).rejects.toMatchObject({ code: 'PROVIDER_SCHEMA_CHANGED' });
    await expect(normalizeSeedreamLayers(256, 256, [await layerPng(512, 512)], undefined)).rejects.toMatchObject({ code: 'PROVIDER_SCHEMA_CHANGED' });
  });

  it('uniformly upscales small analysis images to the Seedream minimum and refuses extreme aspect ratios', async () => {
    const prepared = await prepareSeedreamInput(await analysisPng(256, 384));
    expect([prepared.width, prepared.height, prepared.analysisWidth, prepared.analysisHeight]).toEqual([512, 768, 256, 384]);
    expect(await sharp(prepared.image).metadata()).toMatchObject({ width: 512, height: 768 });
    const large = await analysisPng(1024, 819);
    expect((await prepareSeedreamInput(large)).image).toBe(large);
    await expect(prepareSeedreamInput(await analysisPng(1024, 60))).rejects.toMatchObject({ code: 'DISCOVERY_INPUT_UNSUPPORTED' });
  });
});

describe('discovery provider selection and fallback', () => {
  const qwenRgba = () => layerPng(256, 256, { x: 40, y: 40, width: 80, height: 120 });
  const plan = { primary: 'seedream' as const, fallback: 'qwen' as const };

  it('uses Seedream first and never calls Qwen when Seedream finds usable layers', async () => {
    const response = await posterResponse();
    const infer = vi.fn<Infer>(async (model, request) => {
      expect(model).toBe('seedream'); expect(request).toMatchObject({ imageSize: 'auto', key: 'phase03-discovery' });
      expect(await sharp(request.image).metadata()).toMatchObject({ width: 512, height: 512 });
      return response;
    });
    const result = await discoverLayers(await analysisPng(), infer, { plan });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'seedream', providerModel: 'bytedance/seedream/v5/pro/layerize', providerRequestId: 'seedream-1', deterministic: false, attempts: [{ provider: 'seedream', outcome: 'used', proposalCount: 3 }] });
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.proposals.map(p => p.label)).toEqual(['Woman', 'Object 2', 'Phone']);
  });

  it.each(['PROVIDER_UNAVAILABLE', 'PROVIDER_SCHEMA_CHANGED', 'PROVIDER_EMPTY_OUTPUT', 'PROVIDER_REJECTED', 'PROVIDER_NETWORK', 'PROVIDER_DEADLINE'])('falls back to deterministic Qwen after a safe Seedream failure: %s', async code => {
    const rgba = await qwenRgba();
    const infer = vi.fn<Infer>(async model => { if (model === 'seedream') throw new ProviderError(code, 'failed'); return Object.assign([rgba], { requestId: 'qwen-1', seed: 7 }); });
    const result = await discoverLayers(await analysisPng(), infer, { plan });
    expect(infer.mock.calls.map(call => call[0])).toEqual(['seedream', 'qwen']);
    expect(result).toMatchObject({ provider: 'qwen', providerModel: 'fal-ai/qwen-image-layered', fallbackFrom: 'seedream', deterministic: true,
      attempts: [{ provider: 'seedream', outcome: 'failed', code }, { provider: 'qwen', outcome: 'used', proposalCount: 1 }] });
    expect(result.warnings).toContain('DISCOVERY_FALLBACK_USED');
    expect(result.proposals[0]).toMatchObject({ id: 'proposal-1', label: 'Object 1', labelSource: 'generic', provider: 'qwen', registered: true, sourceRegistration: { method: 'full-canvas' } });
  });

  it.each(['SUBMISSION_UNKNOWN', 'PROVIDER_AUTH', 'PROVIDER_CREDITS', 'PROVIDER_RATE_LIMIT', 'PROVIDER_SAFETY_REFUSAL', 'JOB_CANCELLED', 'STALE_LEASE'])('does not spend a fallback call after %s', async code => {
    const infer = vi.fn<Infer>(async () => { throw new ProviderError(code, 'stop'); });
    await expect(discoverLayers(await analysisPng(), infer, { plan })).rejects.toMatchObject({ code });
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it('falls back when Seedream returns nothing usable, and keeps Seedream evidence if Qwen also finds nothing', async () => {
    const mismatched = output([await layerPng(512, 512), await layerPng(512, 700, { x: 0, y: 0, width: 50, height: 50 })], [{ zIndex: 0 }, { zIndex: 1, name: 'Woman' }]);
    const rgba = await qwenRgba();
    let qwenWorks = true;
    const infer = vi.fn<Infer>(async model => model === 'seedream' ? mismatched : qwenWorks ? Object.assign([rgba], { seed: 1 }) : Promise.reject(new ProviderError('PROVIDER_EMPTY_OUTPUT', 'empty')));
    const recovered = await discoverLayers(await analysisPng(), infer, { plan });
    expect(recovered).toMatchObject({ provider: 'qwen', fallbackFrom: 'seedream', attempts: [{ provider: 'seedream', outcome: 'unreliable', code: 'DISCOVERY_UNRELIABLE' }, { provider: 'qwen', outcome: 'used' }] });
    qwenWorks = false;
    const kept = await discoverLayers(await analysisPng(), infer, { plan });
    expect(kept).toMatchObject({ provider: 'seedream', attempts: [{ provider: 'seedream', outcome: 'unreliable' }, { provider: 'qwen', outcome: 'failed', code: 'PROVIDER_EMPTY_OUTPUT' }] });
    expect(kept.fallbackFrom).toBeUndefined();
    expect(kept.proposals[0]).toMatchObject({ label: 'Woman', registered: false });
  });

  it('without a configured fallback, a safe Seedream failure proceeds to review with no proposals', async () => {
    const infer = vi.fn<Infer>(async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down'); });
    const result = await discoverLayers(await analysisPng(), infer, { plan: { primary: 'seedream' } });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'seedream', proposals: [], warnings: ['PROPOSAL_UNRELIABLE', 'PROVIDER_UNAVAILABLE'], attempts: [{ outcome: 'failed' }] });
  });

  it('keeps Qwen-only discovery behavior unchanged when Qwen is the primary provider', async () => {
    const rgba = await qwenRgba();
    const infer = vi.fn<Infer>(async (model, request) => { expect(model).toBe('qwen'); expect(request).toMatchObject({ numLayers: 4, key: 'phase03-proposals' }); return Object.assign([rgba], { seed: 3 }); });
    const result = await discoverLayers(await analysisPng(), infer, { plan: { primary: 'qwen' } });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'qwen', attempts: [{ provider: 'qwen', outcome: 'used' }] });
    expect(measureMask(result.proposals[0].alpha).bbox).toEqual({ x: 40, y: 40, width: 80, height: 120 });
    const empty = await discoverLayers(await analysisPng(), async () => { throw new ProviderError('PROVIDER_EMPTY_OUTPUT', 'empty'); }, { plan: { primary: 'qwen' } });
    expect(empty).toMatchObject({ proposals: [], warnings: ['PROPOSAL_UNRELIABLE', 'PROVIDER_EMPTY_OUTPUT'] });
  });

  it('resolves the plan once per job, keeping mock and historical Qwen jobs on Qwen', () => {
    const live = readDecompositionConfig({ DECOMP_PROVIDER_MODE: 'live' });
    expect(live).toMatchObject({ discoveryProvider: 'seedream', discoveryFallback: 'qwen' });
    expect(resolveDiscoveryPlan({ verificationMode: 'live' }, live)).toEqual({ primary: 'seedream', fallback: 'qwen' });
    expect(resolveDiscoveryPlan({ verificationMode: 'mock' }, live)).toEqual({ primary: 'qwen' });
    expect(resolveDiscoveryPlan({ verificationMode: 'live', qwenRequest: { sentSeed: 1 } }, live)).toEqual({ primary: 'qwen' });
    expect(resolveDiscoveryPlan({ verificationMode: 'live', discoveryPlan: { primary: 'seedream', fallback: 'qwen' }, qwenRequest: {} }, live)).toEqual({ primary: 'seedream', fallback: 'qwen' });
    expect(resolveDiscoveryPlan({ verificationMode: 'live' }, readDecompositionConfig({ DECOMP_DISCOVERY_FALLBACK: 'none' }))).toEqual({ primary: 'seedream' });
    expect(resolveDiscoveryPlan({ verificationMode: 'live' }, readDecompositionConfig({ DECOMP_DISCOVERY_PROVIDER: 'qwen' }))).toEqual({ primary: 'qwen' });
    expect(() => readDecompositionConfig({ DECOMP_DISCOVERY_PROVIDER: 'other' })).toThrow(/seedream or qwen/);
    expect(() => readDecompositionConfig({ DECOMP_DISCOVERY_FALLBACK: 'seedream' })).toThrow(/qwen or none/);
  });
});
