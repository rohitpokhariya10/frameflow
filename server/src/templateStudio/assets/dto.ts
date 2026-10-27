import type { StudioAsset } from "@frameflow/shared";
import type { AssetRecord } from "../store.js";

/** Client-safe asset view. Storage paths stay on the server. */
export function toAssetDto(a: AssetRecord): StudioAsset {
  const base = `/api/template-studio/assets/${a.id}`;
  return {
    id: a.id,
    role: a.role,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
    bytes: a.bytes,
    hasAlpha: a.hasAlpha,
    sourceFilename: a.sourceFilename,
    label: a.label,
    sha256: a.sha256,
    createdAt: a.createdAt,
    urls: {
      thumb: `${base}?variant=thumb`,
      normalised: `${base}?variant=normalised`,
      original: `${base}?variant=original`,
    },
  };
}

export type AssetDto = StudioAsset;
