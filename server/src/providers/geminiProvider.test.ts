import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geminiProvider } from './geminiProvider.js';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {
  interactions = { create: mocks.create };
  constructor(options: unknown) { mocks.construct(options); }
} }));
beforeEach(() => { mocks.construct.mockReset(); mocks.create.mockReset(); });

describe('Gemini Interactions adapter (SDK mocked; no live calls)', () => {
  it('isolates the documented SDK payload, inline image response and cancellation policy', async () => {
    const signal = new AbortController().signal;
    mocks.create.mockResolvedValue({ status: 'completed', output_image: { data: 'test-bytes', mime_type: 'image/jpeg' }, private_provider_field: 'discard me' });
    const provider = geminiProvider('test-only-credential', 'configured-model');
    await expect(provider('Artwork only', '4:5', signal)).resolves.toEqual({ data: 'test-bytes', mimeType: 'image/jpeg' });
    expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({ apiKey: 'test-only-credential' });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      model: 'configured-model', input: 'Artwork only', store: false,
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:5', image_size: '1K', delivery: 'inline' },
    }, { signal, retries: { strategy: 'none' } });
  });
  it.each([
    { status: 'completed', output_text: 'Here is a description, not an image.' },
    { status: 'completed', output_image: { data: '', mime_type: 'image/jpeg' } },
  ])('rejects text-only or empty image response %#', async (result) => {
    mocks.create.mockResolvedValue(result);
    await expect(geminiProvider('test-only-credential', 'mock-model')('Artwork', '1:1', new AbortController().signal)).rejects.toMatchObject({ code: 'NO_IMAGE' });
  });
  it('returns a safe refusal rather than provider diagnostics', async () => {
    mocks.create.mockResolvedValue({ status: 'failed', error: { message: 'raw private diagnostics' } });
    await expect(geminiProvider('test-only-credential', 'mock-model')('Artwork', '1:1', new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_REFUSAL', message: expect.not.stringContaining('raw private') });
  });
});
