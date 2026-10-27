/**
 * Reuse Template: a creative of a saved revision laid out again for an output format, never stretched.
 *
 *   template       the template's own canvas
 *   slice          a narrower format: the artwork at its own size, a full-height window of it. A decoration painted into
 *                  the background (flowers, a badge) is wholly inside the window or wholly outside it, never cut in two;
 *                  what is outside the window is not shown (reported).
 *   mirror-extend  a wider format: the whole artwork scaled to the height, its outer side strips continued by mirrored
 *                  copies of the template's own pixels (reported as an estimate, never passed off as new artwork)
 *
 * Elements move with the artwork (the same transform), then are re-anchored where the format cut them off: header logos
 * to their corner, rows of partner logos re-flowed to the width, text groups re-wrapped to the width (fitGroup, their
 * words still their own texts), the character smaller in a narrow format, at its own side, standing on its feet line.
 * A text group that belonged to a decoration left outside the window (a badge's words) is hidden with it.
 */
import sharp, { type OverlayOptions } from 'sharp';
import { reuseCanvasFor, textBounds, type MeasureText, type ProductCreative, type ProductCreativeBackground, type ReuseAspectRatio, type SourceSize } from '@frameflow/shared';
import { fitGroup } from './composition.js';
import { fontMeasure } from './ratioLayout.js';

export type Box = { x: number; y: number; width: number; height: number };
export interface ReuseFrame {
  ratio: ReuseAspectRatio; source: SourceSize; canvas: SourceSize; method: 'template' | 'slice' | 'mirror-extend';
  /** Template pixels to canvas pixels: x' = (x - x0) * scale + pad, y' = y * scale. */
  scale: number; x0: number; pad: number;
  /** Mirror-extend: the widths of the outer strips (left, right) of the scaled artwork mirrored outwards. */
  strip: number; stripRight: number;
  /** Decorations of the background left outside a slice (their labels). */
  excluded: string[]; filledPercent: number; note?: string;
}
export interface Decoration { id: string; label: string; box: Box }

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The frame of a format: how the template's artwork fills its canvas. */
export function planFrame(source: SourceSize, ratio: ReuseAspectRatio, decorations: Decoration[] = [], avoid: Box[] = decorations.map(d => d.box)): ReuseFrame {
  const canvas = reuseCanvasFor(source, ratio);
  const none: ReuseFrame = { ratio, source, canvas, method: 'template', scale: 1, x0: 0, pad: 0, strip: 0, stripRight: 0, excluded: [], filledPercent: 0 };
  if (canvas.width === source.width && canvas.height === source.height) return none;
  const scale = canvas.height / source.height, visible = canvas.width / scale;
  if (visible <= source.width + 0.5) {
    const max = source.width - visible, centre = max / 2;
    const cut = (x0: number) => decorations.filter(d => d.box.x < x0 + visible && d.box.x + d.box.width > x0 && (d.box.x < x0 - 0.5 || d.box.x + d.box.width > x0 + visible + 0.5));
    // The nearest window to the centre that cuts no decoration in two (each one either wholly in or wholly out).
    const candidates = [centre, ...decorations.flatMap(d => [d.box.x, d.box.x + d.box.width, d.box.x + d.box.width - visible, d.box.x - visible])]
      .map(x => Math.round(Math.min(max, Math.max(0, x)))).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
    const x0 = candidates.find(x => !cut(x).length) ?? Math.round(centre);
    const excluded = decorations.filter(d => d.box.x + d.box.width <= x0 + 0.5 || d.box.x >= x0 + visible - 0.5).map(d => d.label);
    const cutNow = cut(x0).map(d => d.label);
    return { ...none, method: 'slice', scale, x0, excluded,
      note: `Shows the middle ${Math.round(visible / source.width * 100)} % of the template's artwork at its own size (nothing stretched).${excluded.length ? ` Not in this format: ${excluded.join(', ')}.` : ''}${cutNow.length ? ` Cut at the edge: ${cutNow.join(', ')}.` : ''}` };
  }
  // Each side strip: at most a tenth of the artwork, never reaching a decoration, logo or text in the artwork (where a
  // badge or its words were, the background is an estimate: it is never mirrored).
  const width = Math.round(source.width * scale), pad = Math.floor((canvas.width - width) / 2);
  const leftEnd = Math.max(source.width * 0.03, Math.min(source.width * 0.1, ...avoid.filter(b => b.x < source.width * 0.3).map(b => b.x - 4)));
  const rightStart = Math.min(source.width * 0.97, Math.max(source.width * 0.9, ...avoid.filter(b => b.x + b.width > source.width * 0.7).map(b => b.x + b.width + 4)));
  const strip = Math.max(8, Math.round(Math.min(pad, leftEnd * scale))), stripRight = Math.max(8, Math.round(Math.min(pad, (source.width - rightStart) * scale)));
  const filledPercent = Math.round((canvas.width - width) / canvas.width * 1000) / 10;
  return { ...none, method: 'mirror-extend', scale, pad, strip, stripRight, filledPercent,
    note: `The artwork is scaled to the height; ${filledPercent} % of the width (the sides) continues the template's own outer artwork by mirroring it — an estimate to check, not new artwork.` };
}

