import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Default import: under Node's ESM loader opentype.js resolves to its CommonJS build, which has no named exports.
import opentype, { type Font } from "opentype.js";
import type { StudioStore } from "../store.js";
import { resolveStoragePath } from "../storage.js";
import { FONT_CATALOG, type FontUse } from "./catalog.js";

/**
 * Fonts available to the art director and compositor: the catalogue of
 * open-licensed fonts (see ./catalog.ts, the list the AI chooses from), plus brand fonts uploaded to
 * a kit whose licence the user confirmed. Text is rendered as vector outlines
 * from these exact files, so preview and export always match.
 */

export interface FontFace {
  family: string;
  weight: number;
  style: "normal" | "italic";
  source: "bundled" | "brand";
  file: string;
}

export interface FontFamilyInfo {
  family: string;
  category: string;
  description: string;
  weights: number[];
  bestFor: FontUse[];
  source: "bundled" | "brand";
}

/** server/assets/template-studio/fonts, from src (development) and dist (build) alike. */
export const BUNDLED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/template-studio/fonts");

/** Used for any character the chosen font lacks (e.g. ₹). */
export const FALLBACK_FAMILY = "Poppins";

export async function listFonts(db: StudioStore, brandKitId?: string | null): Promise<{ families: FontFamilyInfo[]; faces: FontFace[] }> {
  const faces: FontFace[] = [];
  const families: FontFamilyInfo[] = [];

  if (brandKitId) {
    const brandFonts = db.brandFonts.filter((f) => f.brandKitId === brandKitId && f.licenceConfirmed);
    const byFamily = new Map<string, typeof brandFonts>();
    for (const f of brandFonts) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
    for (const [family, list] of byFamily) {
      families.push({
        family,
        category: list[0].role === "display" ? "brand display" : "brand text",
        description: `Brand font (${list[0].role === "display" ? "headlines" : "body text"}); prefer it where it suits the design.`,
        weights: [...new Set(list.map((f) => f.weight))].sort((a, b) => a - b),
        bestFor: list[0].role === "display" ? ["headline", "offer"] : ["subheadline", "body"],
        source: "brand",
      });
      for (const f of list) faces.push({ family, weight: f.weight, style: f.style as FontFace["style"], source: "brand", file: f.path });
    }
  }

  for (const b of FONT_CATALOG) {
    if (families.some((f) => f.family.toLowerCase() === b.family.toLowerCase())) continue;
    families.push({ family: b.family, category: b.category, description: b.description, weights: b.faces.map(([w]) => w), bestFor: b.bestFor, source: "bundled" });
    for (const [weight, file] of b.faces) faces.push({ family: b.family, weight, style: "normal", source: "bundled", file });
  }
  return { families, faces };
}

const fontCache = new Map<string, Font>();

export function loadFace(face: FontFace, storageDir: string): Font {
  const abs = face.source === "bundled" ? path.join(BUNDLED_DIR, face.file) : resolveStoragePath(storageDir, face.file);
  let font = fontCache.get(abs);
  if (!font) {
    const buf = readFileSync(abs);
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    fontCache.set(abs, font);
  }
  return font;
}

/** Closest available weight for a family; falls back to the fallback family. */
export function pickFace(faces: FontFace[], family: string, weight: number): FontFace {
  const candidates = faces.filter((f) => f.family.toLowerCase() === family.toLowerCase() && f.style === "normal");
  const pool = candidates.length ? candidates : faces.filter((f) => f.family === FALLBACK_FAMILY);
  return pool.reduce((best, f) => (Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best));
}
