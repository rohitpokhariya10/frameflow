import sharp from 'sharp';
import { createTransform } from '../image/coordinates.js';
import type { ImageTransform } from '../image/coordinates.js';
import { ImageValidationError } from '../image/types.js';
import { sha256 } from './source.js';

export type AnalysisResult = { analysis: Buffer; preview: Buffer; width: number; height: number; transform: ImageTransform; sha256: string };

export async function createAnalysis(master: Buffer, maxSide = 1024, previewMaxSide = 512): Promise<AnalysisResult> {
  const metadata = await sharp(master, { limitInputPixels: 12_000_000, failOn: 'warning' }).metadata();
  if (!metadata.width || !metadata.height) throw new ImageValidationError('INVALID_IMAGE', 'Working master dimensions are missing.');
  const transform = createTransform(metadata.width, metadata.height, maxSide);
  const previewTransform = createTransform(metadata.width, metadata.height, previewMaxSide);
  // Provider input is deliberately opaque. The original/master alpha remains unchanged.
  const analysis = await sharp(master).flatten({ background: '#ffffff' }).resize(transform.resizedWidth, transform.resizedHeight, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  const preview = await sharp(master).resize(previewTransform.resizedWidth, previewTransform.resizedHeight, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  return { analysis, preview, width: transform.modelWidth, height: transform.modelHeight, transform, sha256: sha256(analysis) };
}
