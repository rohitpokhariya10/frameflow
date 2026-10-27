import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ConceptPlan, StyleProfile } from "./contracts/ai.js";
import { estimateImageCall } from "./costs/estimate.js";
import { FORMATS, getFormat, sceneCrop } from "./compose/formats.js";
import { fitSubjects, framingRules, unionBox } from "./compose/framing.js";
import { layoutGuideSvg, renderLayoutGuide } from "./compose/layoutGuide.js";

const composition = {
  arrangement: "stepped_levels" as const,
  staging: "Plinths of different heights.",
  heroPlacement: "Raised at the back.",
  subjectGroupWidth: 0.5,
  subjectGroupHeight: 0.4,
  subjectGroupCenterX: 0.5,
  subjectGroupCenterY: 0.55,
  headroom: 0.3,
  footroom: 0.2,
  minEdgeMargin: 0.1,
  overlap: "slight" as const,
};
const profile = { composition } as unknown as StyleProfile;
const legacyProfile = {} as unknown as StyleProfile;
const portrait = getFormat("portrait-4-5")!;

function planWith(regions: { x: number; y: number; width: number; height: number }[], texts: Partial<ConceptPlan["texts"][number]>[] = []): ConceptPlan {
  return {
    subjects: regions.map((region, i) => ({ subjectId: `s${i + 1}`, placement: "", region, prominence: "hero", scaleBasis: "", support: "" })),
    texts: texts.map((t) => ({ field: "headline", x: 0.08, y: 0.06, width: 0.6, height: 0.12, ...t })),
    logo: { corner: "top_right", widthPct: 12 },
  } as unknown as ConceptPlan;
}

describe("framing rules", () => {
  it("derive limits from the template's measured composition", () => {
    const r = framingRules(profile, portrait, 1);
    expect(r.source).toBe("template");
    expect(r.maxGroupWidth).toBeCloseTo(0.55, 3);
    // Square references on a 4:5 canvas: the same product size is a smaller share of the taller canvas.
    expect(r.maxGroupHeight).toBeCloseTo(0.4 * 0.8 * 1.1, 3);
    expect(r.minSide).toBe(0.1);
    expect(r.minTop).toBeCloseTo(0.255, 3);
    expect(r.maxBottom).toBeCloseTo(0.83, 3);
  });

  it("fall back to sensible defaults for templates analysed before framing existed", () => {
    const r = framingRules(legacyProfile, portrait, 1);
    expect(r.source).toBe("default");
    expect(r.maxGroupWidth).toBeLessThanOrEqual(0.65);
  });
});

describe("fitting the product group", () => {
  const rules = framingRules(profile, portrait, 1);

  it("shrinks an edge-to-edge layout into the template's frame, keeping relative positions", () => {
    // The real failing plan: two machines spanning 7%–91% of the width.
    const plan = planWith([
      { x: 0.52, y: 0.37, width: 0.39, height: 0.48 },
      { x: 0.07, y: 0.43, width: 0.45, height: 0.43 },
    ]);
    const { plan: fitted, notes } = fitSubjects(plan, rules);
    const g = unionBox(fitted.subjects.map((s) => s.region));
    expect(g.width).toBeLessThanOrEqual(rules.maxGroupWidth + 0.002);
    expect(g.height).toBeLessThanOrEqual(rules.maxGroupHeight + 0.002);
    expect(g.x).toBeGreaterThanOrEqual(rules.minSide - 0.002);
    expect(g.x + g.width).toBeLessThanOrEqual(1 - rules.minSide + 0.002);
    expect(g.y).toBeGreaterThanOrEqual(rules.minTop - 0.002);
    expect(g.y + g.height).toBeLessThanOrEqual(rules.maxBottom + 0.002);
    // Left product stays left of the right one.
    expect(fitted.subjects[1].region.x).toBeLessThan(fitted.subjects[0].region.x);
    expect(notes.some((n) => n.includes("scaled"))).toBe(true);
  });

  it("never enlarges a layout that already fits", () => {
    const plan = planWith([{ x: 0.4, y: 0.4, width: 0.2, height: 0.25 }]);
    const { plan: fitted, notes } = fitSubjects(plan, rules);
    expect(fitted.subjects[0].region).toEqual(plan.subjects[0].region);
    expect(notes).toEqual([]);
  });

  it("warns when a text area ends up on top of a product", () => {
    const plan = planWith([{ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }], [{ x: 0.3, y: 0.35, width: 0.4, height: 0.1 }]);
    expect(fitSubjects(plan, rules).notes.some((n) => n.includes("overlaps"))).toBe(true);
  });
});

