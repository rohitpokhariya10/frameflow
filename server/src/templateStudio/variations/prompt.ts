/**
 * What the image model receives for a style variation, and nothing else:
 *
 *   image 1   the protected template's approved text-free base (its words and logos already removed)
 *   image 2   a wordless guide of the same canvas: grey, with white dashed boxes where the template's text and logos sit
 *   prompt    the preset's art direction, any extra instructions, the guide's meaning and the no-text rule (last, absolute)
 *
 * Neither image contains a letter or a logo, and no copy, brand or partner name is ever written into the prompt, so the
 * model has nothing to copy into the artwork. Deterministic: the same inputs always give the same prompt.
 */
import sharp from 'sharp';
import { boundingBox, type SourceBox, type SourceSize, type StylePreset, type TextAnalysis } from '@frameflow/shared';
import { NO_TEXT_RULE } from '../compose/imagePrompt.js';

export const STYLE_VARIATION_PROMPT_VERSION = 'style-variation/1';
/** The image model's largest standard sizes; a variation keeps the template's aspect inside them (sides multiples of 16). */
const PORTRAIT = { width: 1024, height: 1536 }, LANDSCAPE = { width: 1536, height: 1024 }, SQUARE = { width: 1024, height: 1024 };
export function providerSizeFor(canvas: SourceSize): { width: number; height: number; size: string } {
  const aspect = canvas.width / canvas.height, box = aspect > 1.05 ? LANDSCAPE : aspect < 0.95 ? PORTRAIT : SQUARE;
  const s = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = Math.max(256, Math.floor((canvas.width * s) / 16) * 16), height = Math.max(256, Math.floor((canvas.height * s) / 16) * 16);
  return { width, height, size: `${width}x${height}` };
}

const MAX_GUIDE_SIDE = 1024;
/** The areas text and logos occupy in the template: one box per phrase line and per logo slot, in source pixels. */
export function reservedAreas(analysis: TextAnalysis): SourceBox[] {
  const words = new Map(analysis.words.filter(w => w.review.status !== 'rejected').map(w => [w.id, w]));
  const lines = analysis.groups.flatMap(g => g.lines.map(l => l.wordIds.map(id => words.get(id)).filter(w => !!w)))
    .filter(ws => ws.length).map(ws => {
      const b = ws.map(w => boundingBox(w!.box)), x = Math.min(...b.map(r => r.x)), y = Math.min(...b.map(r => r.y));
      return { x, y, width: Math.max(...b.map(r => r.x + r.width)) - x, height: Math.max(...b.map(r => r.y + r.height)) - y, rotation: 0 };
    });
  return [...lines, ...analysis.logoSlots.filter(l => l.review.status !== 'rejected').map(l => ({ ...boundingBox(l.box), rotation: 0 }))];
}
/** The wordless guide (PNG, at most 1024 px on its long side, same aspect as the canvas): no letters, no logos. */
export async function renderVariationGuide(canvas: SourceSize, areas: SourceBox[]): Promise<Buffer> {
  const s = Math.min(1, MAX_GUIDE_SIDE / Math.max(canvas.width, canvas.height)), W = Math.round(canvas.width * s), H = Math.round(canvas.height * s);
  const dash = Math.max(4, Math.round(W / 120)), stroke = Math.max(2, Math.round(W / 300)), pad = Math.round(Math.min(W, H) * 0.006);
  const rects = areas.map(a => `<rect x="${Math.round(a.x * s) - pad}" y="${Math.round(a.y * s) - pad}" width="${Math.max(1, Math.round(a.width * s) + 2 * pad)}" height="${Math.max(1, Math.round(a.height * s) + 2 * pad)}" fill="#ffffff" fill-opacity="0.85" stroke="#8a9099" stroke-width="${stroke}" stroke-dasharray="${dash} ${dash}"/>`);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#d6d9de"/>${rects.join('')}</svg>`)).png().toBuffer();
}

export interface VariationPromptInput { preset: Pick<StylePreset, 'id' | 'name' | 'direction' | 'palette' | 'mood'>; customInstructions?: string | null; take: number; takes: number }
export function compileVariationPrompt(input: VariationPromptInput): string {
  const { preset } = input, lines: string[] = [];
  lines.push('Restyle the attached poster artwork (image 1) into a new design for the same advertising creative.');
  lines.push(`ART DIRECTION (${preset.name}): ${preset.direction}`);
  if (preset.palette.length) lines.push(`Palette: ${preset.palette.join(', ')}. Mood: ${preset.mood}.`);
  if (input.customInstructions?.trim()) lines.push(`ADDITIONAL DIRECTION FROM THE DESIGNER (visual style only): ${input.customInstructions.trim()}`);
  if (input.takes > 1) lines.push(`This is take ${input.take} of ${input.takes} in this direction: choose a clearly different arrangement and treatment of the decorative elements from the other takes.`);
  lines.push('LAYOUT GUIDE (image 2): the same canvas. Each white dashed box marks where existing text or a logo will be placed on top of your artwork later. Keep the composition so that those areas stay calm, simple and uncluttered (plain colour, soft texture or a simple panel), with enough contrast for text laid over them. Do not draw frames, outlines or boxes for them, and do not put objects, people or busy patterns inside them.');
  lines.push('Keep the same canvas, aspect ratio and overall placement of large shapes and panels as image 1, so the text and logos still fit where they were.');
  lines.push('Never draw logos, brand marks, bank or card names, partner badges, seals, QR codes, prices, numbers or legal text: all of them are added later as separate layers.');
  lines.push('', NO_TEXT_RULE);
  return lines.join('\n');
}
