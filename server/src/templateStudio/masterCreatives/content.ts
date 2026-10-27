/**
 * What of a saved master an AI design uses, and what it leaves out (local; no provider, no OCR):
 *
 *   words    the words of a line are joined as the poster draws them: when the next word starts where the previous
 *            one's advance ends (closer to that than to the advance with a space, measured with the word's own font
 *            file), they are one word. A scan or a review often splits a large heading ("EM" + "I" is "EMI").
 *   left out untouched placeholders (a text box drawn in review whose text was never changed from its default) and
 *            blank pictures (a crop of one plain colour): they would show as a stray "Text" or an empty box
 *
 * Every group and picture that remains must appear in every design; what is left out is reported to the user. Lines keep
 * their saved geometry (source pixels): a style variation restyles each line in its own place.
 */
import sharp from 'sharp';
import { drawableOfferStyle, isOfferFont, offerFace, type DetectedWord, type LogoSlot, type MasterSnapshot, type TextPlate } from '@frameflow/shared';
import { offerFontFile } from '../../textRecognition/fontMatch.js';

type Px = { x: number; y: number; width: number; height: number };
/** A line as the master draws it. `size`: share of the master's width; `px`: its saved geometry in source pixels. */
export interface ContentLine {
  text: string; fontFamily: string; fontWeight: number; italic: boolean; size: number; color: string;
  px: { size: number; baselineY: number; left: number; right: number; inkTop: number; inkBottom: number; wordIds: string[] };
}
export interface ContentGroup {
  id: string; category: string; text: string; lines: ContentLine[]; align: 'left' | 'center' | 'right';
  /** Share of the master's canvas. */
  box: { x: number; y: number; width: number; height: number } | null;
  /** The area its words take in the master, source pixels. */
  area: Px;
  /** The shape behind it in the master (a pill, a band), if any. */
  plate: TextPlate | null;
}
export interface ContentExclusion { kind: 'text' | 'image'; id: string; label: string; reason: string }
export interface MasterContent { groups: ContentGroup[]; slots: LogoSlot[]; excluded: ContentExclusion[] }

/** The review tool's default text for a box drawn by hand (ReviewWorkspace): left like that, it is a placeholder. */
const PLACEHOLDER = 'Text';
const placeholder = (w: DetectedWord) => w.origin === 'admin' && w.text.trim() === PLACEHOLDER && w.recognized?.text === PLACEHOLDER;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The advance of a word in its scanned style, source pixels; null when the font has no file here. */
function advanceOf(w: DetectedWord, text: string) {
  const family = isOfferFont(w.style.fontFamily) ? w.style.fontFamily : null;
  if (!family) return null;
  const style = drawableOfferStyle(family, w.style.fontWeight, w.style.fontStyle === 'italic'), face = offerFace(family, style.weight, style.italic ? 'italic' : 'normal');
  if (!face) return null;
  return offerFontFile(face).getAdvanceWidth(text, w.style.fontSize, { kerning: true }) + Math.max(0, [...text].length - 1) * (w.style.letterSpacing ?? 0);
}
/** The line's text with split words joined (see above). */
export function lineText(words: DetectedWord[]): string {
  let out = '';
  for (const [i, w] of words.entries()) {
    if (i === 0) { out = w.text; continue; }
    const prev = words[i - 1], origin = (x: DetectedWord) => x.box.x + (x.style.originDx ?? 0);
    const tight = advanceOf(prev, prev.text), spaced = advanceOf(prev, `${prev.text} `);
    const at = origin(w) - origin(prev), joined = tight !== null && spaced !== null && Math.abs(at - tight) < Math.abs(at - spaced) && /[\p{L}\p{N}]$/u.test(prev.text) && /^[\p{L}\p{N}]/u.test(w.text);
    out += joined ? w.text : ` ${w.text}`;
  }
  return out;
}

/** Whether a crop is one plain colour (every channel's spread under 4 levels): an empty picture. */
export async function blankCrop(png: Buffer): Promise<boolean> {
  const stats = await sharp(png).removeAlpha().stats();
  return stats.channels.every(c => c.stdev < 4);
}

export function masterContent(s: MasterSnapshot, blankSlots: ReadonlySet<string>): MasterContent {
  const excluded: ContentExclusion[] = [], W = s.canvas.width, H = s.canvas.height;
  const words = s.words.filter(w => w.review.status !== 'rejected');
  for (const w of words.filter(placeholder)) excluded.push({ kind: 'text', id: w.id, label: `“${w.text}”`, reason: 'a text box that was drawn but never filled in' });
  const usable = words.filter(w => !placeholder(w));
  const groups = s.groups.map(g => {
    const lines = g.lines.map(l => l.wordIds.map(id => usable.find(w => w.id === id)).filter((w): w is DetectedWord => !!w).sort((a, b) => a.box.x - b.box.x)).filter(ws => ws.length);
    const all = lines.flat(), x0 = Math.min(...all.map(w => w.box.x)), y0 = Math.min(...all.map(w => w.box.y));
    const x1 = Math.max(...all.map(w => w.box.x + w.box.width)), y1 = Math.max(...all.map(w => w.box.y + w.box.height));
    return {
      id: g.id, category: g.category ?? 'supporting', text: lines.map(lineText).join(' '), align: g.align,
      lines: lines.map(ws => {
        const size = Math.max(...ws.map(w => w.style.fontSize)), lead = ws.find(w => w.style.fontSize === size)!;
        return { text: lineText(ws), fontFamily: lead.style.fontFamily, fontWeight: lead.style.fontWeight, italic: lead.style.fontStyle === 'italic', size: round3(size / W), color: lead.style.color,
          px: { size, baselineY: Math.max(...ws.map(w => w.box.y + w.style.baseline)), left: Math.min(...ws.map(w => w.box.x)), right: Math.max(...ws.map(w => w.box.x + w.box.width)), inkTop: Math.min(...ws.map(w => w.box.y)), inkBottom: Math.max(...ws.map(w => w.box.y + w.box.height)), wordIds: ws.map(w => w.id) } };
      }),
      box: all.length ? { x: round3(x0 / W), y: round3(y0 / H), width: round3((x1 - x0) / W), height: round3((y1 - y0) / H) } : null,
      area: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      plate: s.plates.find(p => p.groupId === g.id && p.review.status !== 'rejected') ?? null,
    };
  }).filter(g => g.text) as ContentGroup[];
  const slots = s.logoSlots.filter(l => l.review.status !== 'rejected').filter(l => {
    if (!blankSlots.has(l.id)) return true;
    excluded.push({ kind: 'image', id: l.id, label: l.label, reason: 'an empty picture (one plain colour)' });
    return false;
  });
  return { groups, slots, excluded };
}
/** The slots whose picture is blank (read once per request). */
export async function blankSlotsOf(s: MasterSnapshot, read: (file: string) => Buffer): Promise<Set<string>> {
  const out = new Set<string>();
  for (const l of s.logoSlots.filter(x => x.review.status !== 'rejected')) if (await blankCrop(read(l.replacement?.file ?? l.original.file))) out.add(l.id);
  return out;
}
