/**
 * Exact product pixels: an isolated adapter onto FrameFlow's existing source-pixel compositor
 * (decomposition/creativeTemplates/variantCompose.ts, composeVariant), which is used as is.
 *
 * The image model always redraws products. When the user asks for exact product pixels, each product must be a
 * transparent cutout; its own pixels are placed where the art director planned the product (the region the layout guide
 * told the model to fill), and composeVariant removes the model's redrawn product around it, fills the scenery, adds a
 * contact shadow where needed and measures that every opaque product pixel is exactly the cutout's. Nothing here calls a
 * provider.
 */
import sharp from 'sharp';
import { composeVariant, type VariantSubject } from '../decomposition/creativeTemplates/variantCompose.js';

type Box = { x: number; y: number; width: number; height: number };
export interface ExactProduct { id: string; label: string; cutout: Buffer; region: Box }
export interface ExactProductsResult { composite: Buffer; ok: boolean; detail: string }

/**
 * scene: the generated image; crop: the part of it the poster uses (scene pixels); products: back to front, each with its
 * cutout (PNG with alpha) and its planned region as fractions of the poster canvas; grounded: products stand on something.
 */
export async function composeExactProducts(scene: Buffer, crop: Box, products: ExactProduct[], grounded: boolean): Promise<ExactProductsResult> {
  const { width, height } = crop;
  const generated = await sharp(scene).extract({ left: crop.x, top: crop.y, width, height }).removeAlpha().png().toBuffer();
  // The source canvas composeVariant works on: the generated scenery with each product's own pixels where it was planned.
  const rgb = Buffer.from(await sharp(generated).raw().toBuffer());
  const subjects: VariantSubject[] = [];
  for (const product of products) {
    const trimmed = await sharp(product.cutout).ensureAlpha().trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    const box = { x: product.region.x * width, y: product.region.y * height, w: product.region.width * width, h: product.region.height * height };
    const scale = Math.min(box.w / trimmed.info.width, box.h / trimmed.info.height);
    const w = Math.max(1, Math.round(trimmed.info.width * scale)), h = Math.max(1, Math.round(trimmed.info.height * scale));
    // Contained in its region, centred, standing on the region's bottom edge (as the planner's boxes are).
    const left = Math.round(box.x + (box.w - w) / 2), top = Math.round(box.y + box.h - h);
    const { data } = await sharp(trimmed.data).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < h; y++) {
      const cy = top + y;
      if (cy < 0 || cy >= height) continue;
      for (let x = 0; x < w; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= width) continue;
        const a = data[(y * w + x) * 4 + 3];
        if (!a) continue;
        const i = cy * width + cx;
        mask[i] = a;
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = data[(y * w + x) * 4 + c];
      }
    }
    subjects.push({ id: product.id, label: product.label, mask, shadow: grounded });
  }
  const composed = await composeVariant(generated, { x: 0, y: 0, width, height }, { rgb, width, height }, subjects);
  const p = composed.preservation;
  const detail = p.ok
    ? `${products.length} product${products.length === 1 ? '' : 's'} placed from your cutouts with their exact pixels (${p.checkedPixels.toLocaleString('en-US')} opaque pixels checked, no difference). The model's redrawn products were removed around them.`
    : `Products were placed from your cutouts, but the pixel check did not pass (largest difference ${p.maxDifference}, edge error ${p.edgeMaxError}, ${p.outsideAlphaPixels} pixels outside the cutouts). Check the products by eye.`;
  return { composite: composed.composite, ok: p.ok, detail };
}
