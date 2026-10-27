import type { FidelityMode, StudioEditorOverlay, StudioHistoryItem, StudioPoster, StudioReviewCheck } from "@frameflow/shared";
import type { ServerEnv } from "../config.js";
import { describeCrop, getFormat } from "../compose/formats.js";
import { overlayDocSchema, type LayoutReport } from "../compose/overlay.js";
import { costSummary } from "../costs/summary.js";
import type { ManifestEntry } from "../compose/imagePrompt.js";
import type { JobRecord, PosterRecord, ReviewRecord, StudioStore as Db } from "../store.js";

const API = "/api/template-studio";
const assetUrl = (id: string, variant = "normalised") => `${API}/assets/${id}?variant=${variant}`;

/** Jobs whose spend belongs to this poster: its generation and any explicit re-checks of it. */
export function posterJobIds(db: Db, poster: PosterRecord) {
  const followUps = db.jobs.filter((j) => j.kind === "review_poster" && (j.inputSnapshot as { posterId?: string }).posterId === poster.id).map((j) => j.id);
  return [...(poster.jobId ? [poster.jobId] : []), ...followUps];
}

type Scores = Record<string, number | null> | null;
type ReviewItem = { category: string; description: string; severity: string; remedy: string; confidence: number; advisory: boolean };
type Match = NonNullable<StudioPoster["review"]>["referenceMatch"];

const byScore = (score: number | null | undefined): StudioReviewCheck["status"] => (score == null ? "unchecked" : score >= 4 ? "pass" : score === 3 ? "warn" : "fail");

/**
 * The review in the terms of the client checklist. Every status comes from the recorded review, layout report or
 * exact-pixel check; nothing is shown as passed when it was not checked.
 */