/** The background of a frame, made from the template's prepared base (no new pixels are invented; mirrored sides are flagged). */
export async function frameBackground(basePng: Buffer, frame: ReuseFrame): Promise<Buffer> {
  const { canvas, source, scale } = frame;
  if (frame.method === 'template') return sharp(basePng).ensureAlpha().png().toBuffer();
  const scaled = scale === 1 ? sharp(basePng).ensureAlpha() : sharp(basePng).ensureAlpha().resize(Math.round(source.width * scale), canvas.height, { fit: 'fill' });
  if (frame.method === 'slice') return (await sharp(await scaled.png().toBuffer()).extract({ left: Math.round(frame.x0 * scale), top: 0, width: canvas.width, height: canvas.height }).png().toBuffer());
  const art = await scaled.png().toBuffer(), width = Math.round(source.width * scale), strip = frame.strip, stripRight = frame.stripRight || strip;
  const left = await sharp(art).extract({ left: 0, top: 0, width: strip, height: canvas.height }).png().toBuffer();
  const right = await sharp(art).extract({ left: width - stripRight, top: 0, width: stripRight, height: canvas.height }).png().toBuffer();
  const parts: OverlayOptions[] = [{ input: art, left: frame.pad, top: 0 }];
  // Outwards from each edge: the strip mirrored, then as it is, alternately (a continuous reflection, no seam jump).
  const tile = async (bytes: Buffer, flip: boolean) => (flip ? sharp(bytes).flop().png().toBuffer() : bytes);
  for (let k = 0, x = frame.pad - strip; x > -strip; k++, x -= strip) parts.push({ input: await tile(left, k % 2 === 0), left: x, top: 0 });
  for (let k = 0, x = frame.pad + width; x < canvas.width; k++, x += stripRight) parts.push({ input: await tile(right, k % 2 === 0), left: x, top: 0 });
  // Composite clips at the canvas: the outermost tiles are cropped first (sharp refuses overlays outside the image).
  const clipped = await Promise.all(parts.map(async p => {
    const meta = await sharp(p.input as Buffer).metadata(), l = p.left as number, w = meta.width!;
    if (l >= 0 && l + w <= canvas.width) return p;
    const from = Math.max(0, -l), to = Math.min(w, canvas.width - l);
    return { input: await sharp(p.input as Buffer).extract({ left: from, top: 0, width: Math.max(1, to - from), height: canvas.height }).png().toBuffer(), left: Math.max(0, l), top: 0 };
  }));
  return sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(clipped).png().toBuffer();
}

export const mapX = (f: ReuseFrame, x: number) => (x - f.x0) * f.scale + f.pad;
export const mapBox = (f: ReuseFrame, b: Box): Box => ({ x: mapX(f, b.x), y: b.y * f.scale, width: b.width * f.scale, height: b.height * f.scale });
export const backgroundOf = (f: ReuseFrame): Pick<ProductCreativeBackground, 'method' | 'filledPercent'> => ({ method: f.method, filledPercent: f.filledPercent });

/** A creative in template coordinates moved into the frame (every element through the same transform). */
export function mapCreative(c: ProductCreative, f: ReuseFrame): ProductCreative {
  if (f.method === 'template') return c;
  const s = f.scale;
  return { ...c, canvas: { ...f.canvas },
    texts: c.texts.map(t => ({ ...t, x: mapX(f, t.x), baselineY: t.baselineY * s, style: { ...t.style, fontSize: t.style.fontSize * s, letterSpacing: t.style.letterSpacing * s } })),
    images: c.images.map(i => ({ ...i, box: { ...i.box, ...mapBox(f, i.box) } })),
    shapes: c.shapes.map(sh => ({ ...sh, box: { ...sh.box, ...mapBox(f, sh.box) }, radius: sh.radius * s, ...(sh.stroke ? { stroke: { ...sh.stroke, width: sh.stroke.width * s } } : {}) })),
    objects: c.objects.map(o => ({ ...o, box: { ...o.box, ...mapBox(f, o.box) } })) };
}

