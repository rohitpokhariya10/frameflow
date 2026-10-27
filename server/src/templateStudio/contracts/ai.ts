import { z } from "zod";

/**
 * Versioned schemas for every AI-produced object. They are sent to the model as
 * strict JSON schemas, so they only use features strict mode supports: no
 * optional fields (nullable instead), no string length limits, no defaults.
 * Semantic checks (bounds, ids, exact copy) happen in code after parsing.
 *
 * Builders take the ids/options valid for one request so the model can only
 * choose from real values (reference ids, asset ids, font families, fields).
 */

const hexish = z.string().describe("Hex colour like #1a2b3c");
const unit = z.number().min(0).max(1);
const confidence = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Style profile (template analysis)
// ---------------------------------------------------------------------------

export const STYLE_PROFILE_SCHEMA = "style-profile/5";

const referenceBox = z.object({ x: unit, y: unit, width: unit, height: unit });
export const referenceSceneSchema = z.object({
  referenceId: z.string(), confidence,
  products: z.array(z.object({
    id: z.string().describe('Stable local ID, p1, p2 etc. Ordered left to right. One per complete product instance, not per component.'),
    label: z.string(), identity: z.string(), box: referenceBox,
    depth: z.number(), confidence, overlaps: z.array(z.string()), transparent: z.boolean(),
    shadows: z.string(), reflections: z.string(),
  })).max(20),
  camera: z.string(), lighting: z.string(), supportingObjects: z.array(z.string()), background: z.string(),
  textRegions: z.array(z.object({ kind: z.enum(['text', 'logo']), description: z.string(), box: referenceBox })),
});

export const VISUAL_MEDIA = ["photo", "illustration", "3d-render", "collage", "typography-led", "mixed", "unknown"] as const;

export const ARRANGEMENTS = ["single_hero", "stepped_levels", "side_by_side", "stacked", "scattered", "floating", "no_subjects"] as const;

/**
 * Measured framing of the products in the references (typical values across the
 * selected references). Fractions are of the reference image's own width/height.
 */
export const compositionSchema = z.object({
  arrangement: z.enum(ARRANGEMENTS),
  staging: z.string().describe("How products are physically staged: plinths/steps of different heights, rocks, shelves, floating, etc."),
  heroPlacement: z.string().describe("Where the hero product sits relative to the others (e.g. raised at the back, centre)"),
  subjectGroupWidth: unit.describe("Width of the box around ALL products (excluding their supports) as a fraction of image width"),
  subjectGroupHeight: unit.describe("Height of the box around ALL products (excluding their supports) as a fraction of image height"),
  subjectGroupCenterX: unit,
  subjectGroupCenterY: unit,
  headroom: unit.describe("Fraction of image height above the top of the highest product that is open background"),
  footroom: unit.describe("Fraction of image height below the base of the lowest product (supports, floor, water)"),
  minEdgeMargin: unit.describe("Smallest gap between any product or its support and the left/right image edge, as a fraction of image width"),
  overlap: z.enum(["none", "slight", "strong"]).describe("How much products overlap each other from the camera's view"),
  visibleSupports: z.boolean().describe("True when products stand on visible plinths, steps, rocks, shelves or similar"),
  backdrop: z
    .object({
      description: z.string().describe("The main shape, panel or surface the products are framed by, e.g. 'rounded turquoise-to-lime gradient panel'"),
      x: unit,
      y: unit,
      width: unit,
      height: unit,
      productRelation: z.string().describe("How the products sit against it, e.g. 'centred, bases overlapping its bottom edge'"),
      textOnlyFeatures: z.string().nullable().describe("Parts of the shape that only exist to hold text (notches, tabs, cut-outs); null if none"),
    })
    .nullable()
    .describe("Box of the backdrop as fractions of the reference image; null when there is no distinct backdrop shape (e.g. full-bleed scenes)"),
});
export type Composition = z.infer<typeof compositionSchema>;

