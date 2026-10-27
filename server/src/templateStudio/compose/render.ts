import sharp, { type OverlayOptions } from "sharp";
import type { BrandRules } from "../contracts/brand.js";
import { FALLBACK_FAMILY, loadFace, pickFace, type FontFace } from "../fonts/library.js";
import { blend, contrastRatio, hexToRgb, luminance, rgbToHex, type Rgb } from "./colour.js";
import type { LayoutIssue, LayoutReport, OverlayDoc, TextElement } from "./overlay.js";
import { layoutText, linePath, type FontPair } from "./text.js";

export interface KitLogo {
  id: string;
  kind: "primary" | "partner";
  name: string;
  colourHex: string | null;
  /** Normalised PNG of the logo. */
  data: Buffer;
}

export interface RenderInput {
  doc: OverlayDoc;
  scene: Buffer;
  faces: FontFace[];
  storageDir: string;
  logos: KitLogo[];
  rules: BrandRules | null;
}

interface RegionStats {
  mean: Rgb;
  lumaStd: number;
}

/** Mean colour and luminance spread of a region of the canvas scene. */
export function regionStats(raw: Buffer, W: number, H: number, box: { x: number; y: number; width: number; height: number }): RegionStats {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(W, Math.ceil(box.x + box.width));
  const y1 = Math.min(H, Math.ceil(box.y + box.height));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  let n = 0;
  const sum: Rgb = [0, 0, 0];
  let lSum = 0;
  let lSq = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 3;
      const px: Rgb = [raw[i], raw[i + 1], raw[i + 2]];
      sum[0] += px[0];
      sum[1] += px[1];
      sum[2] += px[2];
      const l = luminance(px);
      lSum += l;
      lSq += l * l;
      n++;
    }
  }
  if (n === 0) return { mean: [128, 128, 128], lumaStd: 0 };
  const meanL = lSum / n;
  return { mean: [sum[0] / n, sum[1] / n, sum[2] / n], lumaStd: Math.sqrt(Math.max(0, lSq / n - meanL * meanL)) };
}

const trimmedCache = new Map<string, { data: Buffer; width: number; height: number }>();

async function trimmedLogo(logo: KitLogo) {
  const key = `${logo.id}:${logo.data.length}`;
  let t = trimmedCache.get(key);
  if (!t) {
    const { data, info } = await sharp(logo.data).ensureAlpha().trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    t = { data, width: info.width, height: info.height };
    trimmedCache.set(key, t);
  }
  return t;
}

export function fontPair(faces: FontFace[], storageDir: string, family: string, weight: number): FontPair {
  return {
    primary: loadFace(pickFace(faces, family, weight), storageDir),
    fallback: loadFace(pickFace(faces, FALLBACK_FAMILY, weight), storageDir),
  };
}