/** The bounds of a group's visible words. */
export function groupBounds(c: ProductCreative, groupId: string, measure: MeasureText = fontMeasure): Box | undefined {
  const words = c.texts.filter(t => t.groupId === groupId && !t.hidden && t.text.trim());
  if (!words.length) return undefined;
  const boxes = words.map(t => textBounds(t, measure)), x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}

/**
 * The frame's elements re-anchored where it cut them off (a template frame is left as it is). `art`: the template's
 * artwork rows (between its plain header and footer), template pixels. `decorations`: those of the background.
 */
export function reanchor(c: ProductCreative, f: ReuseFrame, art: { top: number; bottom: number }, decorations: Decoration[], areas: Map<string, { box: Box; align: 'left' | 'center' }> = new Map(), dropped: string[] = [], measure: MeasureText = fontMeasure): ProductCreative {
  if (f.method === 'template') return c;
  const W = f.canvas.width, H = f.canvas.height, m = Math.round(Math.max(16, W * 0.035)), top = art.top * f.scale, bottom = art.bottom * f.scale;
  let out: ProductCreative = { ...c };
  // A text group (a badge's words) that belongs to a decoration left outside the window is hidden with it.
  const gone = decorations.filter(d => f.excluded.includes(d.label)).map(d => mapBox(f, d.box));
  for (const g of out.groups) {
    const b = groupBounds(out, g.id, measure);
    if (b && gone.some(d => overlap(b, d) >= 0.5 * b.width * b.height)) out = { ...out, texts: out.texts.map(t => (t.groupId === g.id ? { ...t, hidden: true } : t)) };
  }
  // A slice leaves out what was mostly outside its window (a badge beside the stage, its words): hidden, and reported.
  // The headline, offer and legal text are never left out (they are re-wrapped below); header and footer logos are re-placed.
  if (f.method === 'slice') {
    const inside = (b: Box) => overlap(b, { x: 0, y: 0, width: W, height: H }) / Math.max(1, b.width * b.height);
    out = { ...out, images: out.images.map(i => {
      const centre = i.box.y + i.box.height / 2;
      if (i.hidden || centre < top || centre > bottom || inside(i.box) >= 0.5) return i;
      dropped.push(i.label); return { ...i, hidden: true };
    }) };
    for (const g of out.groups) {
      if (['headline', 'offer', 'legal', 'cta'].includes(g.category)) continue;
      const b = groupBounds(out, g.id, measure);
      if (b && inside(b) < 0.5) { dropped.push(`the text “${g.label.slice(0, 40)}”`); out = { ...out, texts: out.texts.map(t => (t.groupId === g.id ? { ...t, hidden: true } : t)) }; }
    }
  }
  // Header logos to their corner; a pair that would meet in a narrow canvas made smaller (each at most 40 % of the width).
  const header = out.images.filter(i => !i.hidden && i.box.y + i.box.height / 2 < top);
  // In the white band above the artwork (beside it there is no room in a narrow format), each in its corner.
  const cap = header.length > 1 ? 0.36 : 0.6, band = Math.max(top, H * 0.04), maxH = Math.max(H * 0.03, band - 2 * Math.max(8, band * 0.1));
  const images = new Map(out.images.map(i => [i.id, i]));
  for (const i of header) {
    const k = Math.min(1, (W * cap) / Math.max(1, i.box.width), maxH / Math.max(1, i.box.height)), width = i.box.width * k, height = i.box.height * k;
    const leftSide = (i.box.x + i.box.width / 2 - f.pad) / f.scale + f.x0 < f.source.width / 2;
    images.set(i.id, { ...i, box: { ...i.box, x: leftSide ? m : W - m - width, y: Math.max(4, (band - height) / 2), width, height } });
  }
  // Footer logos re-flowed in rows across the width (reading order kept), smaller only when one is wider than the canvas.
  // Reading order: rows (logos whose middles are within half a logo's height of each other), each left to right.
  const unsorted = out.images.filter(i => !i.hidden && i.box.y + i.box.height / 2 > bottom), tol = Math.max(4, Math.min(...unsorted.map(i => i.box.height), Infinity) / 2);
  const rowOf = (i: (typeof unsorted)[number]) => Math.round((i.box.y + i.box.height / 2) / Math.max(1, tol * 2));
  const footer = [...unsorted].sort((a, b) => rowOf(a) - rowOf(b) || a.box.x - b.box.x);
  if (footer.length && footer.some(i => i.box.x < m || i.box.x + i.box.width > W - m)) {
    // Rows from where the logos start down to the next text below them (a validity line) or the canvas edge.
    const start = Math.min(...footer.map(i => i.box.y)), gap = Math.max(8, W * 0.02);
    // A line of text below (on a pill painted round it): its padding kept clear too.
    const below = out.groups.map(g => groupBounds(out, g.id, measure)).filter((b): b is Box => !!b && b.y > start + 1).map(b => b.y - b.height * 0.6);
    const limit = Math.min(H - m, ...below) - gap * 0.6;
    const flow = (k: number) => {
      const rows: (typeof footer)[] = [[]];
      let used = 0;
      for (const i of footer) { const w = i.box.width * k; if (rows.at(-1)!.length && used + gap + w > W - 2 * m) { rows.push([]); used = 0; } used += (rows.at(-1)!.length ? gap : 0) + w; rows.at(-1)!.push(i); }
      return { rows, height: rows.reduce((h, r) => h + Math.max(...r.map(i => i.box.height * k)) + gap * 0.6, -gap * 0.6) };
    };
    let k = Math.min(1, (W - 2 * m) / Math.max(...footer.map(i => i.box.width))), plan = flow(k);
    while (k > 0.2 && plan.height > limit - start) { k *= 0.92; plan = flow(k); }
    const rows = plan.rows;
    let y = start;
    for (const row of rows) {
      const widths = row.map(i => i.box.width * k), total = widths.reduce((a, b) => a + b, 0) + gap * (row.length - 1), h = Math.max(...row.map(i => i.box.height * k));
      let x = (W - total) / 2;
      row.forEach((i, n) => { images.set(i.id, { ...i, box: { ...i.box, x, y: y + (h - i.box.height * k) / 2, width: widths[n], height: i.box.height * k } }); x += widths[n] + gap; });
      y += h + gap * 0.6;
    }
  }
  for (const [key, i] of images) if (!header.includes(i) && !footer.includes(i)) images.set(key, { ...i, box: { ...i.box, x: Math.min(W - i.box.width, Math.max(0, i.box.x)), y: Math.min(H - i.box.height, Math.max(0, i.box.y)) } });
  out = { ...out, images: out.images.map(i => images.get(i.id) ?? i) };
  // Text groups wider than the canvas re-wrapped across it, in their own area (the template's, in this frame): a little
  // taller as the width shrinks (a quarter at most: a headline stays on its plate), smaller when they must.
  for (const g of out.groups) {
    const b = groupBounds(out, g.id, measure);
    if (!b || (b.x >= m && b.x + b.width <= W - m)) continue;
    const own = areas.get(g.id), zone = own ? mapBox(f, own.box) : b, width = W - 2 * m, grow = Math.min(1.25, Math.max(1, zone.width / width));
    out = fitGroup(out, g.id, { x: m, y: zone.y, width, height: zone.height * grow }, own?.align ?? (g.align === 'left' ? 'left' : 'center'), 1, measure);
  }
  // The character: in a slice it stands at its own side, as large as the narrower format allows, on its feet line.
  if (f.method === 'slice') {
    out = { ...out, objects: out.objects.map(o => {
      if (o.kind !== 'character' || o.hidden) return o;
      const leftSide = (o.box.x + o.box.width / 2) / f.scale + f.x0 < f.source.width / 2;
      const k = Math.min(1, (W * 0.36) / Math.max(1, o.box.width)), width = o.box.width * k, height = o.box.height * k, feet = Math.min(H - 2, o.box.y + o.box.height);
      return { ...o, box: { ...o.box, x: leftSide ? Math.round(W * 0.012) : Math.round(W - width - W * 0.012), y: Math.round(feet - height), width: Math.round(width), height: Math.round(height) } };
    }) };
  }
  return out;
}