describe("layout guide", () => {
  const rules = framingRules(profile, portrait, 1);
  const plan = planWith(
    [
      { x: 0.4, y: 0.3, width: 0.2, height: 0.3 },
      { x: 0.25, y: 0.45, width: 0.15, height: 0.25 },
    ],
    [{ x: 0.08, y: 0.06, width: 0.6, height: 0.12 }],
  );

  it("contains no text, so nothing in it can leak into the scene as lettering", () => {
    const svg = layoutGuideSvg({ plan, rules, textFields: ["headline"], logoWidthPct: 12, width: 512, height: 640 });
    expect(svg).not.toMatch(/<text|<tspan/);
    // One block per product, one support per product (stepped staging), text and logo zones.
    expect(svg.match(/<rect/g)!.length).toBe(1 + 2 + 2 + 2);
  });

  it("gives a raised hero a taller support than the product in front", () => {
    const svg = layoutGuideSvg({ plan, rules, textFields: [], logoWidthPct: 12, width: 1000, height: 1000 });
    const supports = [...svg.matchAll(/<rect x="\d+" y="(\d+)" width="\d+" height="(\d+)" fill="#9aa1ab"\/>/g)].map((m) => Number(m[2]));
    expect(supports).toHaveLength(2);
    expect(supports[0]).toBeGreaterThan(supports[1]);
  });

  it("renders to a PNG of the requested size", async () => {
    const png = await renderLayoutGuide({ plan, rules, textFields: ["headline"], logoWidthPct: 12, width: 512, height: 640 });
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([512, 640]);
  });
});

describe("generation sizes", () => {
  it("are valid custom sizes that need little or no cropping", () => {
    for (const f of FORMATS) {
      const [w, h] = f.providerSize.split("x").map(Number);
      expect(w % 16, f.id).toBe(0);
      expect(h % 16, f.id).toBe(0);
      const { source, crop } = sceneCrop(f);
      const lost = 1 - (crop.width * crop.height) / (source.width * source.height);
      expect(lost, f.id).toBeLessThan(0.01);
    }
  });

  it("generates 4:5 posters at exactly 4:5", () => {
    const { source, crop } = sceneCrop(portrait);
    expect(source).toEqual({ width: 1024, height: 1280 });
    expect(crop).toEqual({ x: 0, y: 0, width: 1024, height: 1280 });
  });

  it("price custom sizes at the standard size that contains them", () => {
    const custom = estimateImageCall({ model: "gpt-image-2", quality: "high", size: "1024x1280", promptChars: 0, referenceImages: 0 });
    const standard = estimateImageCall({ model: "gpt-image-2", quality: "high", size: "1024x1536", promptChars: 0, referenceImages: 0 });
    expect(custom.microUsd).toBe(standard.microUsd);
  });
});

describe("product proportions", () => {
  it("reshape a tall box for a square product, keeping it inside the box and standing on the same base", async () => {
    const { matchSubjectAspects } = await import("./compose/framing.js");
    const plan = planWith([{ x: 0.43, y: 0.3, width: 0.25, height: 0.38 }]);
    const out = matchSubjectAspects(plan, { s1: 1 }, { width: 1080, height: 1350 }).subjects[0].region;
    expect((out.width * 1080) / (out.height * 1350)).toBeCloseTo(1, 1);
    expect(out.width).toBeLessThanOrEqual(0.25);
    expect(out.y + out.height).toBeCloseTo(0.68, 2);
  });
});

describe("review triage", () => {
  it("keeps style complaints that don't cite a real template rule as non-blocking notes", async () => {
    const { triageIssues } = await import("./jobs/kinds/generatePoster.js");
    const rules = ["Cool blue environmental palette and strong product-background contrast."];
    const base = { description: "", location: null, confidence: 0.9, remedy: "scene" as const };
    const out = triageIssues(
      [
        { ...base, category: "style_rule", brokenRule: null, severity: "high", description: "Teal studio instead of the reference's sunset lake." },
        { ...base, category: "style_rule", brokenRule: rules[0], severity: "high" },
        { ...base, category: "product_identity", brokenRule: null, severity: "high" },
      ],
      rules,
    );
    expect(out.map((i) => [i.severity, i.advisory])).toEqual([
      ["low", true],
      ["high", false],
      ["high", false],
    ]);
    const noCopy = triageIssues([{ ...base, category: "style_rule", brokenRule: rules[0], severity: "medium", remedy: "overlay" }], rules, { hasCopy: false });
    expect(noCopy[0].advisory).toBe(true);
  });
});

