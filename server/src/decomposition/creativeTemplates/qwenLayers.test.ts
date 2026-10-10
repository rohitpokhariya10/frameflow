import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from '../providers/falClient.js';
import { qwenAlignment, qwenEditorLayers, QwenLayersError, QWEN_ENDPOINT, requestQwenLayers } from './qwenLayers.js';

/** Qwen-Image-Layered's working size: about 640×640 pixels at the input's aspect ratio, each side a multiple of 32. */
function bucket(width: number, height: number) {
  const w = Math.sqrt(640 * 640 * width / height), h = w / (width / height);
  return { width: Math.round(w / 32) * 32, height: Math.round(h / 32) * 32 };
}
type Box = { x: number; y: number; width: number; height: number };
const raw = (width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return sharp(data, { raw: { width, height, channels: 4 } });
};
const inside = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
/**
 * A creative (a gradient scene, a blue product partly in front of an orange one) and Qwen-like layers of it, made the
 * way the real ones are: each layer drawn on the creative's canvas and stretched to Qwen's working size. Layer 0 is an
 * opaque black plate that the clean scene above covers entirely; the products' layers carry Qwen's faint alpha haze.
 */
async function scene(width: number, height: number, mapping: 'stretch' | 'crop' = 'stretch') {
  const back = { x: Math.round(width * 0.2), y: Math.round(height * 0.3), width: Math.round(width * 0.3), height: Math.round(height * 0.4) };
  const front = { x: Math.round(width * 0.4), y: Math.round(height * 0.35), width: Math.round(width * 0.3), height: Math.round(height * 0.45) };
  const sceneAt = (x: number, y: number): [number, number, number, number] => [40 + Math.round(150 * x / width), 60 + Math.round(120 * y / height), 170, 255];
  const source = await raw(width, height, (x, y) => inside(front, x, y) ? [30, 70, 210, 255] : inside(back, x, y) ? [235, 140, 30, 255] : sceneAt(x, y)).removeAlpha().png().toBuffer();
  const at = bucket(width, height);
  const toQwen = async (image: ReturnType<typeof sharp>) => {
    const png = await image.png().toBuffer();
    if (mapping === 'stretch') return sharp(png).resize(at.width, at.height, { fit: 'fill' }).png().toBuffer();
    return sharp(png).resize(at.width, at.height, { fit: 'cover' }).png().toBuffer(); // a crop: what Qwen does not do
  };
  const outputs = [
    await toQwen(raw(width, height, () => [0, 0, 0, 255])),
    await toQwen(raw(width, height, sceneAt)),
    await toQwen(raw(width, height, (x, y) => inside(back, x, y) ? [235, 140, 30, 255] : [0, 0, 0, 2])),
    await toQwen(raw(width, height, (x, y) => inside(front, x, y) ? [30, 70, 210, 255] : [0, 0, 0, 2])),
  ];
  return { source, outputs, back, front, sceneAt, at };
}

