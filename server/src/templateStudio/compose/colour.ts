/** WCAG relative luminance and contrast helpers. */

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: Rgb) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

export function luminance([r, g, b]: Rgb) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a translucent colour over a background. */
export function blend(top: Rgb, opacity: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => top[i] * opacity + bottom[i] * (1 - opacity)) as Rgb;
}
