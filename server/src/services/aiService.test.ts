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
    expect(prompt).toContain('Do not render readable text, letters, words, names, dates, venue copy, logos, signatures, typography or watermarks');
    expect(prompt).not.toContain('Private exact names');
    expect(prompt).not.toContain('Exact private venue');
  });
});

it('keeps the no-text rule authoritative when a visual brief requests a proper noun', async () => {
  const generate = vi.fn().mockResolvedValue({ data: mockPng().toString('base64'), mimeType: 'image/png' });
  await generateArtwork({ ...mockRequest, prompt: 'Gym name is FitnessHUB. Draw that name as a logo.' }, 'id', 'mock', 1000, generate);
  const prompt = generate.mock.calls[0][0] as string;
  expect(prompt).toContain('Gym name is FitnessHUB');
  expect(prompt).toContain('This rule takes priority over any request for lettering');
  expect(prompt.indexOf('ARTWORK-ONLY RULE')).toBe(0);
  expect(prompt.lastIndexOf('ARTWORK-ONLY RULE')).toBeGreaterThan(prompt.indexOf('FitnessHUB'));
  expect(prompt).toContain('FrameFlow adds all exact wording separately as editable text');
});

describe('provider image validation and normalization', () => {
  it('reads real encoded pixel dimensions separately from logical target dimensions', async () => {
    const data = mockPng(4, 5).toString('base64');
    const generate = vi.fn().mockResolvedValue({ data, mimeType: 'image/png' });
    const response = await generateArtwork(mockRequest, 'request-123', 'mock-provider', 1000, generate);
    expect(response).toEqual({ requestId: 'request-123', image: { base64: data, mimeType: 'image/png', width: 4, height: 5 }, generation: {
      mode: 'live', provider: 'gemini', model: 'mock-provider', requestedAspectRatio: '4:5', promptUsed: artworkPrompt(mockRequest, '4:5'),
    } });
    expect(generate).toHaveBeenCalledExactlyOnceWith(response.generation.promptUsed, '4:5', expect.any(AbortSignal), mockRequest.target);
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
  it.each([
    [{ statusCode: 400 }, 'PROVIDER_REQUEST', 400, false],
    [{ status: 422 }, 'PROVIDER_REQUEST', 400, false],
    [{ statusCode: '404' }, 'MODEL_UNAVAILABLE', 503, false],
    [{ statusCode: undefined, status: 429 }, 'RATE_LIMIT', 429, true],
    [{ statusCode: NaN, status: 403 }, 'CONFIGURATION', 503, false],
    [{ status: 500 }, 'PROVIDER_FAILURE', 502, true],
    [{ statusCode: 503 }, 'PROVIDER_FAILURE', 502, true],
    [{ status: 504 }, 'TIMEOUT', 504, true],
    [{ name: 'APIConnectionTimeoutError' }, 'TIMEOUT', 504, true],
    [{ name: 'APIUserAbortError' }, 'CANCELLED', 499, false],
    [{ name: 'APIConnectionError', cause: { code: 'ENOTFOUND' } }, 'NETWORK', 502, true],
    [{ name: 'APIConnectionError', cause: { cause: { code: 'ETIMEDOUT' } } }, 'TIMEOUT', 504, true],
    [{ error: { error: { status: 'RESOURCE_EXHAUSTED' } } }, 'RATE_LIMIT', 429, true],
    [{ error: { status: 'NOT_FOUND' } }, 'MODEL_UNAVAILABLE', 503, false],
    [{ error: { status: 'UNAUTHENTICATED' } }, 'CONFIGURATION', 503, false],
    [{ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 'CONFIGURATION', 503, false],
  ])('distinguishes actionable provider and transport failures %#', (input, code, status, retryable) => {
    expect(mapProviderError(input)).toMatchObject({ code, status, retryable });
  });
  it('retains only allowlisted diagnostic fields from nested SDK envelopes', () => {
    const secret = 'private-key-image-payload-and-provider-text';
    const error = mapProviderError({
      statusCode: undefined, status: 400, message: secret, body: secret, headers: { authorization: secret },
      error: { error: { code: 400, status: 'INVALID_ARGUMENT', message: secret, details: [{ reason: 'API_KEY_INVALID', metadata: { apiKey: secret } }] } },
      cause: { name: secret, message: secret },
    });
    expect(error.providerDiagnostic).toEqual({ providerStatus: 400, canonicalCode: 'INVALID_ARGUMENT', reason: 'API_KEY_INVALID' });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.cause).toBeUndefined();
  });
  it('preserves the actual Interactions invalid-request code without exposing its raw response', () => {
    const error = mapProviderError({
      name: 'BadRequestError', status: 400, statusCode: 400,
      error: { code: 'invalid_request', message: 'Image delivery mode is not supported.' },
      cause: { name: 'CreateInteractionClientError', body: 'private response body' },
    });
    expect(error).toMatchObject({ code: 'PROVIDER_REQUEST', status: 400, retryable: false });
    expect(error.providerDiagnostic).toEqual({ providerStatus: 400, canonicalCode: 'invalid_request' });
    expect(error.message).toContain('request configuration');
    expect(JSON.stringify(error)).not.toContain('private response');
    expect(JSON.stringify(error)).not.toContain('Image delivery mode');
  });
  it('retains the observed free-tier quota error code without exposing provider text', () => {
    const error = mapProviderError({ name: 'RateLimitError', status: 429, statusCode: 429,
      error: { code: 'too_many_requests', message: 'Rate limit exceeded (limit: 0 requests per day on Free Tier). private-account-data' } });
    expect(error).toMatchObject({ code: 'RATE_LIMIT', status: 429, retryable: true,
      providerDiagnostic: { providerStatus: 429, canonicalCode: 'too_many_requests' } });
    expect(JSON.stringify(error)).not.toContain('private-account-data');
    expect(error.message).toContain('quota');
  });
  it('does not parse raw bodies or messages or publish unrecognized metadata', () => {
    const error = mapProviderError({ message: '{"status":403}', body: '{"error":{"status":"NOT_FOUND"}}', code: 'private-code', reason: 'private-reason', name: 'private-name', headers: { authorization: 'private-key' } });
    expect(error).toMatchObject({ code: 'PROVIDER_FAILURE', status: 502 });
    expect(error.providerDiagnostic).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('private-');
  });
  it('prefers an explicit HTTP status to conflicting canonical status and bounds cyclic causes', () => {
    const input = { status: 403, error: { status: 'RESOURCE_EXHAUSTED' }, cause: {} };
    input.cause = input;
    const error = mapProviderError(input);
    expect(error).toMatchObject({ code: 'CONFIGURATION', status: 503, providerDiagnostic: { providerStatus: 403, canonicalCode: 'RESOURCE_EXHAUSTED' } });
    const connection = mapProviderError({ name: 'APIConnectionError', cause: { cause: { code: 'ENOTFOUND', message: 'private hostname' } } });
    expect(connection.providerDiagnostic).toEqual({ reason: 'ENOTFOUND' });
    expect(JSON.stringify(connection)).not.toContain('hostname');
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