/** The scene cropped and scaled to the canvas. */
export async function canvasScene(doc: Pick<OverlayDoc, "canvas" | "crop">, scene: Buffer) {
  const { width: W, height: H } = doc.canvas;
  const img = await sharp(scene)
    .extract({ left: doc.crop.x, top: doc.crop.y, width: doc.crop.width, height: doc.crop.height })
    .resize(W, H, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .toBuffer();
  const raw = await sharp(img).raw().toBuffer();
  return { img, raw };
}

export interface RenderResult {
  image: Buffer;
  report: LayoutReport;
}

export async function renderPoster(input: RenderInput, output: { format: "png" | "jpeg"; width?: number } = { format: "png" }): Promise<RenderResult> {
  const { doc } = input;
  const { width: W, height: H } = doc.canvas;
  const { img, raw } = await canvasScene(doc, input.scene);
  const issues: LayoutIssue[] = [];
  const svgParts: string[] = [];
  const reportTexts: LayoutReport["texts"] = [];

  for (const el of doc.texts) {
    if (el.hidden || !el.text.trim()) continue;
    const fonts = fontPair(input.faces, input.storageDir, el.fontFamily, el.fontWeight);
    const text = el.uppercase ? el.text.toLocaleUpperCase("en-IN") : el.text;
    const layout = layoutText(
      {
        text,
        box: { x: el.box.x * W, y: el.box.y * H, width: el.box.width * W, height: el.box.height * H },
        align: el.align,
        verticalAlign: el.verticalAlign,
        fontSize: (el.fontSizePct / 100) * H,
        minFontSize: Math.max((el.minFontSizePct / 100) * H, 12),
        lineHeight: el.lineHeight,
        canvasHeight: H,
      },
      fonts,
    );

    let background = regionStats(raw, W, H, layout.block).mean;
    if (el.plate) {
      const pad = (el.plate.paddingPct / 100) * H;
      const r = (el.plate.radiusPct / 100) * H;
      svgParts.push(
        `<rect x="${(layout.block.x - pad).toFixed(1)}" y="${(layout.block.y - pad).toFixed(1)}" width="${(layout.block.width + 2 * pad).toFixed(1)}" height="${(layout.block.height + 2 * pad).toFixed(1)}" rx="${r.toFixed(1)}" fill="${el.plate.color}" fill-opacity="${el.plate.opacity}"/>`,
      );
      background = blend(hexToRgb(el.plate.color), el.plate.opacity, background);
    }
    const contrast = contrastRatio(hexToRgb(el.color), background);
    const d = layout.lines.map((l) => linePath(l.text, l.x, l.baseline, layout.fontSize, fonts)).join(" ");
    svgParts.push(`<path d="${d}" fill="${el.color}"/>`);

    reportTexts.push({ id: el.id, fontSizePx: Math.round(layout.fontSize), lines: layout.lines.map((l) => l.text), overflow: layout.overflow, contrast: Math.round(contrast * 10) / 10 });
    if (layout.overflow) {
      issues.push({ severity: "error", elementId: el.id, message: `"${el.field}" doesn't fit its area even at the minimum size. Enlarge the area, shorten the copy, or regenerate with a new layout.` });
    } else if (layout.expanded) {
      issues.push({ severity: "info", elementId: el.id, message: `"${el.field}" area was extended downwards to fit the copy.` });
    }
    const large = layout.fontSize >= 0.03 * H;
    if (contrast < (large ? 3 : 4.5)) {
      issues.push({ severity: "warning", elementId: el.id, message: `"${el.field}" has low contrast (${contrast.toFixed(1)}:1) against its background.` });
    }
  }

  // Logos (deterministic brand rules).
  const composites: OverlayOptions[] = [];
  const reportLogo = await placeLogo(input, raw, svgParts, composites, issues);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgParts.join("")}</svg>`;
  let pipeline = sharp(img).composite([{ input: Buffer.from(svg), left: 0, top: 0 }, ...composites]);
  if (output.width && output.width < W) {
    pipeline = sharp(await pipeline.png().toBuffer()).resize(output.width);
  }
  const image = output.format === "jpeg" ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer() : await pipeline.png().toBuffer();
  return { image, report: { texts: reportTexts, logo: reportLogo, issues } };
}

/**
 * Place the brand logo (and any partner lock-up) by the kit's rules: approved corner, clear space, minimum width, and the
 * approved colour version with the best contrast against the scene. Adds SVG separators to `svgParts` and logo bitmaps to
 * `composites`; returns where the lock-up went.
 */
async function placeLogo(input: RenderInput, raw: Buffer, svgParts: string[], composites: OverlayOptions[], issues: LayoutIssue[]): Promise<LayoutReport["logo"]> {
  const { doc, rules } = input;
  const { width: W, height: H } = doc.canvas;
  let reportLogo: LayoutReport["logo"] = null;
  if (doc.logo && !doc.logo.hidden) {
    const primaries = input.logos.filter((l) => l.kind === "primary");
    if (primaries.length === 0) {
      issues.push({ severity: "warning", elementId: "logo", message: "The brand kit has no logo files, so no logo was placed." });
    } else {
      const minPx = rules?.logo.minWidth.digitalPx ?? 100;
      let widthPx = Math.max((doc.logo.widthPct / 100) * W, minPx);
      const ratio = rules?.logo.clearSpace.unitRatioOfLogoWidth ?? 0.14;
      const gapUnits = rules?.logo.partnerLockup?.gapUnits ?? 2;
      const separator = rules?.logo.partnerLockup ? rules.logo.partnerLockup.separator : "×";
      const partners = doc.logo.partnerLogoIds.map((id) => input.logos.find((l) => l.id === id && l.kind === "partner")).filter((l) => l !== undefined);

      // Size the lockup: primary width → height; partners matched to the same height.
      const primaryShapes = await Promise.all(primaries.map(trimmedLogo));
      const aspect = primaryShapes[0].height / primaryShapes[0].width;
      const partnerShapes = await Promise.all(partners.map(trimmedLogo));
      const lockupWidth = (w: number) => {
        const h = w * aspect;
        const X = ratio * w;
        return w + partnerShapes.reduce((s, p) => s + gapUnits * X + (p.width / p.height) * h, 0);
      };
      const maxLockup = 0.7 * W;
      if (lockupWidth(widthPx) > maxLockup) widthPx = Math.max(minPx, widthPx * (maxLockup / lockupWidth(widthPx)));
      const heightPx = widthPx * aspect;
      const X = ratio * widthPx;
      const margin = Math.max(X, 0.035 * Math.min(W, H));
      const total = lockupWidth(widthPx);
      const left = doc.logo.corner.endsWith("left") ? margin : W - margin - total;
      const top = doc.logo.corner.startsWith("top") ? margin : H - margin - heightPx;
      const region = { x: left - X, y: top - X, width: total + 2 * X, height: heightPx + 2 * X };
      const bg = regionStats(raw, W, H, region);

      // Variant: explicit choice, or the approved colour with the best contrast.
      const candidates = primaries.filter((p) => p.colourHex);
      let chosen = primaries.find((p) => p.id === doc.logo!.variant);
      if (!chosen) {
        chosen = (candidates.length ? candidates : primaries).reduce((best, p) =>
          p.colourHex && (!best.colourHex || contrastRatio(hexToRgb(p.colourHex), bg.mean) > contrastRatio(hexToRgb(best.colourHex), bg.mean)) ? p : best,
        );
      }
      const shape = primaryShapes[primaries.indexOf(chosen)];
      const contrast = chosen.colourHex ? contrastRatio(hexToRgb(chosen.colourHex), bg.mean) : null;

      const placed: { data: Buffer; x: number; y: number; w: number; h: number }[] = [];
      placed.push({ data: shape.data, x: left, y: top, w: widthPx, h: heightPx });
      let cursor = left + widthPx;
      partners.forEach((_p, i) => {
        const gap = gapUnits * X;
        if (separator) {
          const fonts = fontPair(input.faces, input.storageDir, FALLBACK_FAMILY, 300);
          const size = heightPx * 0.55;
          const sepWidth = fonts.primary.getAdvanceWidth(separator, size);
          const sx = cursor + gap / 2 - sepWidth / 2;
          const baseline = top + heightPx / 2 + size * 0.3;
          svgParts.push(`<path d="${linePath(separator, sx, baseline, size, fonts)}" fill="${chosen!.colourHex ?? "#000000"}"/>`);
        }
        const pw = (partnerShapes[i].width / partnerShapes[i].height) * heightPx;
        placed.push({ data: partnerShapes[i].data, x: cursor + gap, y: top, w: pw, h: heightPx });
        cursor += gap + pw;
      });

      for (const p of placed) {
        composites.push({
          input: await sharp(p.data).resize(Math.max(1, Math.round(p.w)), Math.max(1, Math.round(p.h)), { fit: "fill" }).png().toBuffer(),
          left: Math.round(p.x),
          top: Math.round(p.y),
        });
      }

      reportLogo = { variantId: chosen.id, widthPx: Math.round(widthPx), contrast: contrast === null ? null : Math.round(contrast * 10) / 10, box: { x: left / W, y: top / H, width: total / W, height: heightPx / H } };
      if (rules && !rules.logo.allowedCorners.includes(doc.logo.corner)) {
        issues.push({ severity: "error", elementId: "logo", message: `The brand only allows the logo in the ${rules.logo.allowedCorners.map((c) => c.replace("_", "-")).join(" or ")} corner.` });
      }
      if ((doc.logo.widthPct / 100) * W < minPx) {
        issues.push({ severity: "info", elementId: "logo", message: `Logo enlarged to the ${minPx}px minimum width.` });
      }
      if (contrast !== null && contrast < 3) {
        issues.push({ severity: "warning", elementId: "logo", message: `Logo contrast is low (${contrast.toFixed(1)}:1). Try another corner or colour version.` });
      }
      if (rules?.logo.requireCleanBackground && bg.lumaStd > 0.18) {
        issues.push({ severity: "warning", elementId: "logo", message: "The background behind the logo is busy; the brand asks for a clean area." });
      }
      if (partners.length && reportLogo.box.width > 0.69) {
        issues.push({ severity: "info", elementId: "logo", message: "Partner lock-up was scaled down to fit the canvas." });
      }
    }
  }

  return reportLogo;
}

