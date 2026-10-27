import { z } from "zod";

/**
 * The editable layer of a poster: exact campaign copy and logos placed over
 * the generated scene. Coordinates are normalised to the final canvas. The
 * same document drives the preview, the exported file and the native text and
 * logo elements restored in FrameFlow's editor after decomposition. Image layers
 * come only from FrameFlow's own decomposition, never from this document.
 */

export const OVERLAY_SCHEMA = "overlay/1";

export const COPY_FIELDS = [
  { id: "headline", label: "Headline", role: "display" },
  { id: "subheadline", label: "Subheadline", role: "text" },
  { id: "offer", label: "Offer / price", role: "display" },
  { id: "body", label: "Body text", role: "text" },
  { id: "cta", label: "Call to action", role: "text" },
  { id: "date", label: "Date / validity", role: "text" },
  { id: "footer", label: "Footer / disclaimer", role: "text" },
] as const;
export type CopyFieldId = (typeof COPY_FIELDS)[number]["id"];
export const COPY_FIELD_IDS = COPY_FIELDS.map((f) => f.id) as [CopyFieldId, ...CopyFieldId[]];

export const copySchema = z
  .object(Object.fromEntries(COPY_FIELDS.map((f) => [f.id, z.string().trim().max(f.id === "footer" || f.id === "body" ? 1200 : 300).optional()])) as Record<CopyFieldId, z.ZodOptional<z.ZodString>>)
  .strict();
export type CampaignCopy = z.infer<typeof copySchema>;

const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1a2b3c");

export const boxSchema = z
  .object({ x: unit, y: unit, width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
  .refine((b) => b.x + b.width <= 1.0001 && b.y + b.height <= 1.0001, "Box must stay inside the canvas");

export const textElementSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.literal("text"),
  field: z.enum(COPY_FIELD_IDS),
  text: z.string().max(1200),
  box: boxSchema,
  align: z.enum(["left", "center", "right"]),
  verticalAlign: z.enum(["top", "middle", "bottom"]),
  fontFamily: z.string().min(1).max(80),
  fontWeight: z.number().int().min(100).max(900),
  fontSizePct: z.number().min(0.5).max(30),
  minFontSizePct: z.number().min(0.5).max(30),
  lineHeight: z.number().min(0.7).max(2.5),
  uppercase: z.boolean(),
  color: hex,
  plate: z.object({ color: hex, opacity: unit, paddingPct: z.number().min(0).max(6), radiusPct: z.number().min(0).max(6) }).nullable(),
  hidden: z.boolean(),
});
export type TextElement = z.infer<typeof textElementSchema>;

export const LOGO_CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;

export const logoElementSchema = z.object({
  corner: z.enum(LOGO_CORNERS),
  widthPct: z.number().min(5).max(40),
  /** "auto" picks the approved colour version with the best contrast; otherwise a brand-kit logo id. */
  variant: z.string().min(1).max(40),
  partnerLogoIds: z.array(z.string().min(1).max(40)).max(3),
  hidden: z.boolean(),
});
export type LogoElement = z.infer<typeof logoElementSchema>;

export const overlayDocSchema = z.object({
  schema: z.literal(OVERLAY_SCHEMA),
  formatId: z.string(),
  canvas: z.object({ width: z.number().int().min(64).max(8000), height: z.number().int().min(64).max(8000) }),
  sceneAssetId: z.string(),
  crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }),
  brandKitId: z.string().nullable(),
  texts: z.array(textElementSchema).max(12),
  logo: logoElementSchema.nullable(),
  /** Notes from automatic adjustments, shown to the user. */
  notes: z.array(z.string().max(300)).max(20),
});
export type OverlayDoc = z.infer<typeof overlayDocSchema>;

export interface LayoutIssue {
  severity: "info" | "warning" | "error";
  elementId: string | null;
  message: string;
}

export interface LayoutReport {
  texts: { id: string; fontSizePx: number; lines: string[]; overflow: boolean; contrast: number | null }[];
  logo: { variantId: string | null; widthPx: number; contrast: number | null; box: { x: number; y: number; width: number; height: number } } | null;
  issues: LayoutIssue[];
}
