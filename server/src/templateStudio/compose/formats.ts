/**
 * Output formats. GPT Image 2 accepts any size whose sides are multiples of 16,
 * so each format is generated at (or within a few pixels of) its own aspect
 * ratio. Nothing important is lost to cropping; any small remaining crop is
 * recorded and shown, and the planner and image prompt both know about it.
 */
import { STUDIO_FORMATS, type StudioFormat } from "@frameflow/shared";

export type OutputFormat = StudioFormat;

/** The formats themselves live in @frameflow/shared (the browser lists the same ones). */
export const FORMATS: readonly OutputFormat[] = STUDIO_FORMATS;

export function getFormat(id: string): OutputFormat | undefined {
  return FORMATS.find((f) => f.id === id);
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centred crop of the generated image that matches the output aspect ratio. */
export function sceneCrop(format: OutputFormat): { source: { width: number; height: number }; crop: CropRect } {
  const [sw, sh] = format.providerSize.split("x").map(Number);
  const target = format.width / format.height;
  let width = sw;
  let height = Math.round(sw / target);
  if (height > sh) {
    height = sh;
    width = Math.round(sh * target);
  }
  return {
    source: { width: sw, height: sh },
    crop: { x: Math.floor((sw - width) / 2), y: Math.floor((sh - height) / 2), width, height },
  };
}

/** Map a box in final-canvas normalised coords to normalised coords in the generated image. */
export function canvasToSource(format: OutputFormat, box: { x: number; y: number; width: number; height: number }) {
  const { source, crop } = sceneCrop(format);
  return {
    x: (crop.x + box.x * crop.width) / source.width,
    y: (crop.y + box.y * crop.height) / source.height,
    width: (box.width * crop.width) / source.width,
    height: (box.height * crop.height) / source.height,
  };
}

export function describeCrop(format: OutputFormat) {
  const { source, crop } = sceneCrop(format);
  if (crop.width === source.width && crop.height === source.height) {
    return `Generated at ${source.width}×${source.height} and exported at ${format.width}×${format.height}.`;
  }
  return `Generated at ${source.width}×${source.height}, cropped to ${crop.width}×${crop.height} (centre), exported at ${format.width}×${format.height}.`;
}
