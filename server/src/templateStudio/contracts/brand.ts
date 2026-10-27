import { z } from "zod";

/**
 * Brand rules supplied by the user (typically transcribed from a brand
 * guideline). Pure data: no brand is hardcoded in application code.
 *
 * Deterministic rules (logo placement, clear space, minimum size, allowed logo
 * colours, fonts) are enforced by the compositor. Palette, aesthetic, and
 * latitude are passed to the planner/reviewer as guidance.
 */

export const BRAND_RULES_SCHEMA = "brand-rules/1";

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour like #1a2b3c")
  .transform((v) => v.toLowerCase());

/** Where a value came from; anything not "stated" or "user" deserves a human check. */
export const provenance = z.enum(["stated", "measured", "inferred", "user"]);

export const brandColour = z.strictObject({
  name: z.string().trim().min(1).max(60),
  /** null when the guideline names a colour without giving its value. */
  hex: hex.nullable(),
  cmyk: z.string().max(40).nullable().optional(),
  confirmed: z.boolean(),
  note: z.string().max(400).optional(),
});
export type BrandColour = z.infer<typeof brandColour>;

export const LOGO_CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;

export const LOGO_PROHIBITIONS = [
  "shadow",
  "tilt",
  "stretch",
  "squeeze",
  "outline",
  "patch_behind_logo",
  "same_tone_background",
  "low_contrast_background",
  "recolour_outside_allowed",
] as const;

export const brandRules = z.strictObject({
  schema: z.literal(BRAND_RULES_SCHEMA),
  palette: z.strictObject({
    core: z.array(brandColour).min(1).max(12),
    accent: z.array(brandColour).max(24),
    extended: z.array(brandColour).max(60),
    neutrals: z.array(brandColour).max(60),
    /** Human-readable pairing/usage rules, passed to the planner verbatim. */
    rules: z.array(z.string().trim().min(1).max(400)).max(20),
  }),
  logo: z.strictObject({
    allowedCorners: z.array(z.enum(LOGO_CORNERS)).min(1),
    /** Names of colours the logo may appear in (resolved against the palette). */
    allowedColours: z.array(z.string().trim().min(1).max(60)).min(1),
    clearSpace: z.strictObject({
      unitDefinition: z.string().max(400),
      /** Clear space on every side, in units of X. */
      multiple: z.number().min(0).max(10),
      /** X as a fraction of the trimmed logo height/width; null until measured. */
      unitRatioOfLogoHeight: z.number().gt(0).lt(2).nullable(),
      unitRatioOfLogoWidth: z.number().gt(0).lt(2).nullable(),
      provenance,
      confirmed: z.boolean(),
      note: z.string().max(400).optional(),
    }),
    partnerLockup: z
      .strictObject({
        /** Gap between brand logo and partner logo, in units of X. */
        gapUnits: z.number().min(0).max(10),
        /** Symbol centred in the gap, or null for none. */
        separator: z.string().max(4).nullable(),
        equalVisualWeight: z.boolean(),
      })
      .nullable(),
    subBrandLockup: z
      .strictObject({
        unitDefinition: z.string().max(400),
        nameHeightUnits: z.number().gt(0).max(10),
        gapUnits: z.number().min(0).max(10),
      })
      .nullable(),
    minWidth: z.strictObject({
      digitalPx: z.number().int().min(1).max(4000),
      printMm: z.number().gt(0).max(1000).nullable(),
    }),
    prohibited: z.array(z.enum(LOGO_PROHIBITIONS)),
    /** The area behind the logo must be clean and uncluttered. */
    requireCleanBackground: z.boolean(),
  }),
  typography: z.strictObject({
    display: z.strictObject({ family: z.string().trim().min(1).max(80), usage: z.string().max(300) }),
    text: z.strictObject({ family: z.string().trim().min(1).max(80), usage: z.string().max(300) }),
    notes: z.array(z.string().max(400)).max(10),
  }),
  aesthetic: z.strictObject({
    summary: z.string().trim().min(1).max(600),
    principles: z
      .array(z.strictObject({ name: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(400) }))
      .max(10),
    keywords: z.array(z.string().trim().min(1).max(40)).max(20),
    /** How strictly non-logo guidance should be followed. */
    latitude: z.string().max(600),
  }),
  openQuestions: z.array(z.string().trim().min(1).max(400)).max(30),
  source: z
    .strictObject({
      document: z.string().max(300),
      description: z.string().max(600).optional(),
      missingSections: z.array(z.string().max(100)).max(20).optional(),
    })
    .optional(),
});
export type BrandRules = z.infer<typeof brandRules>;

export interface BrandRuleWarning {
  path: string;
  message: string;
}

export function allColours(rules: BrandRules): BrandColour[] {
  const { core, accent, extended, neutrals } = rules.palette;
  return [...core, ...accent, ...extended, ...neutrals];
}

/** Find a palette colour by name, case-insensitively. */
export function findColour(rules: BrandRules, name: string): BrandColour | undefined {
  const n = name.trim().toLowerCase();
  return allColours(rules).find((c) => c.name.toLowerCase() === n);
}

/**
 * Things a human should resolve before the kit is relied on. These never block
 * saving: guidelines are often incomplete, and the UI shows them prominently.
 */
export function brandRuleWarnings(rules: BrandRules): BrandRuleWarning[] {
  const out: BrandRuleWarning[] = [];
  (["core", "accent", "extended", "neutrals"] as const).forEach((group) =>
    rules.palette[group].forEach((c, i) => {
      if (c.hex === null) out.push({ path: `palette.${group}.${i}`, message: `${c.name}: colour value missing.` });
      else if (!c.confirmed) out.push({ path: `palette.${group}.${i}`, message: `${c.name}: ${c.hex} is unconfirmed.` });
    }),
  );
  for (const name of rules.logo.allowedColours) {
    const c = findColour(rules, name);
    if (!c) out.push({ path: "logo.allowedColours", message: `Logo colour "${name}" is not defined in the palette.` });
  }
  const cs = rules.logo.clearSpace;
  if (cs.unitRatioOfLogoHeight === null && cs.unitRatioOfLogoWidth === null) {
    out.push({ path: "logo.clearSpace", message: "Clear-space unit X has not been measured." });
  } else if (!cs.confirmed) {
    out.push({ path: "logo.clearSpace", message: `Clear-space unit X is ${cs.provenance}, not confirmed.` });
  }
  return out;
}
