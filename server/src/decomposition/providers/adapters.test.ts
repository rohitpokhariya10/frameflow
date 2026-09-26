import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, mayFallbackErase, normalizeProviderOutput, normalizedBoxToPixels, ProviderError } from './adapters.js';
import type { Model } from './adapters.js';
import { validateProviderImage } from './falClient.js';

const fixtures = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/decomposition/provider-contracts.json', import.meta.url), 'utf8')) as Record<Model, unknown>;
const imageUrl = 'https://v3b.fal.media/files/test/source.png';

describe('verified fal endpoint contracts', () => {
  it('decodes six endpoint-specific responses without fictional labels or universal masks', () => {
    for (const model of (Object.keys(endpointRegistry) as Model[]).filter(model => model !== 'seedream')) {
      const output = normalizeProviderOutput(model, fixtures[model]);
      expect(output.images).toHaveLength(1);
      expect(output.images[0].url).toContain('fal.media');
      expect(output).not.toHaveProperty('layers');
    }
    expect(normalizeProviderOutput('finegrain', fixtures.finegrain).images[0].contentType).toBe('image/jpeg');
    expect(() => normalizeProviderOutput('birefnet', { mask_image: { url: imageUrl } })).toThrow();
    expect(() => normalizeProviderOutput('sam2', { masks: [{ url: imageUrl }] })).toThrow();
    expect(() => normalizeProviderOutput('qwen', { layers: [{ url: imageUrl }] })).toThrow();
  });

  it('uses explicit pixel guidance and converts normalized output boxes', () => {
    const input = buildProviderInput('sam3', { imageUrl, width: 500, height: 800, prompt: 'board', points: [{ x: 200, y: 350, label: 1 }, { x: 220, y: 100, label: 0 }], boxes: [{ x: 100, y: 250, width: 300, height: 200 }] });
    expect(input).toMatchObject({ prompt: 'board', apply_mask: false, return_multiple_masks: true, include_scores: true, include_boxes: true,
      point_prompts: [{ x: 200, y: 350, label: 1 }, { x: 220, y: 100, label: 0 }], box_prompts: [{ x_min: 100, y_min: 250, x_max: 400, y_max: 450 }] });
    expect(input).not.toHaveProperty('width');
    expect(normalizedBoxToPixels([0.5, 0.5, 0.4, 0.25], 500, 800)).toEqual({ x: 150, y: 300, width: 200, height: 200 });
    expect(() => buildProviderInput('sam3', { imageUrl, width: 500, height: 800 })).toThrow(/explicit/);
    expect(() => buildProviderInput('sam3', { imageUrl, width: 500, height: 800, prompt: 'board', points: [{ x: 500, y: 20, label: 1 }] })).toThrow();
  });

  it('limits mask counts, validates output metadata and preserves safety refusals', () => {
    expect(() => normalizeProviderOutput('sam2', { individual_masks: Array.from({ length: 65 }, () => ({ url: imageUrl })) })).toThrow(/too many/);
    expect(() => normalizeProviderOutput('sam3', { masks: [{ url: imageUrl }], boxes: [[100, 200, 300, 400]] })).toThrow(/normalized/);
    expect(() => normalizeProviderOutput('flux', { images: [{ url: imageUrl }], has_nsfw_concepts: [true] })).toThrow(/safety/);
    expect(mayFallbackErase(new ProviderError('PROVIDER_SAFETY_REFUSAL', 'refused'))).toBe(false);
    expect(mayFallbackErase(new ProviderError('PROVIDER_AUTH', 'unauthorized'))).toBe(false);
    expect(mayFallbackErase(new ProviderError('PROVIDER_CREDITS', 'credits'))).toBe(false);
    expect(mayFallbackErase(new ProviderError('PROVIDER_UNAVAILABLE', 'unavailable'))).toBe(true);
  });

  it('requires equal image/edit-mask dimensions and an explicit fill prompt', () => {
    const options = { imageUrl, maskUrl: imageUrl, width: 512, height: 768, maskWidth: 512, maskHeight: 768 };
    expect(buildProviderInput('finegrain', options)).toEqual({ image_url: imageUrl, mask_url: imageUrl, mode: 'standard' });
    expect(() => buildProviderInput('flux', options)).toThrow(/prompt/);
    expect(() => buildProviderInput('flux', { ...options, prompt: 'Continue shirt', maskWidth: 511 })).toThrow(/identical/);
    expect(buildProviderInput('flux', { ...options, prompt: 'Continue shirt' })).toMatchObject({ output_format: 'png', num_images: 1 });
    expect(buildProviderInput('birefnet', { imageUrl })).toEqual({ image_url: imageUrl, model: 'Matting', operating_resolution: '1024x1024', mask_only: true, output_format: 'png' });
  });

  it('fully decodes output dimensions and requires actual Qwen alpha', async () => {
    const rgb = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
    const rgba = await sharp(rgb).ensureAlpha(0.5).png().toBuffer();
    await expect(validateProviderImage(rgb, 'qwen')).rejects.toThrow(/alpha/);
    await expect(validateProviderImage(rgba, 'qwen')).resolves.toMatchObject({ width: 30, height: 20, hasAlpha: true });
    await expect(validateProviderImage(rgba.subarray(0, 40), 'sam2')).rejects.toThrow(/decoding/);
    await expect(validateProviderImage(rgba, 'sam2', 500)).rejects.toThrow(/limits/);
  });
});