describe("occasion theme in the image prompt", () => {
  async function compile(theme: ConceptPlan["theme"], occasion: string) {
    const { compileImagePrompt } = await import("./compose/imagePrompt.js");
    const prof = {
      composition,
      summary: "Soft product promo",
      referenceClusters: [{ id: "c1", label: "Soft", description: "Pale gradient", referenceIds: ["ref1"] }],
      sharedInvariants: [],
      backgroundTreatment: "Pale gradient",
      lighting: null,
      contentToReplace: [
        { referenceId: "ref1", kind: "product", description: "Old phones" },
        { referenceId: "ref1", kind: "occasion", description: occasion },
      ],
      excludedDirections: [],
    } as unknown as StyleProfile;
    const plan = {
      ...planWith([{ x: 0.35, y: 0.4, width: 0.3, height: 0.4 }]),
      theme,
      scene: { medium: "photo", environment: "studio", background: "cream", palette: [], lighting: null, camera: "eye level", composition: "centred", backgroundComplexity: "low", mood: "festive", supportingElements: [] },
      avoid: [],
    } as unknown as ConceptPlan;
    return compileImagePrompt({ plan, profile: prof, clusterId: "c1", format: portrait, manifest: [], subjects: [], brand: null, textFields: [], fidelityMode: "match", framing: framingRules(prof, portrait, 1) });
  }
  const diwali = { occasion: "Diwali", visualCues: ["glowing diyas", "marigold garlands"], paletteAccents: ["#f5a623"], avoidCues: ["tricolour ribbon"] };

  it("puts the occasion first and excludes the reference's own festival", async () => {
    const p = await compile(diwali, "Independence Day: saffron and green confetti, tricolour ribbon");
    expect(p).toContain("THEME: this is a Diwali poster");
    expect(p).toContain("glowing diyas");
    expect(p).toContain("Do NOT show: tricolour ribbon");
    expect(p).toContain("occasion from the reference: Independence Day");
    expect(p.indexOf("THEME:")).toBeLessThan(p.indexOf("STYLE:"));
  });

  it("keeps a reference occasion that matches the new theme", async () => {
    const p = await compile(diwali, "Diwali: diyas and rangoli");
    expect(p).not.toContain("occasion from the reference: Diwali");
  });

  it("asks for no festival decorations when there is no occasion", async () => {
    const p = await compile(null, "Independence Day: tricolour ribbon");
    expect(p).toContain("THEME: no festival or occasion");
  });
});

describe("backdrop framing", () => {
  // Sony-style reference: products 51% wide, centred, bases overlapping the bottom of a 56%-wide panel.
  const sony = {
    ...composition,
    arrangement: "side_by_side" as const,
    subjectGroupWidth: 0.51,
    subjectGroupHeight: 0.41,
    subjectGroupCenterX: 0.51,
    subjectGroupCenterY: 0.55,
    visibleSupports: false,
    backdrop: { description: "rounded gradient panel", x: 0.22, y: 0.1, width: 0.56, height: 0.68, productRelation: "centred, bases overlapping its bottom edge", textOnlyFeatures: "side notches" },
  };
  const prof = { composition: sony } as unknown as StyleProfile;
  const square = getFormat("square")!;

  it("sizes the backdrop from the products so their ratio matches the template", async () => {
    const { planBackdrop } = await import("./compose/framing.js");
    const rules = framingRules(prof, square, 1);
    const plan = planWith([{ x: 0.24, y: 0.39, width: 0.52, height: 0.39 }]);
    const bd = planBackdrop(plan, rules, square)!;
    expect(0.52 / bd.region.width).toBeCloseTo(0.51 / 0.56, 1);
    // Product bases sit where they did in the reference: just above the panel's bottom edge (≈3.7% of its height).
    const gap = (bd.region.y + bd.region.height - (0.39 + 0.39)) / bd.region.height;
    expect(gap).toBeCloseTo((0.78 - (0.55 + 0.205)) / 0.68, 1);
    expect(bd.region.x + bd.region.width / 2).toBeCloseTo(0.5, 1);
  });

  it("draws no stands when the template has no visible supports, and draws the backdrop", async () => {
    const { planBackdrop } = await import("./compose/framing.js");
    const rules = framingRules(prof, square, 1);
    expect(rules.supports).toBe(false);
    const plan = planWith([{ x: 0.24, y: 0.39, width: 0.52, height: 0.39 }]);
    const svg = layoutGuideSvg({ plan, rules, textFields: [], logoWidthPct: 12, backdrop: planBackdrop(plan, rules, square), width: 500, height: 500 });
    expect(svg).not.toContain("#9aa1ab");
    expect(svg).toContain("#a9cdf0");
  });

  it("has no backdrop when the template has none", async () => {
    const { planBackdrop } = await import("./compose/framing.js");
    const plan = planWith([{ x: 0.3, y: 0.4, width: 0.4, height: 0.4 }]);
    expect(planBackdrop(plan, framingRules(profile, square, 1), square)).toBeNull();
  });
});

describe("backdrop for a tall single product", () => {
  it("contains a phone at the template's height ratio instead of shrinking to its width", async () => {
    const { planBackdrop } = await import("./compose/framing.js");
    const prof = {
      composition: {
        ...composition,
        subjectGroupWidth: 0.51,
        subjectGroupHeight: 0.45,
        subjectGroupCenterX: 0.51,
        subjectGroupCenterY: 0.59,
        visibleSupports: false,
        backdrop: { description: "panel", x: 0.23, y: 0.1, width: 0.55, height: 0.64, productRelation: "centred", textOnlyFeatures: null },
      },
    } as unknown as StyleProfile;
    const rules = framingRules(prof, portrait, 1);
    const phone = planWith([{ x: 0.39, y: 0.508, width: 0.22, height: 0.322 }]);
    const bd = planBackdrop(phone, rules, portrait)!.region;
    expect(bd.width).toBeGreaterThan(0.22 * 1.5);
    expect(0.322 / bd.height).toBeCloseTo(0.45 / 0.64, 1);
  });
});