export function reviewChecks(input: {
  fidelityMode: FidelityMode; review: ReviewRecord | undefined; report: LayoutReport | null; hasBrandKit: boolean; products: number;
  exactProducts: PosterRecord["exactProducts"];
}): StudioReviewCheck[] {
  const { review, report, fidelityMode } = input;
  const scores = (review?.scores ?? null) as Scores;
  const items = ((review?.issues as { items?: ReviewItem[] } | undefined)?.items ?? []).filter((i) => !i.advisory);
  const hard = review?.hardFailures ?? [];
  const match = (review?.referenceMatch ?? null) as Match;
  const reviewed = Boolean(review && scores);
  const notReviewed = (label: string, id: string): StudioReviewCheck => ({ id, label, status: "unchecked", detail: review ? "The automatic review did not run; check by eye." : "Not reviewed yet." });
  const issueText = (cats: string[]) => items.filter((i) => cats.includes(i.category)).map((i) => i.description).join(" ");
  const modeName = fidelityMode === "adapt" ? "Adapt" : "Explore";
  const checks: StudioReviewCheck[] = [];

  if (!reviewed) checks.push(notReviewed("Reference-style similarity", "reference"));
  else if (fidelityMode === "match") {
    checks.push({
      id: "reference", label: "Reference-style similarity",
      status: match ? byScore(match.score) : "unchecked",
      detail: match ? `Match Reference score ${match.score}/5.${match.differences.length ? ` Differences: ${match.differences.join("; ")}.` : " No clear differences from the template's scene."}` : "The reviewer did not score the reference match.",
    });
  } else {
    checks.push({ id: "reference", label: "Reference-style similarity", status: byScore(scores?.styleConsistency), detail: `Style consistency ${scores?.styleConsistency ?? "–"}/5 against the template's learned rules. ${modeName} mode allows a new setting.` });
  }

  if (input.exactProducts?.applied) {
    checks.push({ id: "identity", label: "Product identity", status: hard.some(h => h.code === "product_identity" || h.code === "subject_count") ? "fail" : input.exactProducts.ok ? "pass" : "warn", detail: input.exactProducts.detail });
  } else if (!input.products) checks.push({ id: "identity", label: "Product identity", status: "unchecked", detail: "No products in this poster." });
  else if (!reviewed) checks.push(notReviewed("Product identity", "identity"));
  else checks.push({ id: "identity", label: "Product identity", status: byScore(scores?.subjectIdentity), detail: `Identity ${scores?.subjectIdentity}/5. The image model redraws products: compare them with your photos by eye. ${issueText(["product_identity"])}`.trim() });

  const layoutErrors = (report?.issues ?? []).filter((i) => i.severity === "error");
  const composition = issueText(["composition", "physical_plausibility"]);
  checks.push({
    id: "layout", label: "Layout and framing",
    status: layoutErrors.length ? "fail" : !reviewed ? "unchecked" : composition ? "warn" : "pass",
    detail: layoutErrors.length ? layoutErrors.map((i) => i.message).join(" ") : composition || (reviewed ? "Products, text areas and margins follow the plan." : "Not reviewed."),
  });

  if (!reviewed) checks.push(notReviewed("Background", "background"));
  else if (fidelityMode === "match") {
    checks.push({
      id: "background", label: "Background",
      status: match ? (match.sameBackground && match.sameStagingAndProps ? "pass" : "fail") : "unchecked",
      detail: match ? `Background ${match.sameBackground ? "matches" : "differs from"} the template; staging and props ${match.sameStagingAndProps ? "match" : "differ"}; camera ${match.sameCameraAndFraming ? "matches" : "differs"}; lighting ${match.sameLighting ? "matches" : "differs"}; palette ${match.samePalette ? "matches" : "differs"}.` : "Not scored.",
    });
  } else checks.push({ id: "background", label: "Background", status: "pass", detail: `A new background is allowed in ${modeName} mode.` });

  const textIssues = (report?.issues ?? []).filter((i) => i.elementId !== "logo" && i.severity !== "info");
  const logoIssues = (report?.issues ?? []).filter((i) => i.elementId === "logo" && i.severity !== "info");
  checks.push({
    id: "text", label: "Text and logo integrity",
    status: textIssues.some((i) => i.severity === "error") ? "fail" : textIssues.length || logoIssues.length ? "warn" : "pass",
    detail: [...textIssues, ...logoIssues].map((i) => i.message).join(" ") || "Copy is placed exactly as typed, as editable text; logos come from the brand kit, never generated.",
  });

  checks.push({
    id: "brand", label: "Brand consistency",
    status: !input.hasBrandKit ? "unchecked" : logoIssues.length ? "warn" : "pass",
    detail: !input.hasBrandKit ? "No brand kit on this poster." : logoIssues.length ? logoIssues.map((i) => i.message).join(" ") : "Logo in an approved corner and colour version, at or above the minimum size.",
  });

  const missing = hard.filter((h) => h.code === "subject_count");
  checks.push({
    id: "missing", label: "Missing elements",
    status: missing.length ? "fail" : !input.products ? "pass" : !reviewed ? "unchecked" : byScore(scores?.subjectCount),
    detail: missing.map((m) => m.description).join(" ") || (!input.products ? "Text-led poster: no products expected." : reviewed ? `Product count ${scores?.subjectCount}/5.` : "Not reviewed."),
  });

  const sceneText = hard.filter((h) => h.code === "scene_text" || h.code === "copied_reference");
  checks.push({
    id: "scene_text", label: "No unwanted generated text",
    status: sceneText.length ? "fail" : reviewed ? "pass" : "unchecked",
    detail: sceneText.map((h) => h.description).join(" ") || (reviewed ? "No text, numbers or logos found in the generated image." : "Not reviewed."),
  });
  if (input.exactProducts?.detail.startsWith('The entire primary reference')) {
    for (const check of checks) if (['reference', 'background', 'missing'].includes(check.id)) Object.assign(check, { status: 'pass', detail: 'Deterministic local reuse of the complete primary reference. No generated replacement scene and no AI review.' });
    const text = checks.find(c => c.id === 'scene_text')!;
    Object.assign(text, { status: 'unchecked', detail: 'Original raster text and logos intentionally retained. New native copy needs visual review.' });
  }
  return checks;
}

