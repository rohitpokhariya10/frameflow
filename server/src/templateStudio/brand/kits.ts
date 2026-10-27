import { createHash } from "node:crypto";
import { z } from "zod";
import type { StudioBrandKit } from "@frameflow/shared";
import { newId, now, type BrandFontRecord as BrandFont, type BrandKitLogoRecord as BrandKitLogo, type BrandKitRecord as BrandKit, type StudioStore as Db } from "../store.js";
import { BRAND_RULES_SCHEMA, brandRules, brandRuleWarnings, findColour, type BrandRules } from "../contracts/brand.js";
import { sanitiseFilename } from "../assets/ingest.js";
import { toAssetDto } from "../assets/dto.js";
import { writeStorageFile } from "../storage.js";
import { FontRejectedError, readFontInfo } from "./fonts.js";

export class BrandKitError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_rules" | "invalid_logo" | "invalid_font",
    message: string,
    public readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "BrandKitError";
  }
}

/** File format for importing a kit (see docs/brand/*.brand.json). */
export const brandKitFile = z.strictObject({
  name: z.string().trim().min(1).max(120),
  sourceNote: z.string().max(1000).optional(),
  rules: z.unknown(),
  /** Logo files, relative to the kit file (used by the import script). */
  logos: z
    .array(
      z.strictObject({
        file: z.string().min(1).max(300),
        name: z.string().trim().min(1).max(120),
        kind: z.enum(["primary", "partner"]).default("primary"),
        colourName: z.string().trim().max(60).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
});

export function parseRules(input: unknown): BrandRules {
  const parsed = brandRules.safeParse(input);
  if (!parsed.success) {
    throw new BrandKitError(
      "invalid_rules",
      "The brand rules are not valid.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function createBrandKit(db: Db, input: { name: string; rules: unknown; sourceNote?: string }) {
  const rules = parseRules(input.rules);
  const at = now();
  return db.brandKits.insert({ id: newId("kit"), name: input.name.trim(), rules, rulesSchema: BRAND_RULES_SCHEMA, revision: 1, sourceNote: input.sourceNote ?? null, createdAt: at, updatedAt: at });
}

export function updateBrandKit(db: Db, id: string, input: { name?: string; rules?: unknown; expectedRevision: number }) {
  const rules = input.rules === undefined ? undefined : parseRules(input.rules);
  const kit = db.brandKits.get(id);
  if (!kit) throw new BrandKitError("not_found", "Brand kit not found.");
  // Optimistic concurrency: refuse to overwrite edits made in another tab.
  if (kit.revision !== input.expectedRevision) throw new BrandKitError("invalid_rules", "This kit was changed elsewhere. Reload and apply your edit again.");
  return db.brandKits.update(id, {
    ...(input.name ? { name: input.name.trim() } : {}),
    ...(rules ? { rules } : {}),
    revision: kit.revision + 1,
    updatedAt: now(),
  });
}

export function attachLogo(db: Db, kitId: string, input: { assetId: string; kind: "primary" | "partner"; name: string; colourName?: string | null }) {
  const kit = db.brandKits.get(kitId);
  if (!kit) throw new BrandKitError("not_found", "Brand kit not found.");
  const asset = db.assets.get(input.assetId);
  if (!asset || asset.role !== "logo") throw new BrandKitError("invalid_logo", "Choose an uploaded logo asset.");

  let colourName: string | null = null;
  if (input.kind === "primary") {
    const rules = parseRules(kit.rules);
    const allowed = rules.logo.allowedColours.find((c) => c.toLowerCase() === input.colourName?.trim().toLowerCase());
    if (!allowed) {
      throw new BrandKitError("invalid_logo", `Primary logos must be one of the approved colours: ${rules.logo.allowedColours.join(", ")}.`);
    }
    colourName = allowed;
  }
  const existing = db.brandKitLogos.find((l) => l.brandKitId === kitId && l.assetId === asset.id);
  if (existing) return db.brandKitLogos.update(existing.id, { kind: input.kind, name: input.name.trim(), colourName });
  return db.brandKitLogos.insert({ id: newId("logo"), brandKitId: kitId, assetId: asset.id, kind: input.kind, name: input.name.trim(), colourName, createdAt: now() });
}

/** Detaches the logo from the kit; the asset itself stays in the library. */
export function detachLogo(db: Db, kitId: string, logoId: string) {
  const logo = db.brandKitLogos.get(logoId);
  if (!logo || logo.brandKitId !== kitId) throw new BrandKitError("not_found", "Logo not found in this kit.");
  db.brandKitLogos.remove(logoId);
}

export async function addFont(db: Db, storageDir: string, kitId: string, input: { buffer: Buffer; filename?: string; role: "display" | "text"; licenceConfirmed: boolean }) {
  const kit = db.brandKits.get(kitId);
  if (!kit) throw new BrandKitError("not_found", "Brand kit not found.");
  let info;
  try {
    info = readFontInfo(input.buffer);
  } catch (err) {
    if (err instanceof FontRejectedError) throw new BrandKitError("invalid_font", err.message);
    throw err;
  }
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const existing = db.brandFonts.find((f) => f.brandKitId === kitId && f.sha256 === sha256);
  if (existing) return db.brandFonts.update(existing.id, { role: input.role, licenceConfirmed: input.licenceConfirmed });
  const path = `fonts/${sha256.slice(0, 2)}/${sha256}.${info.format}`;
  await writeStorageFile(storageDir, path, input.buffer);
  return db.brandFonts.insert({
    id: newId("fnt"), brandKitId: kitId, role: input.role, family: info.family, weight: info.weight, style: info.style, format: info.format,
    sha256, bytes: input.buffer.length, path, sourceFilename: sanitiseFilename(input.filename), licenceConfirmed: input.licenceConfirmed, createdAt: now(),
  });
}

export function updateFont(db: Db, kitId: string, fontId: string, change: { licenceConfirmed?: boolean; role?: "display" | "text" }) {
  const font = db.brandFonts.get(fontId);
  if (!font || font.brandKitId !== kitId) throw new BrandKitError("not_found", "Font not found in this kit.");
  db.brandFonts.update(fontId, change);
}

export function removeFont(db: Db, kitId: string, fontId: string) {
  const font = db.brandFonts.get(fontId);
  if (!font || font.brandKitId !== kitId) throw new BrandKitError("not_found", "Font not found in this kit.");
  db.brandFonts.remove(fontId);
}

/**
 * Warnings that depend on uploaded files. Brand fonts are preferences, not
 * requirements: designs fall back to the bundled font library, so a missing
 * brand font is not a warning, but an uploaded font without a confirmed
 * licence is (it can't be used).
 */
function assetWarnings(rules: BrandRules, logos: BrandKitLogo[], fonts: BrandFont[]) {
  const out: { path: string; message: string }[] = [];
  const primary = logos.filter((l) => l.kind === "primary");
  if (primary.length === 0) out.push({ path: "logos", message: "No brand logo files uploaded yet." });
  for (const f of fonts) {
    if (!f.licenceConfirmed) {
      out.push({ path: `fonts.${f.role}`, message: `Licence not confirmed for ${f.family} ${f.weight}; it won't be used until confirmed.` });
    }
  }
  for (const l of primary) {
    if (l.colourName && !findColour(rules, l.colourName)?.hex) {
      out.push({ path: "logos", message: `Logo "${l.name}" uses ${l.colourName}, which has no confirmed colour value.` });
    }
  }
  return out;
}

export function toBrandKitDto(db: Db, kit: BrandKit): StudioBrandKit {
  const rules = parseRules(kit.rules);
  const logos = db.brandKitLogos.filter((l) => l.brandKitId === kit.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const fonts = db.brandFonts.filter((f) => f.brandKitId === kit.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    id: kit.id,
    name: kit.name,
    revision: kit.revision,
    sourceNote: kit.sourceNote,
    updatedAt: kit.updatedAt,
    rules: rules as unknown as StudioBrandKit["rules"],
    warnings: [...brandRuleWarnings(rules), ...assetWarnings(rules, logos, fonts)],
    logos: logos.flatMap((l) => {
      const asset = db.assets.get(l.assetId);
      return asset ? [{ id: l.id, kind: l.kind, name: l.name, colourName: l.colourName, asset: toAssetDto(asset) }] : [];
    }),
    fonts: fonts.map((f) => ({
      id: f.id,
      role: f.role,
      family: f.family,
      weight: f.weight,
      style: f.style,
      format: f.format,
      sourceFilename: f.sourceFilename,
      licenceConfirmed: f.licenceConfirmed,
    })),
  };
}

export type BrandKitDto = StudioBrandKit;
