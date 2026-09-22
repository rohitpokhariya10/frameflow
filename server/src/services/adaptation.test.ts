import { describe, expect, it, vi } from 'vitest';
import { ADAPT_LIMITS, validAdaptRequest, type AdaptRequest } from '@frameflow/shared';
import { adaptArtwork, adaptationPrompt, validateReference } from './aiService.js';
import { mockPng, mockRequest } from '../testSupport.js';

export const request: AdaptRequest = { ...mockRequest, format: 'landscape', target: { width: 1600, height: 900 },
  source: { projectId: 'project', variantId: 'original', revision: 3, assetId: 'source-artwork', width: 1080, height: 1350 },
  referenceImage: { mimeType: 'image/png', base64: mockPng().toString('base64'), width: 4, height: 5 } };

describe('bounded application adaptation contract', () => {
  it('accepts a valid intent with a PNG reference and no event text', () => { expect(validAdaptRequest(request)).toBe(true); });
  it.each([
    { source: null }, { source: { ...request.source, revision: -1 } }, { source: { ...request.source, assetId: 'https://untrusted/image' } },
    { target: { width: 100, height: 900 } }, { format: 'other' }, { format: 'poster' },
    { referenceImage: { ...request.referenceImage, mimeType: 'image/svg+xml' } },
    { referenceImage: { ...request.referenceImage, width: 512 } },
    { referenceImage: { ...request.referenceImage, base64: 'A'.repeat(Math.ceil(ADAPT_LIMITS.referenceBytes / 3) * 4 + 4) } },
  ])('rejects invalid context/target/reference %#', (change) => expect(validAdaptRequest({ ...request, ...change })).toBe(false));
  it.each([
    { ...request.referenceImage, base64: 'not base64' }, { ...request.referenceImage, width: 3 },
    { ...request.referenceImage, base64: mockPng(512, 10).toString('base64'), width: 511, height: 10 },
  ])('rejects actual invalid reference bytes or mismatched dimensions before contacting the provider %#', async (referenceImage) => {
    const adapt = vi.fn();
    expect(() => validateReference({ ...request, referenceImage })).toThrow(expect.objectContaining({ code: 'INVALID_REFERENCE', status: 400 }));
    await expect(async () => adaptArtwork({ ...request, referenceImage }, 'id', 'mock', 1000, adapt)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(adapt).not.toHaveBeenCalled();
  });
  it('passes reference bytes and target to the provider, retains request ID, and normalizes real output dimensions', async () => {
    const adapt = vi.fn().mockResolvedValue({ data: mockPng(16, 9).toString('base64'), mimeType: 'image/png' });
    const result = await adaptArtwork(request, 'adapt-id', 'mock', 1000, adapt);
    expect(result).toMatchObject({ requestId: 'adapt-id', image: { mimeType: 'image/png', width: 16, height: 9 }, generation: { provider: 'cloudflare' } });
    expect(adapt).toHaveBeenCalledExactlyOnceWith(adaptationPrompt(request, '16:9'), '16:9', expect.any(AbortSignal), request.target, { data: request.referenceImage.base64, mimeType: 'image/png' });
    expect(result.generation.promptUsed).toContain('supplied source artwork');
    expect(result.generation.promptUsed).toContain('left');
    expect(result.generation.promptUsed).toContain('do not merely stretch or crop');
    expect(JSON.stringify(result.generation)).not.toContain(request.referenceImage.base64);
  });
  it('aborts an adaptation timeout without retrying', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const adapt = vi.fn((_prompt, _ratio, incoming: AbortSignal) => { signal = incoming; return new Promise<never>(() => undefined); });
    try {
      const assertion = expect(adaptArtwork(request, 'id', 'mock', 1000, adapt)).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1000); await assertion;
      expect(signal?.aborted).toBe(true); expect(adapt).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

it('preserves visual identity while explicitly excluding source lettering from target artwork', () => {
  const prompt = adaptationPrompt({ ...request, prompt: 'Keep the FitnessHUB lettering from the source' }, '16:9');
  expect(prompt).toContain('Preserve its palette');
  expect(prompt).toContain('visual identity');
  expect(prompt).toContain('1600 by 900');
  expect(prompt).toContain('Do not reproduce or trace readable text or lettering from the source artwork');
  expect(prompt).toContain('Exact wording comes only from FrameFlow TextElements');
  expect(prompt.lastIndexOf('ARTWORK-ONLY RULE')).toBeGreaterThan(prompt.indexOf('Keep the FitnessHUB'));
  expect(prompt).toContain('Do not render readable text, letters, words, names, dates, venue copy, logos, signatures, typography or watermarks');
});
