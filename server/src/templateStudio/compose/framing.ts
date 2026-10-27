import type { Composition, ConceptPlan, StyleProfile } from "../contracts/ai.js";
import type { OutputFormat } from "./formats.js";

/**
 * Framing rules turn the template's measured composition into hard limits for
 * the product group on the final canvas. The planner is told the limits, and
 * `fitSubjects` enforces them in code afterwards, so oversized or edge-to-edge
 * product layouts never reach the image model.
 */

export interface FramingRules {
  source: "template" | "default";
  arrangement: Composition["arrangement"];
  staging: string;
  heroPlacement: string;
  overlap: Composition["overlap"];
  /** Limits for the box around all products, in normalised canvas units. */
  maxGroupWidth: number;
  maxGroupHeight: number;
  minTop: number;
  maxBottom: number;
  minSide: number;
  /** Whether products stand on visible supports (plinths, steps, rocks…). */
  supports: boolean;
  backdrop: BackdropRule | null;
}

/** How the template's backdrop shape relates to the product group, measured on the references. */
export interface BackdropRule {
  description: string;
  productRelation: string;
  textOnlyFeatures: string | null;
  /** Product group width ÷ backdrop width. */
  widthRatio: number;
  /** Product group height ÷ backdrop height. */
  heightRatio: number;
  /** Backdrop width ÷ height, in pixels. */
  aspectPx: number;
  /** (group centre x − backdrop centre x) ÷ backdrop width. */
  offsetX: number;
  /** (group bottom − backdrop bottom) ÷ backdrop height; positive means the products overhang its bottom edge. */
  bottomOffset: number;
}

export interface PlannedBackdrop {
  description: string;
  productRelation: string;
  textOnlyFeatures: string | null;
  region: Box;
}

/** Used for templates analysed before composition was measured. */
const DEFAULT_COMPOSITION: Composition = {
  arrangement: "side_by_side",
  staging: "Products grouped closely on believable supports at slightly different heights.",
  heroPlacement: "Hero in the centre, slightly larger or raised.",
  subjectGroupWidth: 0.55,
  subjectGroupHeight: 0.42,
  subjectGroupCenterX: 0.5,
  subjectGroupCenterY: 0.55,
  headroom: 0.3,
  footroom: 0.2,
  minEdgeMargin: 0.1,
  overlap: "slight",
  visibleSupports: true,
  backdrop: null,
};