describe('Qwen-Image-Layered layers on the creative\'s own canvas (offline: no request)', () => {
  for (const [width, height] of [[900, 1600], [1600, 900], [1200, 1500]]) {
    it(`${width}×${height}: placed by the stretch Qwen uses, hidden plates left out, the creative rebuilt from its own pixels, a clean background behind the products`, async () => {
      const { source, outputs, back, front, sceneAt, at } = await scene(width, height);
      const alignment = await qwenAlignment(source, outputs);
      expect(alignment).toMatchObject({ ok: true, mapping: 'stretch', order: 'as-returned', providerWidth: at.width, providerHeight: at.height });
      expect(alignment.errors.stretch).toBeLessThan(Math.min(alignment.errors.cover, alignment.errors.contain));
      const { layers, report } = await qwenEditorLayers(source, outputs, { labels: [{ label: 'Speaker', box: back }, { label: 'Phone', box: front }] });
      expect(report).toMatchObject({ returned: 4, kept: 3, dropped: [{ index: 0, reason: 'hidden' }], background: 'qwen' });
      expect(layers.map(l => l.name)).toEqual([expect.stringMatching(/^Background \(Qwen; [\d.]+% hidden behind objects is AI-generated\)$/), 'Speaker', 'Phone']);
      expect(layers[0]).toMatchObject({ kind: 'full-canvas', placement: { x: 0, y: 0, width, height } });
      // Each product's layer sits where the product is, not across the canvas (the haze is cleared): within the upscale's
      // soft edge, which reaches 3 of Qwen's pixels (lanczos3) beyond the product.
      const slack = Math.ceil(3 * Math.max(width / at.width, height / at.height)) + 1;
      for (const [layer, box] of [[layers[1], back], [layers[2], front]] as const) {
        expect(layer.kind).toBe('bbox-crop');
        for (const [a, b] of [[layer.placement.x, box.x], [layer.placement.y, box.y], [layer.placement.x + layer.placement.width, box.x + box.width], [layer.placement.y + layer.placement.height, box.y + box.height]]) expect(Math.abs(a - b)).toBeLessThanOrEqual(slack);
      }
      expect(report.reconstruction.mae).toBeLessThan(1.5);
      // Behind the front product the background is the scene, not a copy of the product (it can be moved).
      const bg = await sharp(layers[0].png).raw().toBuffer(), cx = front.x + Math.round(front.width / 2), cy = front.y + Math.round(front.height / 2), i = (cy * width + cx) * 3;
      expect(Math.max(...[bg[i], bg[i + 1], bg[i + 2]].map((v, c) => Math.abs(v - sceneAt(cx, cy)[c])))).toBeLessThan(12);
      // The back product's hidden part (behind the front one) is Qwen's own pixels; its visible part is the creative's exactly.
      const backLayer = await sharp(layers[1].png).raw().toBuffer({ resolveWithObject: true }), src = await sharp(source).raw().toBuffer();
      const vx = back.x + 10, vy = back.y + 10, j = ((vy - layers[1].placement.y) * backLayer.info.width + (vx - layers[1].placement.x)) * 4, s = (vy * width + vx) * 3;
      expect([backLayer.data[j], backLayer.data[j + 1], backLayer.data[j + 2], backLayer.data[j + 3]]).toEqual([src[s], src[s + 1], src[s + 2], 255]);
      expect(report.layers[1].aiPercent).toBeGreaterThan(5);
    });
  }

  it('refuses layers that do not line up with the stretch (a crop), or that show another image: never placed by guesswork', async () => {
    const cropped = await scene(900, 1600, 'crop');
    await expect(qwenEditorLayers(cropped.source, cropped.outputs)).rejects.toMatchObject({ code: 'QWEN_LAYERS_UNALIGNED' });
    const other = await scene(900, 1600), unrelated = await sharp({ create: { width: 900, height: 1600, channels: 3, background: '#f0f0f0' } }).png().toBuffer();
    await expect(qwenEditorLayers(unrelated, other.outputs)).rejects.toBeInstanceOf(QwenLayersError);
    await expect(qwenEditorLayers(other.source, [])).rejects.toMatchObject({ code: 'QWEN_LAYERS_EMPTY' });
  });
});

describe('the Qwen request (fake transport)', () => {
  const fake = (result: unknown, files: Buffer[]) => {
    const uploads: Buffer[] = [], submitted: { endpoint: string; input: Record<string, unknown> }[] = [];
    const transport: FalTransport = { upload: async bytes => { uploads.push(bytes); return 'https://v3b.fal.media/files/t/in.png'; },
      submit: async (endpoint, input) => { submitted.push({ endpoint, input }); return { requestId: 'q1' }; }, status: async () => 'COMPLETED', result: async () => result,
      cancel: async () => undefined, download: async url => files[Number(/-(\d+)\.png$/.exec(url)![1])] };
    return { transport, uploads, submitted };
  };
  it('sends one request with safety checking on and a seed fixed by the image, the whole frame at most 1024 px long, and saves no URL', async () => {
    const { source, outputs } = await scene(900, 1600), saved: Record<string, object> = {}, submitted = vi.fn();
    const f = fake({ images: outputs.map((_, k) => ({ url: `https://v3b.fal.media/files/t/out-${k}.png`, width: 480, height: 864, content_type: 'image/png' })), seed: 7, has_nsfw_concepts: [false, false, false, false] }, outputs);
    const result = await requestQwenLayers(f.transport, source, { caption: 'An advertising image: phone, speaker, in front of a background.', numLayers: 5, save: (file, value) => { saved[file] = value; }, onSubmitted: submitted, sleep: async () => undefined });
    expect(result.images).toHaveLength(4);
    expect(submitted).toHaveBeenCalledWith('q1');
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]).toMatchObject({ endpoint: QWEN_ENDPOINT, input: { num_layers: 5, enable_safety_checker: true, output_format: 'png', seed: expect.any(Number) } });
    expect(await sharp(f.uploads[0]).metadata()).toMatchObject({ width: 576, height: 1024 });
    expect(JSON.stringify(saved)).not.toContain('https://');
    expect(saved['request.json']).toMatchObject({ input: { image_url: '<uploaded copy, 576x1024>' } });
  });
  it('a safety refusal is a failure of this request, said so, never retried', async () => {
    const { source, outputs } = await scene(900, 1600), saved: Record<string, object> = {};
    const f = fake({ images: [{ url: 'https://v3b.fal.media/files/t/out-0.png' }], has_nsfw_concepts: [true] }, outputs);
    await expect(requestQwenLayers(f.transport, source, { caption: 'x', numLayers: 4, save: (file, value) => { saved[file] = value; }, sleep: async () => undefined })).rejects.toMatchObject({ code: 'QWEN_REQUEST_FAILED' });
    expect(f.submitted).toHaveLength(1);
    expect(saved['error.json']).toMatchObject({ code: 'PROVIDER_SAFETY_REFUSAL' });
  });
});
