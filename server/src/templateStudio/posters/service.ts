import { createHash } from "node:crypto";
import { readStorageFile } from "../storage.js";
import { brandRules, findColour, type BrandRules } from "../contracts/brand.js";
import { listFonts } from "../fonts/library.js";
import { overlayDocSchema, type LayoutReport, type OverlayDoc } from "../compose/overlay.js";
import { renderLogoLockup, renderPoster, type KitLogo } from "../compose/render.js";
import type { PosterRecord, StudioStore as Db } from "../store.js";

export function loadKitLogos(db: Db, storageDir: string, brandKitId: string | null, rules: BrandRules | null): Promise<KitLogo[]> {
  if (!brandKitId) return Promise.resolve([]);
  const logos = db.brandKitLogos.filter((l) => l.brandKitId === brandKitId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return Promise.all(
    logos.map(async (l) => ({
      id: l.id,
      kind: l.kind as KitLogo["kind"],
      name: l.name,
      colourHex: l.colourName && rules ? (findColour(rules, l.colourName)?.hex ?? null) : null,
      data: await readStorageFile(storageDir, db.assets.require(l.assetId, "Logo asset").normalisedPath),
    })),
  );
}

/** Brand rules as snapshotted on the campaign (so later kit edits don't change old posters). */
export function snapshotRules(snapshot: unknown): BrandRules | null {
  const rules = (snapshot as { rules?: unknown } | null)?.rules;
  if (!rules) return null;
  const parsed = brandRules.safeParse(rules);
  return parsed.success ? parsed.data : null;
}

async function renderInput(db: Db, storageDir: string, doc: OverlayDoc, rules: BrandRules | null) {
  const scene = db.assets.require(doc.sceneAssetId, "Scene");
  const sceneData = await readStorageFile(storageDir, scene.normalisedPath);
  const { faces } = await listFonts(db, doc.brandKitId);
  const logos = await loadKitLogos(db, storageDir, doc.brandKitId, rules);
  return { doc, scene: sceneData, faces, storageDir, logos, rules };
}

export async function renderDoc(db: Db, storageDir: string, doc: OverlayDoc, rules: BrandRules | null, output: { format: "png" | "jpeg"; width?: number } = { format: "png" }) {
  return renderPoster(await renderInput(db, storageDir, doc, rules), output);
}

/** The poster's logo lock-up alone, transparent, cut to its box: the logo layer FrameFlow's editor receives. */
export async function renderPosterLogo(db: Db, storageDir: string, poster: PosterRecord) {
  const campaign = db.campaigns.require(poster.campaignId, "Campaign");
  const doc = overlayDocSchema.parse(poster.overlay);
  if (!doc.logo || doc.logo.hidden) return null;
  return renderLogoLockup(await renderInput(db, storageDir, doc, snapshotRules(campaign.brandSnapshot)));
}

// Small in-memory cache of recent renders (preview requests repeat often).
const cache = new Map<string, Buffer>();
const CACHE_LIMIT = 24;

export async function renderPosterImage(db: Db, storageDir: string, poster: PosterRecord, output: { format: "png" | "jpeg"; width?: number }) {
  const key = createHash("sha1").update(`${poster.id}:${poster.updatedAt}:${output.format}:${output.width ?? 0}`).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  const campaign = db.campaigns.require(poster.campaignId, "Campaign");
  const doc = overlayDocSchema.parse(poster.overlay);
  const { image } = await renderDoc(db, storageDir, doc, snapshotRules(campaign.brandSnapshot), output);
  cache.set(key, image);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return image;
}

export type { LayoutReport };