export function styleProfileSchema(referenceIds: readonly [string, ...string[]], fontFamilies: readonly [string, ...string[]]) {
  const refId = z.enum(referenceIds);
  return z.object({
    referenceScenes: z.array(referenceSceneSchema).describe('Inventory separately for EVERY reference. ref1 is the primary composition and product source. Additional references are style only.'),
    summary: z.string().describe("2–3 sentence human-readable description of the reusable style"),
    visualMedium: z.enum(VISUAL_MEDIA),
    campaignCharacter: z.string(),
    visualHierarchy: z.string(),
    palette: z.object({
      colors: z
        .array(z.object({ hex: hexish, role: z.string(), prominence: z.enum(["dominant", "secondary", "accent"]) }))
        .min(1)
        .max(10),
      allowedVariation: z.string(),
    }),
    typography: z.object({
      headlineCharacter: z.string(),
      bodyCharacter: z.string(),
      casing: z.string(),
      /** Closest matches from the available library; exact fonts are rarely identifiable. */
      suggestedHeadlineFamily: z.enum(fontFamilies),
      suggestedBodyFamily: z.enum(fontFamilies),
      identificationConfidence: confidence,
    }),
    layout: z.object({
      density: z.enum(["sparse", "balanced", "dense"]),
      negativeSpace: z.enum(["low", "medium", "high"]),
      alignment: z.string(),
      focalHierarchy: z.string(),
      textPlacement: z.string(),
      typicalRelationships: z.string(),
    }),
    composition: compositionSchema,
    lighting: z.string().nullable().describe("null for flat artwork"),
    materials: z.string().nullable(),
    backgroundTreatment: z.string(),
    sharedInvariants: z.array(z.string()).max(12),
    referenceSpecificMotifs: z.array(z.object({ referenceId: refId, motif: z.string() })).max(15),
    allowedVariation: z.array(z.string()).max(10),
    excludedDirections: z.array(z.string()).max(10),
    referenceClusters: z
      .array(z.object({ id: z.string(), label: z.string(), description: z.string(), referenceIds: z.array(refId).min(1) }))
      .min(1)
      .max(3),
    defaultClusterId: z.string(),
    contentToReplace: z
      .array(
        z.object({
          referenceId: refId,
          kind: z.enum(["product", "headline", "offer", "price", "logo", "date", "person", "disclaimer", "occasion", "other"]).describe("occasion: a festival, holiday or season theme and its decorations (e.g. tricolour ribbons for Independence Day, diyas for Diwali)"),
          description: z.string(),
        }),
      )
      .max(30),
    evidence: z.array(z.object({ rule: z.string(), referenceIds: z.array(refId).min(1), confidence })).max(15),
    overallConfidence: confidence,
    singleReferenceCaveat: z.string().nullable(),
  });
}
export type StyleProfile = Omit<z.infer<ReturnType<typeof styleProfileSchema>>, 'referenceScenes'> & { referenceScenes?: z.infer<typeof referenceSceneSchema>[] };

// ---------------------------------------------------------------------------
// Subject analysis
// ---------------------------------------------------------------------------

export const SUBJECT_ANALYSIS_SCHEMA = "subject-analysis/1";

export const subjectAnalysisSchema = z.object({
  category: z.string(),
  silhouette: z.string(),
  materials: z.array(z.string()).max(8),
  colors: z.array(z.string()).max(8),
  definingDetails: z.array(z.string()).max(10),
  visibleView: z.enum(["front", "three_quarter", "side", "back", "top", "detail", "multiple", "unknown"]),
  supportNeeds: z.string().describe("How it would rest, stand, hang or mount in a realistic scene"),
  visibleText: z.array(z.string()).max(10).describe("Legible text or labels on the product itself"),
  isolatedOnPlainBackground: z.boolean(),
  uncertainties: z.array(z.string()).max(8),
  confidence,
});
export type SubjectAnalysis = z.infer<typeof subjectAnalysisSchema>;

// ---------------------------------------------------------------------------
// Concept plan (art direction)
// ---------------------------------------------------------------------------

export const CONCEPT_PLAN_SCHEMA = "concept-plan/3";

export const TEXT_ALIGN = ["left", "center", "right"] as const;
export const V_ALIGN = ["top", "middle", "bottom"] as const;
export const CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;

export function conceptPlanSchema(opts: {
  subjectIds: readonly string[];
  copyFields: readonly [string, ...string[]] | readonly [];
  fontFamilies: readonly [string, ...string[]];
  logoCorners: readonly [string, ...string[]];
}) {
  const textRegion = z.object({
    field: opts.copyFields.length ? z.enum(opts.copyFields as readonly [string, ...string[]]) : z.string(),
    x: unit,
    y: unit,
    width: unit,
    height: unit,
    align: z.enum(TEXT_ALIGN),
    verticalAlign: z.enum(V_ALIGN),
    fontFamily: z.enum(opts.fontFamilies),
    fontWeight: z.number().min(100).max(900),
    fontSizePct: z.number().min(1).max(25).describe("Cap height target: font size as % of canvas height"),
    lineHeight: z.number().min(0.8).max(2),
    uppercase: z.boolean(),
    color: hexish,
    plate: z
      .object({ color: hexish, opacity: unit, paddingPct: z.number().min(0).max(5), radiusPct: z.number().min(0).max(5) })
      .nullable()
      .describe("Background plate behind the text, only if needed for legibility or the style uses it"),
  });

  const subject = z.object({
    subjectId: opts.subjectIds.length ? z.enum(opts.subjectIds as [string, ...string[]]) : z.string(),
    placement: z.string(),
    region: z.object({ x: unit, y: unit, width: unit, height: unit }),
    prominence: z.enum(["hero", "secondary", "supporting"]),
    scaleBasis: z.string(),
    support: z.string().describe("What physically holds it, or 'none (graphic style)' when unrealistic staging is intended"),
  });

  return z.object({
    concepts: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).min(2).max(3),
    chosenConceptId: z.string(),
    selectionRationale: z.string(),
    theme: z
      .object({
        occasion: z.string().describe("e.g. Diwali, Holi, Independence Day, Christmas, End of season sale"),
        visualCues: z.array(z.string()).min(1).max(6).describe("Concrete, culturally right elements that make the occasion obvious, styled to fit the template"),
        paletteAccents: z.array(hexish).max(4),
        avoidCues: z.array(z.string()).max(6).describe("Decorations of other occasions (including the references' own) that must not appear"),
      })
      .nullable()
      .describe("The campaign's occasion from the user's direction and copy; null when there is none"),
    scene: z.object({
      medium: z.enum(VISUAL_MEDIA),
      environment: z.string(),
      background: z.string(),
      palette: z.array(hexish).min(1).max(8),
      lighting: z.string().nullable(),
      camera: z.string(),
      composition: z.string(),
      backgroundComplexity: z.enum(["low", "medium", "high"]),
      mood: z.string(),
      supportingElements: z.array(z.object({ element: z.string(), purpose: z.string() })).max(6),
    }),
    subjects: z.array(subject).max(6),
    texts: z.array(textRegion).max(8),
    logo: z.object({ corner: z.enum(opts.logoCorners), widthPct: z.number().min(8).max(35) }),
    avoid: z.array(z.string()).max(10),
    designRationale: z.string(),
  });
}
export type ConceptPlan = z.infer<ReturnType<typeof conceptPlanSchema>>;
export type PlannedText = ConceptPlan["texts"][number];

