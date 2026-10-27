import sharp from 'sharp';
import { offerFace, type CreativeImage, type CreativeInstance, type CreativeShape, type CreativeText } from '@frameflow/shared';
import { offerFontFile, wordMetrics } from '../../textRecognition/fontMatch.js';
import type { ProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import { pathData } from '../compose/text.js';

type Box = { x: number; y: number; width: number; height: number };
/** A rotation about a point, only when there is one (unrotated content keeps its exact earlier markup). */
const turn = (deg: number, x: number, y: number) => (deg ? ` transform="rotate(${deg} ${x} ${y})"` : '');
/** One text as SVG paths, shifted by (dx, dy): Konva's drawing (each character followed by the letter spacing; without spacing the line whole, with kerning), rotated about its origin. */
export function textSvg(t: CreativeText, dx = 0, dy = 0): string {
  const font = offerFontFile(offerFace(t.style.fontFamily, t.style.fontWeight, t.style.fontStyle)!), x0 = t.x - dx, y0 = t.baselineY - dy;
  let svg = '';
  if (t.style.letterSpacing) { let x = x0; for (const ch of t.text) { svg += `<path d="${pathData(font.getPath(ch, x, y0, t.style.fontSize).commands)}" fill="${t.style.color}"/>`; x += font.getAdvanceWidth(ch, t.style.fontSize) + t.style.letterSpacing; } }
  else svg = `<path d="${pathData(font.getPath(t.text, x0, y0, t.style.fontSize, { kerning: true }).commands)}" fill="${t.style.color}"/>`;
  const g = t.rotation ? `<g${turn(t.rotation, x0, y0)}>${svg}</g>` : svg;
  return t.style.opacity < 1 ? `<g opacity="${t.style.opacity}">${g}</g>` : g;
}
/** The horizontal ink of an unrotated text exactly as textSvg draws it (each glyph at its advance plus the spacing; else
 * the whole text with kerning), or null for a blank. textInk overstates it when the letters are closed up. */
export function textInkExact(t: CreativeText): { x: number; width: number; y: number; height: number } | null {
  const font = offerFontFile(offerFace(t.style.fontFamily, t.style.fontWeight, t.style.fontStyle)!);
  let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
  // (The path's points, its curves' control points included: at most a hair wider than the curve itself.)
  const add = (path: { commands: { x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[] }) => {
    for (const c of path.commands) for (const [x, y] of [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]]) if (x !== undefined && y !== undefined) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  };
  if (t.style.letterSpacing) { let x = t.x; for (const ch of t.text) { add(font.getPath(ch, x, t.baselineY, t.style.fontSize)); x += font.getAdvanceWidth(ch, t.style.fontSize) + t.style.letterSpacing; } }
  else add(font.getPath(t.text, t.x, t.baselineY, t.style.fontSize, { kerning: true }));
  return x2 > x1 ? { x: x1, width: x2 - x1, y: y1, height: y2 - y1 } : null;
}
/** The ink rectangle of a text (canvas pixels; the rotated outline's bounds when it is rotated), or null for a blank. */
export function textInk(t: CreativeText): Box | null {
  const font = offerFontFile(offerFace(t.style.fontFamily, t.style.fontWeight, t.style.fontStyle)!), width = t.style.letterSpacing ? [...t.text].reduce((w, ch) => w + font.getAdvanceWidth(ch, t.style.fontSize) + t.style.letterSpacing, 0) : font.getAdvanceWidth(t.text, t.style.fontSize, { kerning: true });
  const b = wordMetrics(font, t.text, t.style.fontSize).bounds;
  if (!b || b.x2 <= b.x1) return null;
  const pts = [[Math.min(b.x1, 0), b.y1], [Math.max(b.x2, width), b.y1], [Math.min(b.x1, 0), b.y2], [Math.max(b.x2, width), b.y2]], a = (t.rotation * Math.PI) / 180;
  const xs = pts.map(([x, y]) => t.x + x * Math.cos(a) - y * Math.sin(a)), ys = pts.map(([x, y]) => t.baselineY + x * Math.sin(a) + y * Math.cos(a));
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
/** A shape (rounded rectangle, optional outline), shifted by (dx, dy), rotated about its centre. */
export function shapeSvg(s: CreativeShape, dx = 0, dy = 0): string {
  const b = s.box, x = b.x - dx, y = b.y - dy, stroke = s.stroke ? ` stroke="${s.stroke.color}" stroke-width="${s.stroke.width}"` : '';
  return `<rect x="${x}" y="${y}" width="${b.width}" height="${b.height}" rx="${Math.min(s.radius, b.width / 2, b.height / 2)}" fill="${s.fill}"${stroke}${turn(b.rotation, x + b.width / 2, y + b.height / 2)}/>`;
}
/** A picture fitted without stretching in its box, shifted by (dx, dy), rotated about its centre. */
export async function imageSvg(i: CreativeImage, bytes: Buffer, dx = 0, dy = 0): Promise<string> {
  const data = await sharp(bytes).png().toBuffer(), b = i.box, x = b.x - dx, y = b.y - dy;
  return `<image x="${x}" y="${y}" width="${b.width}" height="${b.height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${data.toString('base64')}"${turn(b.rotation, x + b.width / 2, y + b.height / 2)}/>`;
}
/** An SVG body drawn on a transparent canvas of this size. */
export const svgPng = (width: number, height: number, body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toBuffer();

/**
 * Initial full-size image, rendered from the same editable elements that the browser opens. Fonts become SVG paths.
 * `pending`: pictures made for this creative that are not stored yet (they are written only after every option rendered).
 */
export async function renderMasterCreative(c:CreativeInstance, store:ProtectedStore, pending:Map<string,Buffer>=new Map()):Promise<Buffer> {
  const {width,height}=c.canvas;
  const content:{z:number;svg:string}[]=[];
  for(const s of c.shapes) if(!s.hidden) content.push({z:s.z,svg:shapeSvg(s)});
  for(const i of c.images) {
    if(i.hidden) continue;
    content.push({z:i.z,svg:await imageSvg(i,pending.get(i.asset.file)??store.read(c.masterId,i.asset.file))});
  }
  for(const t of c.texts) if(!t.hidden&&t.text.trim()) content.push({z:t.z,svg:textSvg(t)});
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${c.backgroundColor??'#ffffff'}"/>${content.sort((a,b)=>a.z-b.z).map(x=>x.svg).join('')}</svg>`)).png().toBuffer();
}
