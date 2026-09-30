import sharp from 'sharp';

export type RawRgba = { data: Buffer; width: number; height: number };
export async function decodeRgba(bytes: Buffer): Promise<RawRgba> {
  const decoded = await sharp(bytes, { limitInputPixels: 12_000_000, failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}