/**
 * The logo lock-up alone, exactly as `renderPoster` places it on this scene, cut to its own box on a transparent
 * background: what FrameFlow's editor receives as the logo layer. Null when the poster has no logo.
 */
export async function renderLogoLockup(input: RenderInput): Promise<{ image: Buffer; box: { x: number; y: number; width: number; height: number } } | null> {
  const { width: W, height: H } = input.doc.canvas;
  const { raw } = await canvasScene(input.doc, input.scene);
  const svgParts: string[] = [];
  const composites: OverlayOptions[] = [];
  const logo = await placeLogo(input, raw, svgParts, composites, []);
  if (!logo || !composites.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgParts.join("")}</svg>`;
  const full = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, ...composites])
    .png()
    .toBuffer();
  const left = Math.max(0, Math.floor(logo.box.x * W));
  const top = Math.max(0, Math.floor(logo.box.y * H));
  const width = Math.max(1, Math.min(W - left, Math.ceil(logo.box.width * W)));
  const height = Math.max(1, Math.min(H - top, Math.ceil(logo.box.height * H)));
  const image = await sharp(full).extract({ left, top, width, height }).png().toBuffer();
  return { image, box: { x: left / W, y: top / H, width: width / W, height: height / H } };
}

/** Pick a readable text colour: keep the planned one unless contrast is too low. */
export function readableColour(planned: string, background: Rgb, large: boolean, brandOptions: string[]) {
  const need = large ? 3 : 4.5;
  if (contrastRatio(hexToRgb(planned), background) >= need) return { color: planned, changed: false };
  const options = [...brandOptions, "#ffffff", "#111111"];
  const best = options.reduce((b, c) => (contrastRatio(hexToRgb(c), background) > contrastRatio(hexToRgb(b), background) ? c : b), planned);
  return { color: best, changed: best !== planned };
}

export { rgbToHex };
export type { TextElement };
