/**
 * How an object stands in its creative, read from its own cutout mask (no model call): the long axis of the mask's shape
 * gives its lean. Only a mask gives a trustworthy reading — a box also holds its neighbours, and a box-based guess once
 * read a phone leaning right as upright — so poses are read only where a product was cut out (a layered edit's first
 * pass), and only a clearly elongated shape speaks. Anything unclear says nothing: the prompt then asks for "the same tilt
 * as the original", which the model sees in the image it edits.
 */
export type PoseReading = { elongation: number; tilt: number; side: 'left' | 'right' };

/** The lean of one mask (white = the object), or undefined when its shape does not show one clearly. */
export function maskPose(mask: Uint8Array, width: number, height: number, reading?: (r: PoseReading) => void): string | undefined {
  const step = Math.max(1, Math.round(Math.max(width, height) / 400));
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    if (mask[y * width + x] < 128) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 50) return undefined;
  const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const half = (cxx + cyy) / 2, root = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy), elongation = Math.sqrt((half + root) / Math.max(1e-6, half - root));
  // The long axis, pointing up (image y grows downward): its top leans right when its x grows going up.
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let vx = Math.cos(angle), vy = Math.sin(angle);
  if (vy > 0) { vx = -vx; vy = -vy; }
  const tilt = Math.atan2(Math.abs(vx), Math.abs(vy)) * 180 / Math.PI, side = vx > 0 ? 'right' as const : 'left' as const;
  reading?.({ elongation: Math.round(elongation * 100) / 100, tilt: Math.round(tilt * 10) / 10, side });
  if (elongation < 1.6 || tilt > 60) return undefined; // a squat or lying shape has no lean to speak of
  if (tilt < 4) return 'upright';
  return `leaning with its top to the ${side}${elongation >= 2 ? `, about ${Math.max(5, Math.round(tilt / 5) * 5)}°` : ''}`;
}
