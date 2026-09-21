import { describe, expect, it } from 'vitest';
import { AI_LIMITS, validGenerateRequest, validImageResponse, validStyleBrief, type GenerateRequest, type ImageResponse } from './ai.js';

const request: GenerateRequest = {
  prompt: 'Ivory florals and warm gold accents', target: { width: 1080, height: 1350 },
  styleBrief: { theme: 'Elegant wedding', palette: ['ivory', 'gold'], motifs: ['florals'], mood: 'refined' },
  quietRegion: { x: 0.15, y: 0.25, width: 0.7, height: 0.55 },
};

describe('shared AI request validation', () => {
  it('accepts an exact boundary prompt and a fully contained text region without mutating the request', () => {
    const input = { ...request, prompt: 'a'.repeat(AI_LIMITS.prompt), quietRegion: { x: 0, y: 0, width: 1, height: 1 } };
    const before = structuredClone(input);
    expect(validGenerateRequest(input)).toBe(true);
    expect(input).toEqual(before);
  });
  it.each([null, [], {}, 'request', { ...request, prompt: '' }, { ...request, prompt: ' \n ' }, { ...request, prompt: 'a'.repeat(2001) }])('rejects malformed or blank/oversized request %#', (input) => {
    expect(validGenerateRequest(input)).toBe(false);
  });
  it.each([
    { width: '1080', height: 1350 }, { width: 1080.5, height: 1350 }, { width: NaN, height: 1350 },
    { width: 1080, height: Infinity }, { width: 255, height: 1350 }, { width: 4097, height: 1350 },
    { width: 4000, height: 4000 },
  ])('rejects invalid logical dimensions %#', (target) => {
    expect(validGenerateRequest({ ...request, target })).toBe(false);
  });
  it.each([
    { x: -0.1, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0, height: 0.5 },
    { x: 0.8, y: 0, width: 0.3, height: 0.5 }, { x: 0, y: 0.8, width: 0.5, height: 0.3 },
    { x: NaN, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0.5, height: Infinity },
    { x: '0', y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0.5 },
  ])('rejects invalid or uncontained quiet region %#', (quietRegion) => {
    expect(validGenerateRequest({ ...request, quietRegion })).toBe(false);
  });
  it('bounds every style field while allowing an intentionally empty palette or motif list', () => {
    expect(validStyleBrief({ ...request.styleBrief, palette: [], motifs: [] })).toBe(true);
    for (const invalid of [
      { theme: ' ' }, { theme: 'x'.repeat(101) }, { mood: 'x'.repeat(201) },
      { palette: Array<string>(9).fill('ivory') }, { motifs: ['x'.repeat(101)] },
      { palette: [''] }, { motifs: [12] }, { palette: 'ivory' },
    ]) expect(validGenerateRequest({ ...request, styleBrief: { ...request.styleBrief, ...invalid } })).toBe(false);
  });
});

describe('normalized AI response contract', () => {
  const response: ImageResponse = {
    requestId: 'request-123', image: { mimeType: 'image/png', base64: 'fixture-only', width: 1024, height: 1280 },
    generation: { mode: 'live', model: 'mock-provider', requestedAspectRatio: '4:5', promptUsed: 'Artwork only' },
  };
  it('accepts normalized metadata; binary decoding is separately required by the asset layer', () => {
    expect(validImageResponse(response)).toBe(true);
  });
  it('accepts both supported providers while retaining responses without provider metadata', () => {
    for (const provider of ['gemini', 'cloudflare']) {
      expect(validImageResponse({ ...response, generation: { ...response.generation, provider } })).toBe(true);
    }
    expect(validImageResponse(response)).toBe(true);
  });
  it('rejects unsupported or malformed provider metadata', () => {
    for (const provider of ['other', 'Cloudflare', '', null, 42, {}]) {
      expect(validImageResponse({ ...response, generation: { ...response.generation, provider } })).toBe(false);
    }
  });
  it('rejects missing metadata, unsupported image types and unsafe image sizes', () => {
    for (const value of [null, {}, { ...response, requestId: '' }, { ...response, generation: { ...response.generation, mode: 'example' } },
      ...[{ mimeType: 'image/svg+xml' }, { base64: '' }, { width: 0 }, { height: 1.5 }, { width: Infinity }, { width: 4096, height: 4096 }]
        .map((image) => ({ ...response, image: { ...response.image, ...image } })),
    ]) expect(validImageResponse(value)).toBe(false);
  });
});
