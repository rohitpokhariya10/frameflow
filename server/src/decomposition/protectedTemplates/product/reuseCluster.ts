/**
 * Reuse Template's composition pass: the products judged and corrected as ONE showcase group (a retail offer's product
 * cluster), whoever proposed their boxes (the AI art director or the fixed rules). Free, on this computer, deterministic.
 *
 *   grounding   every product stands on the stage's top surface (its base inside the top's depth, nearer products lower)
 *   scale       sizes stay believable to each other (real heights, compressed as the rules do): a box far off that ratio
 *               is resized about its base; the main product's emphasis stays a little extra size, never a false size
 *   cluster     neighbouring silhouettes are drawn together around the main product (gaps closed down to a small,
 *               even breathing space; an overlap stays an overlap); the whole group is centred on the stage, inside the lane
 *   depth       a nearer product may overlap a farther one, but never hide much of it (it is moved aside until enough shows)
 *
 * Coordinates are canvas pixels of the creative (never screen pixels): correct at export size and at any zoom.
 */
import type { ReusePlacementBox } from '@frameflow/shared';
import { MAX_ENLARGE, sizeUnit, type PlacementInput } from './reusePlacement.js';

type Box = { x: number; y: number; width: number; height: number };
const area = (b: Box) => Math.max(0, b.width) * Math.max(0, b.height);
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** What the pass measured and changed (for the checks and the notes). */
export interface ClusterReport {
  /** The widest gap between neighbouring products before and after, as a share of the lane's width. */
  gapBefore: number; gapAfter: number;
  /** The group's width as a share of the lane, and how far its centre is off the stage's centre (share of the lane). */
  spread: number; offCentre: number;
  resized: string[]; grounded: string[]; separated: string[]; moved: boolean;
}

/**
 * `boxes`: one per product (the AI's or the rules'), `hero`: the main product's id. Returns new boxes (never the same
 * objects) and what changed.
 */
