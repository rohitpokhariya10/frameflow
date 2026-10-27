import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

// A removal that leaves everything as it was (a broken fill): the gate must stop it before any provider is called.
vi.mock('../master/artworkRebuild.js', async original => ({ ...(await original<typeof import('../master/artworkRebuild.js')>()),
  fillLevels: (rgb: Uint8Array, w: number, h: number) => ({ out: Uint8Array.from(rgb), filled: new Uint8Array(w * h) }) }));
vi.mock('../master/patternFill.js', async original => ({ ...(await original<typeof import('../master/patternFill.js')>()),
  cleanBackground: async (source: { data: Buffer; width: number; height: number }) => ({ png: await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer(), trustedPercent: 0 }) }));

const { OverlayGateError, prepareProduct } = await import('./prepare.js');
const { detectedPoster, fakeSegmenter } = await import('./productPoster.fixture.js');

describe('Product with Text templates: the overlay gate', { timeout: 120_000 }, () => {
  it('sends nothing to the cut-out service when text or logos are still in the picture', async () => {
    const { source, analysis, objects } = await detectedPoster(), segmenter = fakeSegmenter();
    await expect(prepareProduct({ source, analysis, objects, segmenter, paidApproved: true, save: () => undefined })).rejects.toBeInstanceOf(OverlayGateError);
    expect(segmenter.calls).toHaveLength(0);
  });
});
