import type { AssetRole as StoreAssetRole } from "../store.js";
import sharp, { type Metadata } from "sharp";

export const ASSET_ROLES = ["reference", "subject", "logo", "generated_scene", "layout_guide", "export", "cutout"] as const satisfies readonly StoreAssetRole[];
export type AssetRole = (typeof ASSET_ROLES)[number];

/** Roles a user may upload directly. Generated/export assets are created by the app. */
export const UPLOADABLE_ROLES = ["reference", "subject", "logo", "cutout"] as const;
export type UploadableRole = (typeof UPLOADABLE_ROLES)[number];

export const LIMITS = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxSvgBytes: 1024 * 1024,
  maxDimension: 10_000,
  minDimension: 8,
  /** Decompression-bomb guard: decoded pixel count, checked before full decode. */
  maxPixels: 40_000_000,
  /** Rasterised long edge for uploaded SVG logos. */
  svgRasterLongEdge: 2048,
} as const;

export type DetectedType = "png" | "jpeg" | "webp" | "svg";

export const MIME_BY_TYPE: Record<DetectedType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export class UploadRejectedError extends Error {
  constructor(
    public readonly code:
      | "too_large"
      | "empty"
      | "unsupported_type"
      | "mime_mismatch"
      | "svg_not_allowed"
      | "unsafe_svg"
      | "bad_dimensions"
      | "too_many_pixels"
      | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

/** Identify the file from its leading bytes; the client-declared MIME type is not trusted. */
export function sniffType(buf: Buffer): DetectedType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (looksLikeSvg(buf)) return "svg";
  return null;
}

function looksLikeSvg(buf: Buffer): boolean {
  let head = buf.subarray(0, 4096).toString("utf8");
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  // Skip XML declaration, comments, and whitespace before the root element.
  head = head
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trimStart();
  return /^<svg[\s>]/i.test(head);
}

const GENERIC_MIMES = new Set(["", "application/octet-stream"]);

export function checkDeclaredMime(declared: string | undefined, detected: DetectedType) {
  const d = (declared ?? "").toLowerCase().split(";")[0].trim();
  if (GENERIC_MIMES.has(d)) return;
  const expected = MIME_BY_TYPE[detected];
  const aliases = detected === "jpeg" ? [expected, "image/jpg", "image/pjpeg"] : [expected];
  if (!aliases.includes(d)) {
    throw new UploadRejectedError(
      "mime_mismatch",
      `File content is ${detected.toUpperCase()} but was declared as ${d}.`,
    );
  }
}

/**
 * Conservative SVG allow-check. We never serve uploaded SVG for rendering; it is
 * rasterised. These checks stop the rasteriser from following external
 * references or entity expansion, and reject active content outright.
 */
export function findSvgProblems(svg: string): string[] {
  const problems: string[] = [];
  if (/<!DOCTYPE/i.test(svg) || /<!ENTITY/i.test(svg)) problems.push("DOCTYPE/ENTITY declarations");
  if (/<script[\s>]/i.test(svg)) problems.push("script elements");
  if (/<foreignObject[\s>]/i.test(svg)) problems.push("foreignObject elements");
  if (/\son[a-z]+\s*=/i.test(svg)) problems.push("event handler attributes");
  if (/<\?xml-stylesheet/i.test(svg)) problems.push("external stylesheets");
  if (/@import/i.test(svg)) problems.push("CSS @import");

  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!isSafeSvgRef(m[2])) problems.push(`external reference "${m[2].slice(0, 60)}"`);
  }
  for (const m of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!isSafeSvgRef(m[2])) problems.push(`external url() "${m[2].slice(0, 60)}"`);
  }
  return problems;
}

function isSafeSvgRef(ref: string): boolean {
  const r = ref.trim();
  return r.startsWith("#") || /^data:image\/(png|jpeg|webp);base64,/i.test(r);
}

export interface RasterInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Read header dimensions and enforce size limits before decoding pixel data. */
export async function inspectRaster(buf: Buffer): Promise<RasterInfo> {
  let meta: Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: false }).metadata();
  } catch {
    throw new UploadRejectedError("corrupt", "The image could not be read; it may be corrupt.");
  }
  // EXIF orientations 5–8 swap width and height once rotated.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  if (width * height > LIMITS.maxPixels) {
    throw new UploadRejectedError(
      "too_many_pixels",
      `Image is ${width}×${height}; the limit is ${LIMITS.maxPixels.toLocaleString("en-US")} pixels.`,
    );
  }
  if (
    width < LIMITS.minDimension ||
    height < LIMITS.minDimension ||
    width > LIMITS.maxDimension ||
    height > LIMITS.maxDimension
  ) {
    throw new UploadRejectedError(
      "bad_dimensions",
      `Image is ${width}×${height}; each side must be between ${LIMITS.minDimension} and ${LIMITS.maxDimension}px.`,
    );
  }
  return { width, height, hasAlpha: Boolean(meta.hasAlpha) };
}
