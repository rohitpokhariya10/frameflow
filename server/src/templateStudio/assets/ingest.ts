import { createHash } from "node:crypto";
import path from "node:path";
import sharp, { type OutputInfo } from "sharp";
import { newId, now, type AssetRecord, type StudioStore } from "../store.js";
import { writeStorageFile } from "../storage.js";
import {
  LIMITS,
  MIME_BY_TYPE,
  UploadRejectedError,
  checkDeclaredMime,
  findSvgProblems,
  inspectRaster,
  sniffType,
  type AssetRole,
} from "./validate.js";

/** Long edge of the derivative sent to vision models (bounded input cost). */
export const ANALYSIS_LONG_EDGE = 1536;
export const THUMB_LONG_EDGE = 384;

export interface IngestInput {
  buffer: Buffer;
  declaredMime?: string;
  filename?: string;
  role: AssetRole;
  label?: string;
}

export interface IngestDeps {
  db: StudioStore;
  storageDir: string;
}

export function sanitiseFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = path.basename(name.replaceAll("\\", "/"));
  // Control characters are stripped on purpose (Generator ingest.ts).
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean || null;
}

/**
 * Validate an upload, store the untouched original, and create normalised,
 * analysis-sized, and thumbnail derivatives. Identical content uploaded again
 * for the same role returns the existing asset.
 */
export async function ingestAsset(input: IngestInput, deps: IngestDeps) {
  const { buffer, role } = input;
  if (buffer.length === 0) throw new UploadRejectedError("empty", "The file is empty.");
  if (buffer.length > LIMITS.maxUploadBytes) {
    throw new UploadRejectedError(
      "too_large",
      `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${LIMITS.maxUploadBytes / 1024 / 1024} MB.`,
    );
  }

  const type = sniffType(buffer);
  if (!type) {
    throw new UploadRejectedError("unsupported_type", "Only PNG, JPEG, and WebP images are accepted (SVG for logos).");
  }
  checkDeclaredMime(input.declaredMime, type);

  // Raster source used for all derivatives. SVG logos are rasterised once here.
  let raster: Buffer = buffer;
  if (type === "svg") {
    if (role !== "logo") {
      throw new UploadRejectedError("svg_not_allowed", "SVG is accepted for logos only.");
    }
    raster = await rasteriseSvg(buffer);
  }

  const info = await inspectRaster(raster);
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const existing = deps.db.assets.find((a) => a.sha256 === sha256 && a.role === role);
  if (existing) return { asset: existing, deduplicated: true as const };

  const pipeline = () =>
    sharp(raster, { limitInputPixels: LIMITS.maxPixels, failOn: "error" }).rotate().toColorspace("srgb");

  let normalised: Buffer;
  let normalisedInfo: OutputInfo;
  try {
    ({ data: normalised, info: normalisedInfo } = await pipeline()
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }));
  } catch {
    throw new UploadRejectedError("corrupt", "The image could not be decoded; it may be corrupt or truncated.");
  }

  const hasAlpha = normalisedInfo.channels === 4 && !(await sharp(normalised).stats()).isOpaque;
  if (role === "cutout" && !hasAlpha) {
    throw new UploadRejectedError(
      "unsupported_type",
      "A cutout must be a PNG or WebP with a transparent background. This image is fully opaque.",
    );
  }

  const resized = (edge: number) =>
    sharp(normalised).resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
  const analysis = hasAlpha
    ? await resized(ANALYSIS_LONG_EDGE).png().toBuffer()
    : await resized(ANALYSIS_LONG_EDGE).jpeg({ quality: 90 }).toBuffer();
  const thumb = await resized(THUMB_LONG_EDGE).webp({ quality: 82 }).toBuffer();

  const ext = type === "jpeg" ? "jpg" : type;
  const dir = `${role}/${sha256.slice(0, 2)}/${sha256}`;
  const paths = {
    originalPath: `${dir}/original.${ext}`,
    normalisedPath: `${dir}/normalised.png`,
    analysisPath: `${dir}/analysis.${hasAlpha ? "png" : "jpg"}`,
    thumbPath: `${dir}/thumb.webp`,
  };

  await writeStorageFile(deps.storageDir, paths.originalPath, buffer);
  await writeStorageFile(deps.storageDir, paths.normalisedPath, normalised);
  await writeStorageFile(deps.storageDir, paths.analysisPath, analysis);
  await writeStorageFile(deps.storageDir, paths.thumbPath, thumb);

  // Same content uploaded again meanwhile (two tabs): keep the first record; the files are identical.
  const raced = deps.db.assets.find((a) => a.sha256 === sha256 && a.role === role);
  if (raced) return { asset: raced, deduplicated: true as const };
  const asset: AssetRecord = deps.db.assets.insert({
    id: newId("ast"),
    role,
    sha256,
    mimeType: MIME_BY_TYPE[type],
    width: info.width,
    height: info.height,
    bytes: buffer.length,
    hasAlpha,
    sourceFilename: sanitiseFilename(input.filename),
    label: input.label?.trim().slice(0, 200) || null,
    ...paths,
    createdAt: now(),
  });
  return { asset, deduplicated: false as const };
}

async function rasteriseSvg(svg: Buffer): Promise<Buffer> {
  if (svg.length > LIMITS.maxSvgBytes) {
    throw new UploadRejectedError("too_large", `SVG logos must be under ${LIMITS.maxSvgBytes / 1024} KB.`);
  }
  const problems = findSvgProblems(svg.toString("utf8"));
  if (problems.length) {
    throw new UploadRejectedError(
      "unsafe_svg",
      `This SVG contains content we don't accept (${problems.slice(0, 3).join(", ")}). Export it as a plain SVG or PNG.`,
    );
  }
  try {
    const meta = await sharp(svg).metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0) || 512;
    const density = Math.min(2400, Math.max(1, Math.round((72 * LIMITS.svgRasterLongEdge) / longEdge)));
    return await sharp(svg, { density, limitInputPixels: LIMITS.maxPixels }).png().toBuffer();
  } catch {
    throw new UploadRejectedError("corrupt", "The SVG could not be rendered.");
  }
}