/** The artwork rows of a base (between its plain header and footer rows), template pixels. */
export async function artRows(basePng: Buffer): Promise<{ top: number; bottom: number }> {
  const { data, info } = await sharp(basePng).removeAlpha().resize({ width: 256 }).raw().toBuffer({ resolveWithObject: true });
  const plain = (y: number) => {
    const row = Array.from({ length: info.width }, (_, x) => [0, 1, 2].map(c => data[(y * info.width + x) * 3 + c]));
    const med = [0, 1, 2].map(c => row.map(p => p[c]).sort((a, b) => a - b)[row.length >> 1]);
    return row.filter(p => Math.max(...p.map((v, c) => Math.abs(v - med[c]))) <= 14).length >= row.length * 0.985;
  };
  // The artwork: the longest run of rows that are not plain (a pill or a line painted into a white footer is not artwork).
  let top = 0, bottom = info.height, best = -1;
  for (let y = 0; y < info.height;) {
    if (plain(y)) { y++; continue; }
    let end = y; while (end < info.height && !plain(end)) end++;
    if (end - y > best) { best = end - y; top = y; bottom = end; }
    y = end;
  }
  const k = info.width / (await sharp(basePng).metadata()).width!;
  return { top: Math.floor(top / k), bottom: Math.ceil(bottom / k) };
}
