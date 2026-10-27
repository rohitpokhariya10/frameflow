import type { Font } from "opentype.js";

/**
 * Text layout with exact font metrics. Characters missing from the chosen font
 * (e.g. ₹ in some display fonts) are drawn with the fallback font. Copy is
 * never truncated or rewritten: if it can't fit at the minimum size, it is
 * laid out anyway and reported as overflowing.
 */

export interface FontPair {
  primary: Font;
  fallback: Font;
}

interface Run {
  font: Font;
  text: string;
}

function runs(text: string, fonts: FontPair): Run[] {
  const out: Run[] = [];
  for (const ch of text) {
    const font = fonts.primary.charToGlyph(ch).index === 0 && ch.trim() !== "" ? fonts.fallback : fonts.primary;
    const last = out.at(-1);
    if (last && last.font === font) last.text += ch;
    else out.push({ font, text: ch });
  }
  return out;
}

export function measure(text: string, size: number, fonts: FontPair) {
  return runs(text, fonts).reduce((w, r) => w + r.font.getAdvanceWidth(r.text, size, { kerning: true }), 0);
}

/** Greedy word wrap; explicit newlines are kept. Words longer than the line stay whole. */
export function wrap(text: string, size: number, maxWidth: number, fonts: FontPair): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measure(candidate, size, fonts) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface TextLayoutInput {
  text: string;
  box: { x: number; y: number; width: number; height: number }; // px
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  fontSize: number; // px, starting size
  minFontSize: number; // px
  lineHeight: number;
  canvasHeight: number;
}

export interface TextLayout {
  fontSize: number;
  lines: { text: string; x: number; baseline: number; width: number }[];
  block: { x: number; y: number; width: number; height: number };
  overflow: boolean;
  expanded: boolean;
}

function metrics(font: Font) {
  const asc = font.ascender / font.unitsPerEm;
  const desc = -font.descender / font.unitsPerEm;
  return { asc, desc };
}

export function layoutText(input: TextLayoutInput, fonts: FontPair): TextLayout {
  const { asc, desc } = metrics(fonts.primary);
  const tryAt = (size: number, boxHeight: number) => {
    const lines = wrap(input.text, size, input.box.width, fonts);
    const widths = lines.map((l) => measure(l, size, fonts));
    const lineBox = size * input.lineHeight;
    const height = lines.length * lineBox;
    const fits = widths.every((w) => w <= input.box.width + 0.5) && height <= boxHeight + 0.5;
    return { lines, widths, lineBox, height, fits };
  };

  let size = Math.max(input.fontSize, input.minFontSize);
  let attempt = tryAt(size, input.box.height);
  while (!attempt.fits && size > input.minFontSize) {
    size = Math.max(input.minFontSize, size * 0.94);
    attempt = tryAt(size, input.box.height);
  }

  // Permitted expansion: grow the box downwards by up to 25% of its height, within the canvas.
  let boxHeight = input.box.height;
  let expanded = false;
  if (!attempt.fits) {
    const maxGrow = Math.min(input.box.height * 0.25, input.canvasHeight - (input.box.y + input.box.height));
    if (maxGrow > 0) {
      const grown = tryAt(size, input.box.height + maxGrow);
      if (grown.fits) {
        attempt = grown;
        boxHeight = Math.min(input.box.height + maxGrow, Math.max(input.box.height, grown.height));
        expanded = true;
      }
    }
  }

  const blockHeight = attempt.height;
  const top =
    input.verticalAlign === "top"
      ? input.box.y
      : input.verticalAlign === "bottom"
        ? input.box.y + boxHeight - blockHeight
        : input.box.y + (boxHeight - blockHeight) / 2;
  const contentHeight = (asc + desc) * size;
  const lines = attempt.lines.map((text, i) => {
    const width = attempt.widths[i];
    const x =
      input.align === "left" ? input.box.x : input.align === "right" ? input.box.x + input.box.width - width : input.box.x + (input.box.width - width) / 2;
    const baseline = top + i * attempt.lineBox + (attempt.lineBox - contentHeight) / 2 + asc * size;
    return { text, x, baseline, width };
  });
  const minX = Math.min(...lines.map((l) => l.x));
  const maxX = Math.max(...lines.map((l) => l.x + l.width));
  return {
    fontSize: size,
    lines,
    block: { x: minX, y: top, width: maxX - minX, height: blockHeight },
    overflow: !attempt.fits,
    expanded,
  };
}

const num = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * SVG path data from glyph commands. opentype.js 2.0's own toPathData turns
 * coordinates with floating-point noise (e.g. 729.0000000000001) into "NaN",
 * and SVG renderers stop drawing at the first NaN, silently cutting text off.
 */
export function pathData(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]): string {
  let d = "";
  for (const c of commands) {
    if (c.type === "M" || c.type === "L") d += `${c.type}${num(c.x!)} ${num(c.y!)}`;
    else if (c.type === "Q") d += `Q${num(c.x1!)} ${num(c.y1!)} ${num(c.x!)} ${num(c.y!)}`;
    else if (c.type === "C") d += `C${num(c.x1!)} ${num(c.y1!)} ${num(c.x2!)} ${num(c.y2!)} ${num(c.x!)} ${num(c.y!)}`;
    else if (c.type === "Z") d += "Z";
  }
  return d;
}

/** SVG path data for one line, switching fonts per run. */
export function linePath(text: string, x: number, baseline: number, size: number, fonts: FontPair): string {
  let cursor = x;
  const parts: string[] = [];
  for (const r of runs(text, fonts)) {
    parts.push(pathData(r.font.getPath(r.text, cursor, baseline, size, { kerning: true }).commands));
    cursor += r.font.getAdvanceWidth(r.text, size, { kerning: true });
  }
  return parts.join(" ");
}
