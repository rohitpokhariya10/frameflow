import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { classifySeedreamRejection, prepareProviderImage, rejectionExplanation, SEEDREAM_IMAGE_LIMITS, sniffFormat, verifyUploadedImage } from './providerImage.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const solid = (width: number, height: number, channels: 3 | 4 = 3) => sharp({ create: { width, height, channels, background: channels === 4 ? { r: 40, g: 90, b: 160, alpha: 0.5 } : '#285aa0' } });
const pixels = async (b: Buffer) => sha(await sharp(b).removeAlpha().raw().toBuffer());

describe('the image every Seedream request gets: checked locally, canonical, read back', () => {
  it('a clean PNG or JPEG is sent byte for byte (what every accepted upload on record looks like)', async () => {
    for (const bytes of [await solid(800, 1000).png().toBuffer(), await solid(800, 1000).jpeg().toBuffer()]) {
      const prepared = await prepareProviderImage(bytes, sniffFormat(bytes) === 'png' ? 'image/png' : 'image/jpeg');
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.report.provider).toMatchObject({ sha256: sha(bytes), normalized: false, steps: [] });
    }
  });

  it('a wrong MIME, an alpha channel, an ICC profile or EXIF get a canonical PNG of the same pixels (the creative itself is not touched)', async () => {
    const jpeg = await solid(800, 1000).jpeg().toBuffer();
    const mislabelled = await prepareProviderImage(jpeg, 'image/png');
    expect(mislabelled.report.provider).toMatchObject({ normalized: true, mime: 'image/png', steps: ['declared image/png but is jpeg'] });
    const rgba = await solid(800, 1000, 4).png().toBuffer(), flattened = await prepareProviderImage(rgba, 'image/png');
    expect(flattened.report.provider.steps).toContain('alpha flattened onto white');
    expect((await sharp(flattened.bytes).metadata())).toMatchObject({ channels: 3, hasAlpha: false, density: 72 });
    const tagged = await solid(800, 1000).withIccProfile('srgb').withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer(), clean = await prepareProviderImage(tagged, 'image/png');
    expect(clean.report.provider.steps).toEqual(expect.arrayContaining(['ICC profile removed (pixels in sRGB)', 'EXIF removed']));
    const meta = await sharp(clean.bytes).metadata();
    expect([meta.icc, meta.exif]).toEqual([undefined, undefined]);
    expect(await pixels(clean.bytes)).toBe(await pixels(tagged));
  });

  it('refuses locally what cannot be valid input: corrupt, unsupported, or outside the published size and ratio limits', async () => {
    const png = await solid(800, 1000).png().toBuffer();
    await expect(prepareProviderImage(png.subarray(0, png.length - 200), 'image/png')).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
    await expect(prepareProviderImage(Buffer.from('not an image at all'), 'image/png')).rejects.toMatchObject({ code: 'IMAGE_FORMAT_UNSUPPORTED' });
    await expect(prepareProviderImage(await solid(300, 300).png().toBuffer(), 'image/png')).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_INVALID' });
    await expect(prepareProviderImage(await solid(4000, 200).png().toBuffer(), 'image/png')).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_INVALID' });
  });

  it('the upload must read back as exactly the prepared bytes; an unreadable or expired URL submits nothing', async () => {
    const png = await solid(800, 1000).png().toBuffer();
    await expect(verifyUploadedImage('https://v3b.fal.media/a.png', sha(png), async () => png)).resolves.toBeUndefined();
    await expect(verifyUploadedImage('https://v3b.fal.media/a.png', sha(png), async () => Buffer.concat([png, Buffer.from([0])]))).rejects.toMatchObject({ code: 'UPLOAD_MISMATCH' });
    await expect(verifyUploadedImage('https://v3b.fal.media/a.png', sha(png), async () => { throw new Error('HTTP 403 expired'); })).rejects.toMatchObject({ code: 'UPLOAD_UNREADABLE' });
  });

  it('enforces the encoded-size limit even when a valid image needs no conversion', async () => {
    const png = await solid(512, 512).png().toBuffer();
    // PNG decoders accept trailing bytes; the provider limit still counts the entire uploaded file.
    const atLimit = Buffer.concat([png, Buffer.alloc(SEEDREAM_IMAGE_LIMITS.maxBytes - png.length)]);
    expect((await prepareProviderImage(atLimit, 'image/png')).bytes).toBe(atLimit);
    await expect(prepareProviderImage(Buffer.concat([atLimit, Buffer.from([0])]), 'image/png')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });

  it('classifies fal refusals from fal\'s own words, never from our plan', () => {
    const at = { endpoint: 'bytedance/seedream/v5/pro/layerize', imageSha256: 'abc', prompt: 'Create 3 layers' };
    const partner = classifySeedreamRejection({ status: 422, billableUnits: '0', messages: [{ msg: 'flagged by a content checker', type: 'content_policy_violation', loc: 'body.image', reason: 'partner_validation_failed' }] }, at);
    expect(partner).toMatchObject({ category: 'partner-content', loc: 'body.image', reason: 'partner_validation_failed', billableUnits: '0', imageSha256: 'abc', promptSha256: sha(Buffer.from('Create 3 layers')) });
    expect(rejectionExplanation(partner)).toMatch(/partner content check refused this image .* the reason is not disclosed\. fal billed 0 units/);
    expect(classifySeedreamRejection({ status: 422, messages: [{ msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request', loc: 'body.image_url' }] }, at).category).toBe('unprocessable-image');
    expect(classifySeedreamRejection({ status: 422, messages: [{ msg: 'Failed to download the image from the URL', loc: 'body.image_url' }] }, at).category).toBe('image-url');
    expect(classifySeedreamRejection({ status: 422, messages: [{ msg: 'Input should be auto', loc: 'body.image_size', type: 'literal_error' }] }, at).category).toBe('invalid-request');
    expect(classifySeedreamRejection({ status: 503, messages: [] }, at).category).toBe('temporary');
  });
});
