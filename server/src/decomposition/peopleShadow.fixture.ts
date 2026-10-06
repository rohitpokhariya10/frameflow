/**
 * Deterministic people-with-shadows creatives for the clean-background and layer-usefulness tests, modelled on the bad
 * cases seen live: a person on a plain red studio field casting a soft drop shadow and a contact shadow (Seedream's base
 * kept a blurred ghost of him), and a person in a pink studio interior where Seedream returned a complete scene plate
 * over a flat grey placeholder base, sometimes with an invented grey panel behind her. Parts render on their own
 * (complete, on transparency); a creative is its parts painted back to front, so a fake Seedream answer can return any
 * split and any base.
 */
import sharp from 'sharp';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';

export type Part = { key: string; name: string; svg: string };
const SKIN = '#d99a6c';
const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`);
const render = (body: string) => sharp(svg(body)).png().toBuffer();
const blur = (id: string, std: number) => `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${std}"/></filter></defs>`;

/** The man: white shirt, head, dark hair. His silhouette is reused for the shadow and the ghost. */
const MAN_SHAPE = '<rect x="400" y="430" width="220" height="570" rx="50"/><circle cx="510" cy="330" r="80"/>';
/** The red studio offer, back to front. */
export const RED_PARTS: Part[] = [
  { key: 'background', name: 'Red studio background', svg: '<defs><linearGradient id="red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c62828"/><stop offset="1" stop-color="#a51d1d"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#red)"/>' },
  // A soft drop shadow up and to the right of him, and a contact shadow at his feet, both multiplying the red.
  { key: 'shadow', name: 'Soft cast shadow of the man', svg: `${blur('drop', 22)}<g filter="url(#drop)" fill="#000" fill-opacity="0.42" transform="translate(55 25)">${MAN_SHAPE}</g>${blur('contact', 10)}<ellipse cx="520" cy="992" rx="210" ry="26" fill="#000" fill-opacity="0.5" filter="url(#contact)"/>` },
  { key: 'man', name: 'Man in white shirt', svg: `<rect x="400" y="430" width="220" height="570" rx="50" fill="#f8fafc"/><circle cx="510" cy="330" r="80" fill="${SKIN}"/><path d="M432 300 Q510 220 588 300 L586 270 Q510 200 434 270Z" fill="#2b1d14"/>` },
  { key: 'headline', name: 'White SUMMER SALE headline text', svg: '<rect x="60" y="90" width="300" height="40" fill="#ffffff"/><rect x="60" y="145" width="240" height="40" fill="#ffffff"/>' },
  { key: 'cta', name: 'Yellow SHOP NOW button', svg: '<rect x="60" y="820" width="230" height="64" rx="32" fill="#facc15"/>' },
];
/** A blurred darker silhouette where the man was: Seedream's inpainting left a ghost of him in its base. */
export const GHOST_PART: Part = { key: 'ghost', name: 'ghost', svg: `${blur('ghost', 14)}<g filter="url(#ghost)" fill="#000" fill-opacity="0.32">${MAN_SHAPE}</g>` };
/** A shadow stain on the red field that no subject casts (top right). */
export const STAIN_PART: Part = { key: 'stain', name: 'Dark shadow smudge', svg: `${blur('stain', 12)}<ellipse cx="850" cy="170" rx="70" ry="40" fill="#000" fill-opacity="0.38" filter="url(#stain)"/>` };
/** An opaque grey panel Seedream invented behind the man (it never existed in the creative). */
export const GREY_PANEL_PART: Part = { key: 'greyPanel', name: 'Grey background panel', svg: '<rect x="350" y="390" width="330" height="610" fill="#9ca3af"/>' };