export function refineCluster(input: PlacementInput, boxes: ReusePlacementBox[], hero?: string): { boxes: ReusePlacementBox[]; notes: string[]; report: ClusterReport } {
  const out = boxes.map(b => ({ ...b })), { stage, lane } = input, laneW = Math.max(1, lane.x1 - lane.x0), notes: string[] = [];
  const report: ClusterReport = { gapBefore: 0, gapAfter: 0, spread: 0, offCentre: 0, resized: [], grounded: [], separated: [], moved: false };
  if (!out.length) return { boxes: out, notes, report };
  const product = (id: string) => input.products.find(p => p.id === id);
  const label = (id: string) => product(id)?.label ?? id;
  const main = out.find(b => b.id === hero) ?? [...out].sort((a, b) => area(b) - area(a))[0];
  // Grounding: the base on the top surface (a little behind its middle for the farthest, a little in front for the nearest).
  const zs = [...new Set(out.map(b => b.z))].sort((a, b) => a - b);
  for (const b of out) {
    const bottom = b.y + b.height, lo = stage.cy - stage.b * 0.75, hi = stage.cy + stage.b * 0.85;
    if (bottom >= lo && bottom <= hi) continue;
    const depth = zs.length > 1 ? zs.indexOf(b.z) / (zs.length - 1) : 0.5, want = stage.cy + stage.b * (-0.3 + 0.8 * depth);
    b.y = Math.round(want - b.height); report.grounded.push(label(b.id));
  }
  // Scale: each product's height against the main one's, as their real sizes say (allowing the main product its emphasis
  // and the proposer a generous margin); far off, resized about its base.
  const unit = (id: string) => sizeUnit(product(id)?.category ?? '');
  for (const b of out) {
    if (b === main) continue;
    const expected = main.height * (unit(b.id) / unit(main.id)) / (unit(main.id) >= unit(b.id) ? 1.12 : 1), ratio = b.height / Math.max(1, expected);
    if (ratio <= 1.6 && ratio >= 1 / 1.6) continue;
    const h = Math.round(expected * (ratio > 1 ? 1.25 : 0.8)), aspect = b.width / Math.max(1, b.height), foot = b.x + b.width / 2, bottom = b.y + b.height;
    Object.assign(b, { x: Math.round(foot - (h * aspect) / 2), y: bottom - h, width: Math.round(h * aspect), height: h });
    report.resized.push(label(b.id));
  }
  // The room used: a group whose tallest product stands well below the text (a timid proposal) is enlarged together, so
  // the tallest reaches about nine tenths of the room — as far as the lane's width allows (with some overlap).
  const tallest = out.reduce((m, b) => (b.height > m.height ? b : m), out[0]), room = tallest.y + tallest.height - input.ceiling;
  const grow = Math.min((room * 0.92) / Math.max(1, tallest.height), (laneW * 0.95) / Math.max(1, out.reduce((w, b) => w + b.width, 0) * 0.85));
  if (tallest.height < room * 0.7 && grow > 1.05) {
    for (const b of out) { const foot = b.x + b.width / 2, bottom = b.y + b.height, h = Math.round(b.height * grow), w = Math.round(b.width * grow); Object.assign(b, { x: Math.round(foot - w / 2), y: bottom - h, width: w, height: h }); }
    notes.push('The products were enlarged together to use the stage (they stood far below the text).');
  }
  // Never above the room under the text, never beyond a picture's sharpness: the whole group smaller together (each
  // about its base), so the sizes stay true to each other.
  const fit = Math.min(1, ...out.map(b => (b.y + b.height - input.ceiling) / Math.max(1, b.height)), ...out.map(b => { const px = product(b.id)?.pixels; return px ? (px.height * MAX_ENLARGE) / Math.max(1, b.height) : 1; }));
  if (fit < 0.999) for (const b of out) { const foot = b.x + b.width / 2, bottom = b.y + b.height, h = Math.round(b.height * fit), w = Math.round(b.width * fit); Object.assign(b, { x: Math.round(foot - w / 2), y: bottom - h, width: w, height: h }); }
  // Cluster: outwards from the main product, each neighbour no farther than a small breathing space from the group.
  const breathing = Math.round(Math.max(laneW * 0.012, Math.min(...out.map(b => b.width)) * 0.06));
  const gaps = () => { const s = [...out].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2)); let g = 0; let edge = -Infinity; for (const b of s) { if (edge > -Infinity) g = Math.max(g, b.x - edge); edge = Math.max(edge, b.x + b.width); } return g; };
  report.gapBefore = Math.round((gaps() / laneW) * 1000) / 1000;
  const centre = (b: Box) => b.x + b.width / 2;
  const right = out.filter(b => b !== main && centre(b) >= centre(main)).sort((a, b) => centre(a) - centre(b));
  const left = out.filter(b => b !== main && centre(b) < centre(main)).sort((a, b) => centre(b) - centre(a));
  let reach = main.x + main.width;
  for (const b of right) { const excess = b.x - (reach + breathing); if (excess > 0) b.x -= excess; reach = Math.max(reach, b.x + b.width); }
  reach = main.x;
  for (const b of left) { const excess = reach - breathing - (b.x + b.width); if (excess > 0) b.x += excess; reach = Math.min(reach, b.x); }
  // Depth: a nearer product hides at most 40 % of a farther one (it steps aside, away from the farther one's middle).
  for (let round = 0; round < 3; round++) for (const near of out) for (const far of out) {
    if (near === far || near.z <= far.z) continue;
    const hidden = inter(near, far) / Math.max(1, area(far));
    if (hidden <= 0.4) continue;
    const dir = centre(near) >= centre(far) ? 1 : -1, need = Math.ceil(far.width * (hidden - 0.38));
    near.x += dir * need; if (!report.separated.includes(label(near.id))) report.separated.push(label(near.id));
  }
  // The group centred on the stage, inside the lane (as far as it fits).
  const gx0 = Math.min(...out.map(b => b.x)), gx1 = Math.max(...out.map(b => b.x + b.width)), half = (gx1 - gx0) / 2;
  const want = laneW >= gx1 - gx0 ? Math.min(lane.x1 - half, Math.max(lane.x0 + half, stage.cx)) : (gx0 + gx1) / 2, dx = Math.round(want - (gx0 + gx1) / 2);
  for (const b of out) { b.x += dx; b.x = Math.min(input.canvas.width - b.width, Math.max(0, b.x)); b.y = Math.min(input.canvas.height - b.height, Math.max(0, b.y)); }
  report.gapAfter = Math.round((gaps() / laneW) * 1000) / 1000;
  const fx0 = Math.min(...out.map(b => b.x)), fx1 = Math.max(...out.map(b => b.x + b.width));
  report.spread = Math.round(((fx1 - fx0) / laneW) * 1000) / 1000;
  report.offCentre = Math.round((Math.abs((fx0 + fx1) / 2 - stage.cx) / laneW) * 1000) / 1000;
  report.moved = out.some((b, i) => Math.abs(b.x - boxes[i].x) > 2 || Math.abs(b.y - boxes[i].y) > 2 || Math.abs(b.height - boxes[i].height) > 2);
  if (report.gapBefore - report.gapAfter > 0.02) notes.push(`The products were drawn together into one group (the widest gap between them went from ${Math.round(report.gapBefore * 100)}% to ${Math.round(report.gapAfter * 100)}% of the stage).`);
  if (report.resized.length) notes.push(`Resized to believable sizes beside the main product: ${report.resized.join(', ')}.`);
  if (report.grounded.length) notes.push(`Set down on the stage: ${report.grounded.join(', ')}.`);
  if (report.separated.length) notes.push(`Moved aside so the product behind stays visible: ${report.separated.join(', ')}.`);
  return { boxes: out, notes, report };
}