export function posterDetail(db: Db, env: ServerEnv, posterId: string): StudioPoster | null {
  const poster = db.posters.get(posterId);
  if (!poster) return null;
  const campaign = db.campaigns.require(poster.campaignId, "Campaign");
  const template = db.templates.get(campaign.templateId);
  const doc = overlayDocSchema.parse(poster.overlay);
  const format = getFormat(doc.formatId);
  const jobIds = posterJobIds(db, poster);
  const usage = db.usage.filter((u) => u.jobId !== null && jobIds.includes(u.jobId));
  const plan = poster.jobId ? db.conceptPlans.find((p) => p.jobId === poster.jobId) : undefined;
  const attempt = poster.jobId ? db.attempts.find((a) => a.jobId === poster.jobId && a.outcome === "succeeded") : undefined;
  const review = db.reviews.filter((r) => r.posterId === poster.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const concepts = (plan?.concepts ?? []) as { id: string; title: string; summary: string }[];
  const reviewIssues = review?.issues as { summary?: string | null; items?: ReviewItem[]; reviewError?: string | null } | undefined;
  const subjects = campaign.subjectIds.map((id) => db.subjects.get(id)).filter((s) => s !== undefined);
  const profile = db.profiles.get(campaign.profileVersionId);
  const report = poster.layoutReport as LayoutReport | null;
  const mode = campaign.fidelityMode;
  return {
    provenance: poster.provenance ?? 'ai_generated', productActions: campaign.referencePolicy?.actions,
    id: poster.id,
    campaignId: poster.campaignId,
    jobId: poster.jobId,
    createdAt: poster.createdAt,
    updatedAt: poster.updatedAt,
    reviewStatus: poster.reviewStatus,
    approvedAt: poster.approvedAt,
    template: {
      id: campaign.templateId,
      name: template?.name ?? "Deleted template",
      references: [...(template?.references ?? [])].sort((a, b) => a.position - b.position).map((r) => ({ assetId: r.assetId, thumb: assetUrl(r.assetId, "thumb"), full: assetUrl(r.assetId) })),
      profileVersion: profile?.version ?? null,
    },
    format: format ? { id: format.id, label: format.label, ratio: format.ratio, exportWidth: format.width, exportHeight: format.height, providerSize: format.providerSize, note: describeCrop(format) } : null,
    fidelityMode: mode,
    occasion: campaign.occasion,
    direction: campaign.direction,
    quality: campaign.imageQuality,
    preserveProductPixels: campaign.preserveProductPixels,
    copy: campaign.copy,
    products: subjects.map((s) => {
      const asset = db.assets.get(s.primaryAssetId);
      return { subjectId: s.id, assetId: s.primaryAssetId, name: s.name, thumb: assetUrl(s.primaryAssetId, "thumb"), full: assetUrl(s.primaryAssetId), hasAlpha: asset?.hasAlpha ?? false };
    }),
    canvas: doc.canvas,
    crop: doc.crop,
    texts: doc.texts,
    logo: doc.logo,
    report,
    notes: [...doc.notes, ...((plan?.scenePlan as { framingNotes?: string[] } | undefined)?.framingNotes ?? [])],
    review: review
      ? {
          summary: reviewIssues?.summary ?? null,
          hardFailures: review.hardFailures,
          scores: review.scores as Scores,
          issues: reviewIssues?.items ?? [],
          referenceMatch: (review.referenceMatch ?? null) as Match,
          reviewError: reviewIssues?.reviewError ?? null,
          model: review.model,
          promptVersion: review.promptVersion,
          createdAt: review.createdAt,
        }
      : null,
    checks: reviewChecks({ fidelityMode: mode, review, report, hasBrandKit: Boolean(doc.brandKitId), products: poster.expectedProductCount ?? subjects.length, exactProducts: poster.exactProducts }),
    exactProducts: poster.exactProducts,
    plan: plan
      ? {
          concept: concepts.find((c) => c.id === plan.chosenConceptId) ?? null,
          alternatives: concepts.filter((c) => c.id !== plan.chosenConceptId),
          rationale: plan.selectionRationale,
          framingNotes: (plan.scenePlan as { framingNotes?: string[] }).framingNotes ?? [],
        }
      : null,
    generation: attempt
      ? {
          model: attempt.model, quality: attempt.quality, providerSize: attempt.providerSize, prompt: attempt.prompt, latencyMs: attempt.latencyMs, promptVersion: attempt.promptVersion,
          references: (attempt.referenceManifest as ManifestEntry[]).map((m) => ({ index: m.index, role: m.role, label: m.label })),
        }
      : null,
    urls: {
      poster: `${API}/posters/${poster.id}/image?format=jpeg&width=1400&v=${encodeURIComponent(poster.updatedAt)}`,
      scene: assetUrl(poster.sceneAssetId),
      rawScene: poster.rawSceneAssetId ? assetUrl(poster.rawSceneAssetId) : null,
      layoutGuide: attempt?.layoutGuideAssetId ? assetUrl(attempt.layoutGuideAssetId) : null,
      download: { png: `${API}/posters/${poster.id}/image?format=png&download=1`, jpeg: `${API}/posters/${poster.id}/image?format=jpeg&download=1` },
      decompositionScene: `${API}/posters/${poster.id}/decomposition-scene.png`,
    },
    cost: costSummary(usage, env),
    decompositions: db.decompositions
      .filter((d) => d.posterId === poster.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({ runId: d.runId, createdAt: d.createdAt, sentWidth: d.sentWidth, sentHeight: d.sentHeight })),
  };
}

/** History: poster runs and template analyses (failed ones included), newest first, with recorded cost. */
export function historyItems(db: Db, env: ServerEnv): StudioHistoryItem[] {
  const jobs: JobRecord[] = db.jobs
    .filter((j) => j.kind === "generate_poster" || j.kind === "analyse_template")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
  return jobs.map((j) => {
    const campaign = db.campaigns.get(j.campaignId);
    const poster = db.posters.find((p) => p.jobId === j.id);
    const templateId = campaign?.templateId ?? (j.inputSnapshot as { templateId?: string }).templateId;
    const format = campaign ? getFormat(campaign.formatId) : undefined;
    const firstReference = [...(db.templates.get(templateId)?.references ?? [])].sort((a, b) => a.position - b.position)[0];
    return {
      jobId: j.id,
      kind: j.kind,
      state: j.state,
      createdAt: j.createdAt,
      error: j.error ? { message: j.error.message } : null,
      templateName: db.templates.get(templateId)?.name ?? null,
      headline: campaign?.copy.headline ?? null,
      fidelityMode: campaign?.fidelityMode ?? null,
      formatLabel: format?.label ?? null,
      templateThumb: firstReference ? assetUrl(firstReference.assetId, "thumb") : null,
      poster: poster
        ? { id: poster.id, reviewStatus: poster.reviewStatus, thumb: `${API}/posters/${poster.id}/image?width=360&format=jpeg&v=${encodeURIComponent(poster.updatedAt)}`, decomposed: db.decompositions.count((d) => d.posterId === poster.id) > 0 }
        : null,
      cost: costSummary(db.usage.filter((u) => u.jobId === j.id), env),
    };
  });
}

/** The copy and logo of a poster as FrameFlow's editor restores them over the decomposed layers. */
export function editorOverlay(poster: PosterRecord, logoBox: { x: number; y: number; width: number; height: number } | null): StudioEditorOverlay {
  const doc = overlayDocSchema.parse(poster.overlay);
  const report = poster.layoutReport as LayoutReport | null;
  return {
    posterId: poster.id,
    products: poster.productLayers?.map(p => ({ id: p.productId, url: assetUrl(p.assetId), box: { x: p.box.x / doc.crop.width, y: p.box.y / doc.crop.height, width: p.box.width / doc.crop.width, height: p.box.height / doc.crop.height } })),
    canvas: doc.canvas,
    texts: doc.texts
      .filter((t) => !t.hidden && t.text.trim())
      .map((t) => {
        const rendered = report?.texts.find((r) => r.id === t.id);
        return { ...t, renderedFontSizePct: rendered ? (rendered.fontSizePx / doc.canvas.height) * 100 : null, lines: rendered?.lines ?? [] };
      }),
    logo: logoBox ? { url: `${API}/posters/${poster.id}/logo.png`, box: logoBox } : null,
  };
}
