/**
 * Deterministic test response only (unit tests and the offline browser fixture). Never imported by the live generation
 * path, and never real AI: every option is named "Mock · …" and says so in its direction.
 *
 * It follows the production style schema and answers from the request alone: every group of the master restyled in its
 * own place, the headline's largest line as the main face and its other lines as accents, plates recoloured, and a subtle
 * field tint per look (the looks follow the user's reference family: editorial, black, peach, lime, sky).
 */
import type { StructuredRequest } from '../ai/provider.js';
import type { MasterPlan, PlanVariation } from '../masterCreatives/plan.js';

interface Req {
  requested: { count: number };
  groups: { id: string; category: string; lines: { text: string; sizePx: number; behind: string }[]; plate: { id: string; color: string } | null }[];
  artwork: { fieldColour: string | null };
  fonts: { family: string; faces: { weight: string; italic: boolean }[] }[];
}
type Look = { name: string; idea: string; field: string | null; main: [string, number]; accent: [string, number, boolean]; body: [string, number]; ink: string; accentInk: string; plate: string; onPlate: string; align: 'left' | 'center'; upper: boolean; spacing: number; mainScale: number };
const LOOKS: Look[] = [
  { name: 'Editorial serif', idea: 'High-contrast serif headline with an italic accent, deep teal text.', field: null, main: ['DM Serif Display', 400], accent: ['Lora', 700, true], body: ['Lora', 600], ink: '#0b4a46', accentInk: '#0b4a46', plate: '#0b4a46', onPlate: '#f4f1c9', align: 'left', upper: false, spacing: 0, mainScale: 1 },
  { name: 'Bold black', idea: 'Heavy black grotesque headline with a serif italic accent, as in the black reference.', field: null, main: ['Archivo Black', 400], accent: ['Lora', 700, true], body: ['Poppins', 600], ink: '#111111', accentInk: '#111111', plate: '#111111', onPlate: '#e9f05a', align: 'left', upper: false, spacing: -0.01, mainScale: 1 },
  { name: 'Warm peach', idea: 'Peach field, teal grotesque headline and an italic serif accent.', field: '#fde2c3', main: ['Bricolage Grotesque', 700], accent: ['Lora', 700, true], body: ['Manrope', 700], ink: '#0e4f4a', accentInk: '#9a3412', plate: '#0e4f4a', onPlate: '#fde2c3', align: 'left', upper: false, spacing: 0, mainScale: 1.05 },
  { name: 'Lime condensed', idea: 'Lime field, tall condensed headline in capitals, forest green text.', field: '#e2f4a6', main: ['Anton', 400], accent: ['Outfit', 700, false], body: ['Outfit', 600], ink: '#1d4d2b', accentInk: '#1d4d2b', plate: '#1d4d2b', onPlate: '#e2f4a6', align: 'left', upper: true, spacing: 0.02, mainScale: 1.15 },
  { name: 'Soft sky', idea: 'Soft sky field, centred geometric headline, navy text.', field: '#d5ecf9', main: ['Sora', 700], accent: ['Sora', 600, false], body: ['Lexend', 400], ink: '#14305a', accentInk: '#1f5f9e', plate: '#14305a', onPlate: '#ffffff', align: 'center', upper: false, spacing: 0, mainScale: 1 },
];

export function mockMasterPlan(req: StructuredRequest): MasterPlan {
  const content = req.content.find(c => c.type === 'text');
  if (!content || content.type !== 'text') throw new Error('Missing test prompt.');
  // A correction request (text only, the problems and the previous answer): the mock answers it with the same styles, as
  // a model that cannot improve them would, so a still-failing option ends as a reported partial result.
  const previous = content.text.indexOf('Previous response:');
  if (!content.text.trimStart().startsWith('{') && previous >= 0) return JSON.parse(content.text.slice(previous + 'Previous response:'.length)) as MasterPlan;
  const data = JSON.parse(content.text) as Req;
  const face = (family: string, weight: number, italic = false) => {
    const faces = data.fonts.find(f => f.family === family)?.faces ?? [];
    const pool = faces.filter(f => f.italic === italic).length ? faces.filter(f => f.italic === italic) : faces.filter(f => !f.italic);
    const best = [...pool].sort((a, b) => Math.abs(Number(a.weight) - weight) - Math.abs(Number(b.weight) - weight))[0];
    return { fontFamily: family, fontWeight: (best?.weight ?? '400') as '400' | '600' | '700', italic: !!best?.italic };
  };
  const original = data.artwork.fieldColour ?? '#ffffff';
  const variations = Array.from({ length: data.requested.count }, (_, index): PlanVariation => {
    const look = LOOKS[index];
    const groups = data.groups.map(g => {
      const headline = g.category === 'headline', legal = g.category === 'legal', largest = Math.max(...g.lines.map(l => l.sizePx));
      return { groupId: g.id, align: legal ? 'left' as const : look.align, uppercase: headline && look.upper, letterSpacing: headline ? look.spacing : 0,
        lines: g.lines.map(l => {
          // On a plate, or on a dark part of the artwork (an old pill, say): light text.
          const main = headline && l.sizePx === largest, dark = /^#[0-9a-f]{6}$/i.test(l.behind) && [1, 3, 5].reduce((a, i) => a + parseInt(l.behind.slice(i, i + 2), 16), 0) < 300, onPlate = !!g.plate || dark;
          const f = main ? face(look.main[0], look.main[1]) : headline ? face(look.accent[0], look.accent[1], look.accent[2]) : legal ? face(look.body[0], 400) : face(look.body[0], look.body[1]);
          return { ...f, color: onPlate ? look.onPlate : headline && !main ? look.accentInk : look.ink, scale: main ? look.mainScale : headline ? 1.06 : 1 };
        }) };
    });
    const plates = data.groups.filter(g => g.plate).map(g => ({ plateId: g.plate!.id, color: look.plate }));
    return { name: `Mock · ${look.name}`, direction: `${look.idea} Deterministic test style ${index + 1}; not a real AI generation.`, field: look.field ?? original, groups, plates };
  });
  return { variations };
}
