import sharp from "sharp";
import type { ConceptPlan } from "../contracts/ai.js";
import type { FramingRules, PlannedBackdrop } from "./framing.js";

/**
 * A wordless wireframe sent to the image model next to the references: one
 * coloured block per product at its planned size, grey supports under them
 * when the template stages products on something, and white dashed areas that
 * must stay empty for text and the logo. Image models follow a picture of the
 * layout far more reliably than coordinates in the prompt. It deliberately
 * contains no letters, so nothing in it can leak into the scene as text.
 */

export const GUIDE_COLOURS = [
  { name: "orange", hex: "#f28c28" },
  { name: "teal", hex: "#1fa79a" },
  { name: "purple", hex: "#8a4fd6" },
  { name: "yellow", hex: "#f2c81f" },
  { name: "pink", hex: "#e0508f" },
  { name: "green", hex: "#4caf50" },
] as const;

/** Fill for the backdrop shape; named in the image prompt. */
export const BACKDROP_GUIDE = { name: "pale blue", hex: "#a9cdf0" };

export function guideColour(i: number) {
  return GUIDE_COLOURS[i % GUIDE_COLOURS.length];
}

export interface GuideInput {
  plan: ConceptPlan;
  rules: FramingRules;
  /** Text fields that will actually be placed. */
  textFields: string[];
  logoWidthPct: number;
  /** Backdrop box in the same coordinates as the plan (normalised to this image). */
  backdrop?: PlannedBackdrop | null;
  width: number;
  height: number;
}

export function guideHasSupports(rules: FramingRules) {
  return rules.supports;
}

export function layoutGuideSvg({ plan, rules, textFields, logoWidthPct, backdrop, width: W, height: H }: GuideInput): string {
  const px = (b: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(b.x * W),
    y: Math.round(b.y * H),
    w: Math.max(1, Math.round(b.width * W)),
    h: Math.max(1, Math.round(b.height * H)),
  });
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#d6d9de"/>`];
  if (backdrop) {
    const r = px(backdrop.region);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${Math.round(Math.min(r.w, r.h) * 0.08)}" fill="${BACKDROP_GUIDE.hex}"/>`);
  }

  // Empty zones for copy and logo first, so products drawn later stay on top if they touch.
  const dash = Math.max(4, Math.round(W / 120));
  const stroke = Math.max(2, Math.round(W / 300));
  for (const t of plan.texts.filter((t) => textFields.includes(t.field))) {
    const r = px(t);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#ffffff" fill-opacity="0.85" stroke="#8a9099" stroke-width="${stroke}" stroke-dasharray="${dash} ${dash}"/>`);
  }
  const lw = Math.round((logoWidthPct / 100) * W);
  const lh = Math.round(lw * 0.4);
  const margin = Math.round(W * 0.05);
  const lx = plan.logo.corner.endsWith("left") ? margin : W - margin - lw;
  const ly = plan.logo.corner.startsWith("top") ? margin : H - margin - lh;
  parts.push(`<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" fill="#ffffff" fill-opacity="0.85" stroke="#8a9099" stroke-width="${stroke}" stroke-dasharray="${dash} ${dash}"/>`);

  if (plan.subjects.length && guideHasSupports(rules)) {
    // One floor line under the whole group; each product gets a support block down to it,
    // so a raised hero automatically gets a taller plinth (stepped staging).
    const lowest = Math.max(...plan.subjects.map((s) => s.region.y + s.region.height));
    const floor = Math.min(0.97, lowest + Math.max(0.05, (1 - lowest) * 0.45));
    for (const s of plan.subjects) {
      const bottom = s.region.y + s.region.height;
      const grow = s.region.width * 0.12;
      const r = px({ x: s.region.x - grow, y: bottom, width: s.region.width + 2 * grow, height: Math.max(0.02, floor - bottom) });
      parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#9aa1ab"/>`);
    }
  }

  plan.subjects.forEach((s, i) => {
    const r = px(s.region);
    const rad = Math.round(Math.min(r.w, r.h) * 0.08);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rad}" fill="${guideColour(i).hex}" stroke="#2b2f36" stroke-width="${stroke}"/>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export async function renderLayoutGuide(input: GuideInput): Promise<Buffer> {
  return sharp(Buffer.from(layoutGuideSvg(input))).png().toBuffer();
}
