/**
 * A template's generation instructions (ProductGenerationBrief) and decomposition plan, written by FrameFlow from what
 * the template already holds — the AI detection's saved answer (its summary, each object's description), the reviewed
 * elements, the text and logos, the picture's own palette — with no request to any provider. The brief is marked
 * "derived" (never presented as the prompt the creative was made with). Variations are planned from it, so nobody has
 * to write a prompt; a person may edit it (then it is kept as edited).
 */
import type { PixelRect, ProductDecompositionPlan, ProductGenerationBrief, ProductObject, TextAnalysis } from '@frameflow/shared';
import { decomposesObject, PRODUCT_PREPARE_VERSION } from '@frameflow/shared';

/** What the detection's saved answer says (the parts used here). */
export interface DetectionAnswer { summary?: string; objects?: { id?: string; kind?: string; category?: string; description?: string; properties?: { key?: string; value?: string }[] }[]; lighting?: { direction?: string; quality?: string; color?: string } }

const where = (b: PixelRect, size: { width: number; height: number }) => {
  const cx = (b.x + b.width / 2) / size.width, cy = (b.y + b.height / 2) / size.height;
  const h = cx < 0.36 ? 'left' : cx > 0.64 ? 'right' : 'centre', v = cy < 0.36 ? 'top' : cy > 0.64 ? 'bottom' : 'middle';
  return v === 'middle' && h === 'centre' ? 'centre' : `${v} ${h}`.replace(' centre', '');
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ratioOf = (w: number, h: number) => { const g = (a: number, b: number): number => (b ? g(b, a % b) : a), k = g(w, h); const r = w / h; return Math.abs(r - 1) < 0.02 ? '1:1' : Math.abs(r - 0.8) < 0.02 ? '4:5' : Math.abs(r - 9 / 16) < 0.02 ? '9:16' : Math.abs(r - 16 / 9) < 0.02 ? '16:9' : `${w / k}:${h / k}`; };

export function deriveBrief(input: { name: string; canvas: { width: number; height: number }; objects: ProductObject[]; analysis?: TextAnalysis; answer?: DetectionAnswer; palette: string[]; at: string }): ProductGenerationBrief {
  const { canvas, answer } = input, live = input.objects.filter(o => !o.hidden);
  // An object's description: the answer's object whose category or description names it.
  const describe = (o: ProductObject) => {
    const l = norm(o.label), hit = (answer?.objects ?? []).find(a => (a.category && (norm(a.category) === l || l.includes(norm(a.category)) || norm(a.category).includes(l))) || (a.description && norm(a.description).includes(l)));
    return (hit?.description ?? o.label).slice(0, 200);
  };
  const characters = live.filter(o => o.kind === 'character').map(o => ({ label: o.label, description: describe(o) }));
  const products = live.filter(o => o.kind === 'product').map(o => ({ label: o.label, description: describe(o) }));
  // The background: what the answer saw of the scenery, then the decorations, then furniture (stands, counters), else the
  // elements' names.
  const rank = ['scenery', 'decoration', 'furniture'];
  const scenery = (answer?.objects ?? []).filter(a => rank.includes(a.kind ?? '')).sort((p, q) => rank.indexOf(p.kind!) - rank.indexOf(q.kind!)).map(a => a.description ?? a.category ?? '').filter(Boolean);
  const background = (scenery.length ? scenery : live.filter(o => o.kind === 'decoration' || o.kind === 'frame' || o.kind === 'podium').map(o => o.label)).slice(0, 8).join('; ').slice(0, 600) || 'a clean retail backdrop';
  const a = input.analysis, words = (id: string) => (a?.words ?? []).filter(w => w.groupId === id && w.review.status !== 'rejected').sort((p, q) => p.order - q.order).map(w => w.text).join(' ');
  const groupBox = (id: string): PixelRect | undefined => { const ws = (a?.words ?? []).filter(w => w.groupId === id && w.review.status !== 'rejected'); if (!ws.length) return undefined; const x = Math.min(...ws.map(w => w.box.x)), y = Math.min(...ws.map(w => w.box.y)); return { x, y, width: Math.max(...ws.map(w => w.box.x + w.box.width)) - x, height: Math.max(...ws.map(w => w.box.y + w.box.height)) - y }; };
  const copy = (a?.groups ?? []).map(g => ({ role: g.category ?? 'supporting', text: words(g.id) })).filter(c => c.text);
  const logos = (a?.logoSlots ?? []).filter(l => l.review.status !== 'rejected' && !l.inBackground).map(l => l.label.replace(/\s+logo$/i, ''));
  // Where things are (thirds of the canvas), for a layout that keeps the hierarchy.
  const layout: string[] = [];
  for (const c of live.filter(o => o.kind === 'character')) layout.push(`${c.label} at the ${where(c.box, canvas)}`);
  const ps = live.filter(o => o.kind === 'product');
  if (ps.length) { const x = Math.min(...ps.map(o => o.box.x)), y = Math.min(...ps.map(o => o.box.y)), b = { x, y, width: Math.max(...ps.map(o => o.box.x + o.box.width)) - x, height: Math.max(...ps.map(o => o.box.y + o.box.height)) - y };
    layout.push(`${ps.length} product${ps.length === 1 ? '' : 's'} at the ${where(b, canvas)}${live.some(o => o.kind === 'podium') ? ' on a stage' : ''}`); }
  for (const g of a?.groups ?? []) { const b = groupBox(g.id); if (b && (g.category === 'headline' || g.category === 'offer')) layout.push(`the ${g.category} at the ${where(b, canvas)}`); }
  const ls = (a?.logoSlots ?? []).filter(l => l.review.status !== 'rejected' && !l.inBackground && l.category !== 'brand-logo');
  if (ls.length) { const x = Math.min(...ls.map(l => l.box.x)), y = Math.min(...ls.map(l => l.box.y)); layout.push(`${ls.length} partner logos at the ${where({ x, y, width: Math.max(...ls.map(l => l.box.x + l.box.width)) - x, height: Math.max(...ls.map(l => l.box.y + l.box.height)) - y }, canvas)}`); }
  // Typography: the faces the text uses, by role.
  const faces = new Map<string, string>(); for (const g of a?.groups ?? []) { const w = (a?.words ?? []).find(x => x.groupId === g.id); if (w && !faces.has(g.category ?? 'supporting')) faces.set(g.category ?? 'supporting', `${w.style.fontFamily} ${w.style.fontWeight}`); }
  const typography = [...faces].map(([role, face]) => `${role}: ${face}`).join('; ') || 'the template’s own fonts';
  const light = answer?.lighting ? `${answer.lighting.quality ?? ''} ${answer.lighting.direction ?? ''} light`.trim() : '';
  const style = [answer?.summary ? answer.summary.split(/[.;]/)[0] : input.name, light].filter(Boolean).join('; ').slice(0, 300);
  const negative = 'No text, letters, numbers, words, logos, brand marks, products, appliances, people or characters in the artwork, and no watermark: the products, characters, text and logos are the template’s own layers, placed over it. Prices, offers, dates, bank names and legal text are never changed.';
  const prompt = [`Background artwork in the spirit of: ${background}.`, `Style: ${style}.`, `Palette: ${input.palette.join(', ')}.`, negative].join(' ');
  return { source: 'derived', subject: (answer?.summary ?? input.name).slice(0, 400), characters, products, brand: { logos, rules: 'Logos are kept exactly as they are, as their own layers; never redrawn.' },
    style, palette: input.palette, background, layout: layout.join('; ') || 'as the template', typography, copy, negative, aspectRatio: ratioOf(canvas.width, canvas.height), prompt, derivedAt: input.at };
}

/** The decomposition plan of a template as it is (what was chosen, kept and how), in plain words too. */
export function decompositionPlan(objects: ProductObject[], analysis: TextAnalysis | undefined, method: 'sam3' | 'local' | 'seedream'): ProductDecompositionPlan {
  const live = objects.filter(o => !o.hidden && o.kind !== 'brand-logo');
  const elements = live.map(o => ({ id: o.id, label: o.label, kind: o.kind, decompose: o.kind === 'podium' ? o.layer === 'own' : decomposesObject(o) }));
  const kept = (analysis?.logoSlots ?? []).filter(l => l.inBackground && l.review.status !== 'rejected').map(l => l.label);
  const words = (analysis?.words ?? []).filter(w => w.review.status !== 'rejected').length, blocks = (analysis?.groups ?? []).length, logos = (analysis?.logoSlots ?? []).filter(l => l.review.status !== 'rejected' && !l.inBackground).length;
  const cut = elements.filter(e => e.decompose).map(e => e.label), stay = elements.filter(e => !e.decompose).map(e => e.label);
  const instructions = [`Cut out as layers of their own: ${cut.join(', ') || 'nothing'}.`, stay.length ? `Kept in the background: ${stay.join(', ')}.` : '',
    `Text (${blocks} blocks, ${words} words) and ${logos} logos are taken off the picture as editable layers, never decomposed.`, kept.length ? `Kept in the picture: ${kept.join(', ')}.` : '',
    method === 'seedream' ? 'Decomposed with AI: the OpenAI planner wrote the instructions and Seedream Layerize split the picture without its text and logos; Seedream\'s background is used behind the elements it returned, the local cut-out for any it did not.'
      : `Cut-outs ${method === 'sam3' ? 'from the cut-out service' : 'made on this computer'}; the background rebuilt behind them from the scene's own structure where it has one.`].filter(Boolean).join(' ');
  return { elements, logosKeptInPicture: kept, overlays: { textBlocks: blocks, words, logos }, method, prepareVersion: PRODUCT_PREPARE_VERSION, instructions };
}
