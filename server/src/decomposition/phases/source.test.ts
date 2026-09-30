import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeSource, sha256 } from './source.js';
import { decodeRgba } from '../image/decode.js';

describe('phase 01 source preservation', () => {
  it('keeps exact uploaded bytes and native RGBA in a distinct normalized master', async () => {
    const pixels = Buffer.alloc(257 * 263 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([71, 117, 219, i % 8 ? 128 : 0], i);
    const original = await sharp(pixels, { raw: { width: 257, height: 263, channels: 4 } }).png().toBuffer();
    const source = await normalizeSource(original);
    expect(source.original).toEqual(original);
    expect(source.originalSha256).toBe(sha256(original));
    expect(source.workingMasterSha256).toBe(sha256(source.master));
    expect(source).toMatchObject({ width: 257, height: 263, hadAlpha: true, colorSpace: 'srgb' });
    expect((await decodeRgba(source.master)).data).toEqual(pixels);
  });

  it('applies EXIF rotation and keeps the original JPEG immutable', async () => {
    const original = await sharp({ create: { width: 300, height: 260, channels: 3, background: '#e48227' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const source = await normalizeSource(original);
    expect(source).toMatchObject({ width: 260, height: 300, orientationNormalized: true, hadAlpha: false });
    expect(source.originalSha256).toBe(sha256(original));
    expect((await sharp(source.master).metadata()).orientation).toBeUndefined();
  });

  it('fully decodes WebP and rejects malformed, oversized, tiny, animated and high precision sources', async () => {
    const staticImage = sharp({ create: { width: 256, height: 256, channels: 4, background: '#12345680' } });
    const webp = await staticImage.clone().webp({ lossless: true }).toBuffer();
    expect((await normalizeSource(webp)).mimeType).toBe('image/webp');
    await expect(normalizeSource(Buffer.from('<svg/>'))).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    await expect(normalizeSource(webp, { maxBytes: 4 })).rejects.toMatchObject({ code: 'UPLOAD_SIZE' });
    await expect(normalizeSource(webp.subarray(0, webp.length - 12))).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    const tiny = await staticImage.clone().resize(64, 64).png().toBuffer();
    await expect(normalizeSource(tiny)).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS' });
    const highPrecision = await staticImage.clone().toColourspace('rgb16').png().toBuffer();
    await expect(normalizeSource(highPrecision)).rejects.toMatchObject({ code: 'UNSUPPORTED_PRECISION' });
    const animated = await sharp({ create: { width: 256, height: 512, channels: 4, background: '#f00' } }).raw().toBuffer();
    for (let i = 256 * 256 * 4; i < animated.length; i += 4) { animated[i] = 0; animated[i + 1] = 255; }
    const multipage = await sharp(animated, { raw: { width: 256, height: 512, channels: 4, pageHeight: 256 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    await expect(normalizeSource(multipage)).rejects.toMatchObject({ code: 'ANIMATED_IMAGE' });
  });
});
