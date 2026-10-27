import type { ConceptPlan } from "../contracts/ai.js";
import type { BrandRules } from "../contracts/brand.js";
import { hexToRgb } from "./colour.js";
import type { OutputFormat } from "./formats.js";
import { COPY_FIELDS, OVERLAY_SCHEMA, type CampaignCopy, type CopyFieldId, type OverlayDoc, type TextElement } from "./overlay.js";
import { readableColour, regionStats } from "./render.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Minimum legible sizes as % of canvas height. */
const MIN_SIZE_PCT: Record<CopyFieldId, number> = {
  headline: 2.6,
  offer: 2.2,
  subheadline: 1.6,
  body: 1.35,
  cta: 1.5,
  date: 1.2,
  footer: 1.05,
};

/** Used when the plan omits a field (reported to the user). */
function fallbackRegion(_field: CopyFieldId, index: number) {
  return { x: 0.06, y: clamp(0.72 + index * 0.06, 0, 0.92), width: 0.88, height: 0.06 };
}

export function presentFields(copy: CampaignCopy): CopyFieldId[] {
  return COPY_FIELDS.map((f) => f.id).filter((id) => (copy[id] ?? "").trim().length > 0);
}

export interface BuildOverlayInput {
  plan: ConceptPlan;
  copy: CampaignCopy;
  format: OutputFormat;
  crop: OverlayDoc["crop"];
  sceneAssetId: string;
  sceneRaw: Buffer; // canvas-sized RGB
  fontFamilies: string[];
  rules: BrandRules | null;
  brandKitId: string | null;
  partnerLogoIds: string[];
}

/**
 * Build the initial overlay. Text always comes from the campaign copy, never
 * from the model. Planned positions and styles are kept where valid; colours
 * are adjusted only when contrast against the generated scene is too low, and
 * every adjustment is noted.
 */
export function buildOverlay(input: BuildOverlayInput): OverlayDoc {
  const { plan, copy, format, rules } = input;
  const W = format.width;
  const H = format.height;
  const notes: string[] = [];
  const brandColours = rules
    ? [...rules.palette.core, ...rules.palette.accent].map((c) => c.hex).filter((h): h is string => Boolean(h))
    : [];

  const texts: TextElement[] = presentFields(copy).map((field, i) => {
    const planned = plan.texts.find((t) => t.field === field);
    if (!planned) notes.push(`The layout plan had no area for "${field}"; it was placed in a default position.`);
    const role = COPY_FIELDS.find((f) => f.id === field)!.role;
    const region = planned ?? { ...fallbackRegion(field, i) };
    const x = clamp(region.x, 0, 0.98);
    const y = clamp(region.y, 0, 0.98);
    const box = { x, y, width: clamp(region.width, 0.02, 1 - x), height: clamp(region.height, 0.02, 1 - y) };
    const family = planned && input.fontFamilies.includes(planned.fontFamily) ? planned.fontFamily : "Poppins";
    const sizePct = clamp(planned?.fontSizePct ?? (role === "display" ? 6 : 2.2), MIN_SIZE_PCT[field], 25);
    let color = planned && HEX.test(planned.color) ? planned.color.toLowerCase() : "#111111";
    const plate =
      planned?.plate && HEX.test(planned.plate.color)
        ? { color: planned.plate.color.toLowerCase(), opacity: clamp(planned.plate.opacity, 0, 1), paddingPct: clamp(planned.plate.paddingPct, 0, 6), radiusPct: clamp(planned.plate.radiusPct, 0, 6) }
        : null;

    if (!plate) {
      const bg = regionStats(input.sceneRaw, W, H, { x: box.x * W, y: box.y * H, width: box.width * W, height: box.height * H }).mean;
      const fixed = readableColour(color, bg, sizePct >= 3, brandColours);
      if (fixed.changed) {
        notes.push(`"${field}" colour changed from ${color} to ${fixed.color} for legibility against the generated background.`);
        color = fixed.color;
      }
    }

    return {
      id: field,
      kind: "text",
      field,
      text: copy[field]!.trim(),
      box,
      align: planned?.align ?? "left",
      verticalAlign: planned?.verticalAlign ?? "top",
      fontFamily: family,
      fontWeight: Math.round(clamp(planned?.fontWeight ?? (role === "display" ? 700 : 400), 100, 900) / 100) * 100,
      fontSizePct: sizePct,
      minFontSizePct: MIN_SIZE_PCT[field],
      lineHeight: clamp(planned?.lineHeight ?? 1.15, 0.8, 2),
      uppercase: planned?.uppercase ?? false,
      color,
      plate,
      hidden: false,
    };
  });

  type Corner = NonNullable<OverlayDoc["logo"]>["corner"];
  const allowed: Corner[] = rules?.logo.allowedCorners ?? ["top_left", "top_right"];
  const corner: Corner = allowed.includes(plan.logo.corner as Corner) ? (plan.logo.corner as Corner) : allowed[0];
  if (corner !== plan.logo.corner) notes.push(`Logo moved to the ${corner.replace("_", "-")} corner to follow the brand rules.`);

  return {
    schema: OVERLAY_SCHEMA,
    formatId: format.id,
    canvas: { width: W, height: H },
    sceneAssetId: input.sceneAssetId,
    crop: input.crop,
    brandKitId: input.brandKitId,
    texts,
    logo: input.brandKitId ? { corner, widthPct: clamp(plan.logo.widthPct, 8, 35), variant: "auto", partnerLogoIds: input.partnerLogoIds, hidden: false } : null,
    notes,
  };
}

/** Background colour hint for UI swatches. */
export function swatches(rules: BrandRules | null) {
  if (!rules) return ["#ffffff", "#111111"];
  const list = [...rules.palette.core, ...rules.palette.accent].map((c) => c.hex).filter((h): h is string => Boolean(h));
  return [...new Set([...list, "#ffffff", "#111111"])].filter((h) => hexToRgb(h).every((v) => !Number.isNaN(v)));
}
