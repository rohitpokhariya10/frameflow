import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError, RATIOS, artworkPrompt, aspectRatio, generateArtwork, mapProviderError, validateImage } from './aiService.js';
import { mockPng, mockRequest } from '../testSupport.js';

afterEach(() => vi.useRealTimers());

describe('server artwork request construction', () => {
  it.each([[1080, 1350, '4:5'], [1080, 1080, '1:1'], [1600, 900, '16:9'], [1080, 1920, '9:16']] as const)('maps %d×%d to %s', (width, height, expected) => {
    expect(aspectRatio(width, height)).toBe(expected);
  });
  it('chooses the nearest supported ratio by symmetric logarithmic distance for custom sizes', () => {
    for (const [width, height] of [[1200, 1000], [4096, 256], [256, 4096], [1300, 1000]]) {
      const ratio = aspectRatio(width, height);
      const distance = (value: string) => { const [w, h] = value.split(':').map(Number); return Math.abs(Math.log((width / height) / (w / h))); };
      expect(RATIOS).toContain(ratio);
      expect(distance(ratio)).toBeCloseTo(Math.min(...RATIOS.map(distance)), 10);
      expect(aspectRatio(width, height)).toBe(ratio);
    }
  });
  it('requests artwork and the light quiet region without passing extra exact event fields', () => {
    const prompt = artworkPrompt({ ...mockRequest, ...{ title: 'Private exact names', venue: 'Exact private venue' } }, '4:5');
    expect(prompt).toContain(mockRequest.prompt);
    expect(prompt).toContain('ivory, gold');
    expect(prompt).toContain('Target format: 4:5');
    expect(prompt).toContain('x=0.15, y=0.25, width=0.7, height=0.55');
    expect(prompt).toContain('light, low-detail space for dark editable text');
    expect(prompt).toContain('Do not add event wording, letters, logos, signatures');
    expect(prompt).not.toContain('Private exact names');
    expect(prompt).not.toContain('Exact private venue');
  });
});

describe('provider image validation and normalization', () => {
  it('reads real encoded pixel dimensions separately from logical target dimensions', async () => {
    const data = mockPng(4, 5).toString('base64');
    const generate = vi.fn().mockResolvedValue({ data, mimeType: 'image/png' });
    const response = await generateArtwork(mockRequest, 'request-123', 'mock-provider', 1000, generate);
    expect(response).toEqual({ requestId: 'request-123', image: { base64: data, mimeType: 'image/png', width: 4, height: 5 }, generation: {
      mode: 'live', model: 'mock-provider', requestedAspectRatio: '4:5', promptUsed: artworkPrompt(mockRequest, '4:5'),
    } });
    expect(generate).toHaveBeenCalledExactlyOnceWith(response.generation.promptUsed, '4:5', expect.any(AbortSignal));
  });
  it('rejects missing, malformed, mismatched, unsupported and oversized image content', () => {
    const valid = mockPng().toString('base64');
    for (const input of [
      { data: '', mimeType: 'image/png' }, { data: 'not base64!', mimeType: 'image/png' },
      { data: 'abcd', mimeType: 'image/png' }, { data: `${valid}\n`, mimeType: 'image/png' },
      { data: valid, mimeType: 'image/jpeg' }, { data: valid, mimeType: 'image/svg+xml' },
      { data: 'a'.repeat(12_000_000), mimeType: 'image/png' },
    ]) expect(() => validateImage(input)).toThrow(AiError);
    const huge = mockPng(); huge.writeUInt32BE(100_000, 16); huge.writeUInt32BE(100_000, 20);
    expect(() => validateImage({ data: huge.toString('base64'), mimeType: 'image/png' })).toThrow(AiError);
  });
});

describe('safe provider failure handling', () => {
  it.each([
    [{ status: 429 }, 'RATE_LIMIT', 429], [{ statusCode: 429 }, 'RATE_LIMIT', 429],
    [{ status: 401 }, 'CONFIGURATION', 503], [{ statusCode: 403 }, 'CONFIGURATION', 503],
    [new Error('secret credentials and raw provider output'), 'PROVIDER_FAILURE', 502],
  ])('normalizes provider status %# without exposing raw provider details', (input, code, status) => {
    const error = mapProviderError(input);
    expect(error).toMatchObject({ code, status });
    expect(error.message).not.toContain('secret');
  });
  it('preserves intentional safe errors from the provider adapter', () => {
    const refusal = new AiError('PROVIDER_REFUSAL', 'Try different artwork.');
    expect(mapProviderError(refusal)).toBe(refusal);
  });
  it('enforces a bounded timeout and aborts the provider without retrying', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const generate = vi.fn((_prompt: string, _ratio: string, incoming: AbortSignal) => { signal = incoming; return new Promise<never>(() => {}); });
    const result = generateArtwork(mockRequest, 'timeout-id', 'mock-provider', 1000, generate);
    const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', status: 504, retryable: true });
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    expect(signal?.aborted).toBe(true); expect(generate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts a disconnected request and clears its timeout', async () => {
    vi.useFakeTimers();
    const disconnected = new AbortController();
    let signal: AbortSignal | undefined;
    const result = generateArtwork(mockRequest, 'cancel-id', 'mock-provider', 120000, (_prompt, _ratio, incoming) => {
      signal = incoming; return new Promise<never>(() => {});
    }, disconnected.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: 'CANCELLED', status: 499 });
    disconnected.abort(); await assertion;
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('normalizes thrown provider failures and never retries automatically', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('provider raw output'));
    await expect(generateArtwork(mockRequest, 'failure-id', 'mock-provider', 1000, generate)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', status: 502 });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
