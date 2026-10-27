/**
 * Before an AI design request: is the saved master complete? Scan Again's own reading of the original poster, run read
 * only (local OCR, crops discarded, nothing written, the master's counters untouched), compared with the published
 * revision: text the poster has and the master lacks is reported, with whether it is still part of the clean background
 * (the pixels there are the poster's own) or was removed from it.
 *
 *   still in the background  designs would show it as part of the artwork picture: the artwork is not offered
 *   removed                  it appears nowhere in a design
 *
 * Either way the master should be fixed first (Edit master → Scan Again); generating anyway needs an explicit choice.
 * One result per published revision and recognizer, kept in memory.
 */
import sharp from 'sharp';
import { boxIoU, rescanChanges, type MasterSnapshot, type ProtectedTemplate, type TextAnalysis } from '@frameflow/shared';
import type { WordRecognizer } from '../../textRecognition/recognizer.js';
import { scanPoster } from '../../decomposition/protectedTemplates/master/scan.js';
import { buildMasterAnalysis } from '../../decomposition/protectedTemplates/master/analysis.js';
import { decodeRgba } from '../../decomposition/protectedTemplates/pixels.js';

export interface MissingText { text: string; inBackground: boolean; box: { x: number; y: number; width: number; height: number } }
export interface MasterReadiness { missingText: MissingText[]; checkedAt: string; engine: string }
const cache = new Map<string, Promise<MasterReadiness>>();

/** Mean difference (0–255) between the poster and the clean background inside a box. */
async function difference(source: Buffer, background: Buffer, b: MissingText['box'], size: { width: number; height: number }) {
  const left = Math.max(0, Math.floor(b.x)), top = Math.max(0, Math.floor(b.y)), width = Math.max(1, Math.min(size.width - left, Math.ceil(b.width))), height = Math.max(1, Math.min(size.height - top, Math.ceil(b.height)));
  const [a, c] = await Promise.all([source, background].map(img => sharp(img).resize(size.width, size.height, { fit: 'fill' }).extract({ left, top, width, height }).removeAlpha().raw().toBuffer()));
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - c[i]);
  return sum / a.length;
}

export function masterReadiness(t: Pick<ProtectedTemplate, 'id' | 'source' | 'textAnalysis'>, s: MasterSnapshot, read: (file: string) => Buffer, recognizer: WordRecognizer): Promise<MasterReadiness> {
  const key = `${s.masterId}:${s.revision}:${s.source.sha256}:${recognizer.engine.name}:${recognizer.engine.version}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const bytes = read(t.source.inputFile), source = await decodeRgba(bytes), scan = await scanPoster(source, recognizer);
      const current = { ...t.textAnalysis!, words: s.words, groups: s.groups, logoSlots: s.logoSlots, plates: s.plates } as TextAnalysis;
      const result = await buildMasterAnalysis({ template: t, source, scan, recognizer, previous: current, store: () => undefined, at: new Date().toISOString() });
      // What the administrator already decided about (a word or picture there, kept or rejected) is not reported again.
      const decided = [...s.words.map(w => w.box), ...s.logoSlots.map(l => l.box)];
      const missing = rescanChanges(current, result.analysis).added.filter(a => /[\p{L}\p{N}]{2,}/u.test(a.text) && !decided.some(b => boxIoU(a.box, b) > 0.3));
      const background = read(s.background.file), size = { width: source.width, height: source.height }, out: MissingText[] = [];
      for (const m of missing) out.push({ text: m.text, box: { x: m.box.x, y: m.box.y, width: m.box.width, height: m.box.height }, inBackground: (await difference(bytes, background, m.box, size)) < 12 });
      return { missingText: out, checkedAt: new Date().toISOString(), engine: `${recognizer.engine.name} ${recognizer.engine.version}` };
    })();
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