/** The pink studio interior, back to front: wall, skirting, floor and an arch window; a woman in navy with a floor shadow. */
const STUDIO_SCENE = '<rect width="1000" height="640" fill="#f4c2cf"/><rect y="640" width="1000" height="360" fill="#d9969f"/><rect y="630" width="1000" height="10" fill="#c47f8a"/><path d="M120 520 L120 260 Q250 120 380 260 L380 520Z" fill="#fde4ea"/>';
export const STUDIO_PARTS: Part[] = [
  { key: 'studio', name: 'Pink studio interior backdrop', svg: STUDIO_SCENE },
  { key: 'floorShadow', name: 'floor shadow', svg: `${blur('floor', 8)}<ellipse cx="660" cy="982" rx="150" ry="20" fill="#000" fill-opacity="0.35" filter="url(#floor)"/>` },
  { key: 'woman', name: 'Woman in navy dress', svg: `<rect x="560" y="420" width="200" height="560" rx="60" fill="#1e3a8a"/><circle cx="660" cy="330" r="78" fill="${SKIN}"/><path d="M584 300 Q660 220 736 300 L734 270 Q660 200 586 270Z" fill="#3b2a1a"/>` },
  { key: 'headline', name: 'Dark NEW COLLECTION headline text', svg: '<rect x="600" y="80" width="340" height="40" fill="#3f1d2b"/><rect x="640" y="135" width="300" height="30" fill="#3f1d2b"/>' },
];
/** Seedream's placeholder base: flat grey everywhere, the real scene being its plate layer. */
export const GREY_BASE_PART: Part = { key: 'greyBase', name: 'Background', svg: '<rect width="1000" height="1000" fill="#9ca3af"/>' };
/** A grey panel Seedream invented behind the woman, partly visible around her. */
export const STUDIO_FILLER_PART: Part = { key: 'filler', name: 'Grey filler panel', svg: '<rect x="520" y="380" width="280" height="620" fill="#9ca3af"/>' };
/** A grey block exactly inside the woman's silhouette: never visible in the design. */
export const HIDDEN_SLAB_PART: Part = { key: 'slab', name: 'Grey background block', svg: '<rect x="590" y="460" width="140" height="480" fill="#9ca3af"/>' };

export const partPng = (part: Part) => render(part.svg);
/** A creative: these parts painted back to front. */
export const creative = (parts: Part[]) => render(parts.map(p => p.svg).join(''));
export const part = (parts: Part[], key: string) => parts.find(p => p.key === key)!;

/**
 * A fake image edit that leaves a soft ghost: the masked area comes back as the (pre-filled) input dimmed to 72%, the
 * same hue a little darker, like the blurred silhouettes gpt-image-2 was seen leaving. Not black, not a foreign color.
 */
export async function ghostEdit(image: Buffer, mask: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer(), out = Buffer.from(data);
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 128) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(data[i * 3 + c] * 0.72);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

const element = (id: string, type: string, z: number): SemanticElement => ({ id, type, description: `${id.replace(/_/g, ' ')} as seen in the creative`, editable_independently: true,
  approximate_region: 'see image', z_order: z, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
  attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } });
const analysis = (summary: string, elements: SemanticElement[], prompt: string): SemanticAnalysis => ({ image_type: 'offer creative', scene_summary: summary, elements, relationships: [], ambiguities: [],
  recommended_layer_count: elements.length, decomposition_strategy: 'Separate the person, the text and the button from the background.', downstream_decomposition_prompt: prompt });
/** The red studio offer as a planner sees it: background, the man, the headline and the button. */
export const redAnalysis = () => analysis('A man in a white shirt on a red studio background next to a sale headline.',
  [element('red_background', 'background', 0), element('man', 'person', 1), element('headline_text', 'text', 2), element('shop_now_button', 'button shape', 3)],
  'Create 4 layers back-to-front: red studio background; man in white shirt; white SUMMER SALE headline text; yellow SHOP NOW button.');
/** The pink studio as a planner sees it: the interior, the woman and the headline. */
export const studioAnalysis = () => analysis('A woman in a navy dress standing in a pink studio interior under a headline.',
  [element('studio_interior', 'background', 0), element('woman', 'person', 1), element('headline_text', 'text', 2)],
  'Create 3 layers back-to-front: pink studio interior backdrop; woman in navy dress; dark NEW COLLECTION headline text.');