// ---------------------------------------------------------------------------
// Visual review
// ---------------------------------------------------------------------------

export const REVIEW_SCHEMA = "review/4";

const score = z.number().min(1).max(5).describe("1 = very poor, 2 = poor, 3 = acceptable, 4 = good, 5 = excellent");

export const ISSUE_CATEGORIES = [
  "product_identity",
  "product_count",
  "scene_text",
  "copied_reference",
  "composition",
  "physical_plausibility",
  "readability",
  "style_rule",
  "theme",
  "other",
] as const;

/**
 * @param styleRules the template's own rules (always-keep invariants and
 *   excluded directions). A style complaint must name one of them exactly, so
 *   "it doesn't look like that one reference photo" can't be raised as a defect.
 */
export function reviewSchema(styleRules: readonly string[], opts: { matchReference?: boolean } = {}) {
  const base = z.object({
    summary: z.string(),
    scores: z.object({
      styleConsistency: score.describe("Against the template's learned rules, not the literal setting of any one reference"),
      subjectIdentity: score.describe("5 = the products look exactly like the supplied subject images; 1 = unrecognisable"),
      subjectCount: score.describe("5 = exactly the expected products, none missing or duplicated; 1 = products missing or duplicated"),
      focalHierarchy: score,
      readability: score,
      physicalPlausibility: score.nullable().describe("null when the style is intentionally non-realistic"),
      advertisingUsefulness: score,
    }),
    issues: z
      .array(
        z.object({
          category: z.enum(ISSUE_CATEGORIES),
          brokenRule: (styleRules.length ? z.enum(styleRules as [string, ...string[]]) : z.literal("none"))
            .nullable()
            .describe("For style_rule issues: the exact template rule that is broken. null for other categories."),
          description: z.string(),
          location: z.object({ x: unit, y: unit, width: unit, height: unit }).nullable(),
          severity: z.enum(["low", "medium", "high"]),
          confidence,
          remedy: z.enum(["overlay", "scene", "human"]),
        }),
      )
      .max(12),
    productIntegrity: z.object({
      observedCount: z.number().int().min(0).nullable(),
      missing: z.array(z.string()), unexpected: z.array(z.string()), identityProblems: z.array(z.string()), uncertainties: z.array(z.string()),
    }).describe('Count actual output products, identify missing expected IDs and unintended additions. Report uncertainty honestly; high style scores never excuse missing products.'),
    copiedReferenceContent: z.array(z.string()).max(6).describe("Unrequested text, logos or products copied from additional references. Primary KEEP products and deliberately retained raster text are expected, not violations."),
    unwantedSceneText: z
      .array(z.string())
      .max(10)
      .describe("Any text, numbers, signage, watermarks or logos visible in the RAW GENERATED SCENE image, excluding printing that exists on the real product"),
  });
  // FrameFlow addition: Match Reference posters are also scored against the template examples themselves.
  return opts.matchReference ? base.extend({ referenceMatch: referenceMatchSchema }) : base;
}

export const referenceMatchSchema = z.object({
  score: score.describe("5 = clearly the same design family as the template examples (background, backdrop, supports and props, camera, lighting and palette all match); 3 = related but noticeably changed; 1 = an unrelated scene"),
  sameBackground: z.boolean().describe("Background treatment and colours match the examples"),
  sameStagingAndProps: z.boolean().describe("Backdrop shape, podiums, pedestals, steps and props and their arrangement match the examples"),
  sameCameraAndFraming: z.boolean().describe("Camera angle, perspective and framing match the examples"),
  sameLighting: z.boolean().describe("Lighting direction, softness and reflections match the examples"),
  samePalette: z.boolean().describe("Dominant colours match the examples"),
  differences: z.array(z.string()).max(8).describe("Every clear difference from the examples' scene, excluding the new products themselves"),
});
export type ReferenceMatch = z.infer<typeof referenceMatchSchema>;
export type Review = z.infer<ReturnType<typeof reviewSchema>> & { referenceMatch?: ReferenceMatch };
