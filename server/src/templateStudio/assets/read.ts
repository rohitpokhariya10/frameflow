import sharp from "sharp";
import type { AssetRecord as Asset } from "../store.js";
import { readStorageFile } from "../storage.js";

export type Variant = "original" | "normalised" | "analysis" | "thumb";

const FIELD = { original: "originalPath", normalised: "normalisedPath", analysis: "analysisPath", thumb: "thumbPath" } as const;

export async function readAssetImage(storageDir: string, asset: Asset, variant: Variant) {
  const rel = asset[FIELD[variant]];
  const data = await readStorageFile(storageDir, rel);
  const meta = await sharp(data).metadata();
  const mime = rel.endsWith(".png") ? "image/png" : rel.endsWith(".webp") ? "image/webp" : rel.endsWith(".svg") ? "image/svg+xml" : "image/jpeg";
  return { data, mime, width: meta.width ?? asset.width, height: meta.height ?? asset.height };
}