/** Arrangements that imply visible supports, for profiles measured before visibleSupports existed. */
const SUPPORTED_ARRANGEMENTS = new Set(["stepped_levels", "side_by_side", "stacked", "single_hero"]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function profileComposition(profile: StyleProfile): Composition | null {
  return (profile as Partial<StyleProfile>).composition ?? null;
}

/**
 * @param refAspect average width/height of the style references, used to carry
 *   heights measured on (say) square references over to a portrait canvas.
 */
export function framingRules(profile: StyleProfile, format: Pick<OutputFormat, "width" | "height">, refAspect: number): FramingRules {
  const measured = profileComposition(profile);
  const c = measured ?? DEFAULT_COMPOSITION;
  const k = format.width / format.height / (refAspect > 0 ? refAspect : 1);
  const minTop = clamp(c.headroom * 0.85, 0.12, 0.5);
  const maxBottom = 1 - clamp(c.footroom * 0.85, 0.06, 0.4);
  const minSide = clamp(c.minEdgeMargin, 0.05, 0.2);
  return {
    source: measured ? "template" : "default",
    arrangement: c.arrangement,
    staging: c.staging,
    heroPlacement: c.heroPlacement,
    overlap: c.overlap,
    maxGroupWidth: r3(Math.min(clamp(c.subjectGroupWidth * 1.1, 0.25, 0.8), 1 - 2 * minSide)),
    maxGroupHeight: r3(Math.min(clamp(c.subjectGroupHeight * k * 1.1, 0.2, 0.75), maxBottom - minTop)),
    minTop: r3(minTop),
    maxBottom: r3(maxBottom),
    minSide: r3(minSide),
    supports: c.visibleSupports ?? SUPPORTED_ARRANGEMENTS.has(c.arrangement),
    backdrop: backdropRule(c, refAspect),
  };
}

function backdropRule(c: Composition, refAspect: number): BackdropRule | null {
  const b = c.backdrop;
  if (!b || b.width < 0.05 || b.height < 0.05) return null;
  const groupBottom = c.subjectGroupCenterY + c.subjectGroupHeight / 2;
  return {
    description: b.description,
    productRelation: b.productRelation,
    textOnlyFeatures: b.textOnlyFeatures,
    widthRatio: r3(clamp(c.subjectGroupWidth / b.width, 0.2, 1.5)),
    heightRatio: r3(clamp(c.subjectGroupHeight / b.height, 0.2, 1.5)),
    aspectPx: r3((b.width / b.height) * (refAspect > 0 ? refAspect : 1)),
    offsetX: r3(clamp((c.subjectGroupCenterX - (b.x + b.width / 2)) / b.width, -0.5, 0.5)),
    bottomOffset: r3(clamp((groupBottom - (b.y + b.height)) / b.height, -0.5, 0.5)),
  };
}

/**
 * Size and place the backdrop from the (already fitted) product group so the
 * product-to-backdrop ratio matches the template. The image model is free to
 * invent a backdrop's size otherwise, which leaves products lost in a huge panel.
 */
export function planBackdrop(plan: ConceptPlan, rules: FramingRules, canvas: { width: number; height: number }): PlannedBackdrop | null {
  if (!rules.backdrop || !plan.subjects.length) return null;
  return backdropFor(unionBox(plan.subjects.map((s) => s.region)), rules, canvas);
}

/** The backdrop box for a product group box, at the template's product-to-backdrop ratio. */
export function backdropFor(g: Box, rules: FramingRules, canvas: { width: number; height: number }): PlannedBackdrop | null {
  const b = rules.backdrop;
  if (!b) return null;
  // Size by whichever dimension needs more room, so a tall single product (a phone) or a
  // wide group (speakers) both sit in the backdrop as the template's products do.
  const byWidth = g.width / b.widthRatio;
  const byHeight = ((g.height / b.heightRatio) * canvas.height * b.aspectPx) / canvas.width;
  let width = Math.min(0.96, Math.max(byWidth, byHeight));
  let height = (width * canvas.width) / b.aspectPx / canvas.height;
  if (height > 0.9) {
    width *= 0.9 / height;
    height = 0.9;
  }
  const cx = g.x + g.width / 2 - b.offsetX * width;
  const bottom = g.y + g.height - b.bottomOffset * height;
  const x = clamp(cx - width / 2, 0.02, 0.98 - width);
  const y = clamp(bottom - height, 0.02, 0.98 - height);
  return { description: b.description, productRelation: b.productRelation, textOnlyFeatures: b.textOnlyFeatures, region: { x: r3(x), y: r3(y), width: r3(width), height: r3(height) } };
}

/** Data given to the planner so its first answer already fits. */
export function framingBrief(rules: FramingRules) {
  return {
    visibleSupports: rules.supports,
    backdrop: rules.backdrop
      ? {
          description: rules.backdrop.description,
          productRelation: rules.backdrop.productRelation,
          productGroupWidthToBackdropWidth: rules.backdrop.widthRatio,
          textOnlyFeatures: rules.backdrop.textOnlyFeatures,
        }
      : null,
    arrangement: rules.arrangement,
    staging: rules.staging,
    heroPlacement: rules.heroPlacement,
    overlap: rules.overlap,
    productGroupBox: {
      maxWidth: rules.maxGroupWidth,
      maxHeight: rules.maxGroupHeight,
      topAtLeast: rules.minTop,
      bottomAtMost: rules.maxBottom,
      sideMarginAtLeast: rules.minSide,
    },
    note: "The product group box is the union of all subject regions (products only, not their supports). Values are fractions of the final canvas.",
  };
}

type Box = { x: number; y: number; width: number; height: number };

export function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function overlapArea(a: Box, b: Box) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Scale and move the product group (keeping the planner's relative layout) so
 * it fits the framing rules. Never enlarges the group.
 */
export function fitSubjects(plan: ConceptPlan, rules: FramingRules): { plan: ConceptPlan; notes: string[] } {
  if (!plan.subjects.length) return { plan, notes: [] };
  const notes: string[] = [];
  const g = unionBox(plan.subjects.map((s) => s.region));
  const s = Math.min(1, rules.maxGroupWidth / g.width, rules.maxGroupHeight / g.height);
  const w = g.width * s;
  const h = g.height * s;
  const cx = clamp(g.x + g.width / 2, rules.minSide + w / 2, 1 - rules.minSide - w / 2);
  const top = clamp(g.y + g.height / 2 - h / 2, rules.minTop, rules.maxBottom - h);
  const left = cx - w / 2;

  if (s < 0.999) {
    notes.push(
      `Product group scaled to ${Math.round(s * 100)}% (planned ${Math.round(g.width * 100)}%×${Math.round(g.height * 100)}% of the canvas; template allows up to ${Math.round(rules.maxGroupWidth * 100)}%×${Math.round(rules.maxGroupHeight * 100)}%).`,
    );
  }
  if (Math.abs(left - g.x) > 0.005 || Math.abs(top - g.y) > 0.005) {
    notes.push(`Product group moved to keep ${Math.round(rules.minTop * 100)}% headroom, ${Math.round((1 - rules.maxBottom) * 100)}% room below and ${Math.round(rules.minSide * 100)}% side margins.`);
  }

  const subjects = plan.subjects.map((sub) => ({
    ...sub,
    region: {
      x: r3(left + (sub.region.x - g.x) * s),
      y: r3(top + (sub.region.y - g.y) * s),
      width: r3(sub.region.width * s),
      height: r3(sub.region.height * s),
    },
  }));

  for (const t of plan.texts) {
    const hit = subjects.find((sub) => overlapArea(t, sub.region) > 0.15 * t.width * t.height);
    if (hit) notes.push(`The ${t.field} text area overlaps a product; check the poster and move the text in the editor if needed.`);
  }
  return { plan: { ...plan, subjects }, notes };
}

/**
 * Reshape each subject region to the product's real proportions (contained in
 * the planned box, bottom-anchored because products stand on something).
 * Image models keep a product's true shape, so a tall box for a wide product
 * comes out wider than planned and pushes the group towards the edges.
 *
 * @param aspects product width/height in pixels, keyed by subjectId
 */
export function matchSubjectAspects(
  plan: ConceptPlan,
  aspects: Record<string, number>,
  canvas: { width: number; height: number },
): ConceptPlan {
  return {
    ...plan,
    subjects: plan.subjects.map((s) => {
      const a = aspects[s.subjectId];
      if (!(a > 0)) return s;
      const boxAspect = (s.region.width * canvas.width) / (s.region.height * canvas.height);
      let { width, height } = s.region;
      if (a > boxAspect) height = (width * canvas.width) / a / canvas.height;
      else width = (height * canvas.height * a) / canvas.width;
      const x = s.region.x + (s.region.width - width) / 2;
      const y = s.region.y + s.region.height - height;
      return { ...s, region: { x: r3(x), y: r3(y), width: r3(width), height: r3(height) } };
    }),
  };
}
