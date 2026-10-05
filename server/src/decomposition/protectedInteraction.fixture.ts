/**
 * Deterministic people-and-interaction creatives for the protection tests (interactionGrouping.ts, semanticPlanner.ts):
 * a recharge offer with a woman holding a phone (fingers crossing it, a badge on its screen) and a bag held at her side,
 * and a jewelry offer with three pairs of hands wearing bangle stacks, a standalone bangle, a headline that names
 * bangles and small flower accents. Parts render on their own (complete, on transparency) and the creatives are the
 * parts painted back to front, so a fake Seedream answer can return any split, including the bad ones seen live.
 */
import sharp from 'sharp';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';

type Part = { key: string; name: string; svg: string };
const SKIN = '#d99a6c', svg = (body: string, w = 1024, h = 1024) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`);
const render = (body: string) => sharp(svg(body)).png().toBuffer();

const WOMAN_BODY = `<rect x="560" y="450" width="300" height="550" rx="60" fill="#f9a8d4"/><circle cx="710" cy="330" r="95" fill="${SKIN}"/><path d="M640 260 Q710 190 790 260 L800 520 L770 520 L760 300 Q710 260 660 300 L650 520 L620 520Z" fill="#3b2a1a"/>`;
/** The holding arm and the palm behind the phone. */
const WOMAN_ARM = `<path d="M600 520 L440 600 L460 640 L620 570Z" fill="${SKIN}"/><ellipse cx="425" cy="600" rx="48" ry="45" fill="${SKIN}"/>`;
/** The recharge offer, back to front. "fingers" cross the phone; "palm" is the hand behind it. */
export const HOLDING_PARTS: Part[] = [
  { key: 'background', name: 'Light studio background', svg: '<rect width="1000" height="1000" fill="#f3f4f6"/>' },
  { key: 'field', name: 'Bright yellow curved decorative field', svg: '<path d="M1000 0 L1000 1000 L520 1000 C700 760 760 420 1000 0Z" fill="#facc15"/>' },
  { key: 'woman', name: 'Woman base', svg: `${WOMAN_BODY}${WOMAN_ARM}` },
  { key: 'phone', name: 'Smartphone with white screen', svg: '<rect x="380" y="420" width="90" height="210" rx="14" fill="#111827"/><rect x="388" y="432" width="74" height="186" rx="10" fill="#f8fafc"/>' },
  { key: 'badge', name: 'Green success badge on the screen', svg: '<circle cx="425" cy="520" r="24" fill="#16a34a"/>' },
  { key: 'fingers', name: 'Foreground gripping finger fragments', svg: `<rect x="440" y="500" width="48" height="18" rx="9" fill="${SKIN}"/><rect x="440" y="540" width="52" height="18" rx="9" fill="${SKIN}"/><rect x="440" y="580" width="48" height="18" rx="9" fill="${SKIN}"/>` },
  { key: 'headline', name: 'Black headline text', svg: '<rect x="60" y="110" width="300" height="34" fill="#111111"/><rect x="60" y="160" width="260" height="34" fill="#111111"/>' },
  { key: 'pill', name: 'Navy rounded CTA pill', svg: '<rect x="60" y="760" width="280" height="70" rx="35" fill="#1e3a8a"/>' },
  { key: 'get', name: 'Small white GET text', svg: '<rect x="90" y="776" width="34" height="9" fill="#ffffff"/>' },
  { key: 'chevron', name: 'White CTA chevron', svg: '<path d="M300 784 L316 795 L300 806Z" fill="#ffffff"/>' },
];
/**
 * Seedream's own scene layer for the recharge offer, as returned live: the off-white field everywhere the yellow curve is
 * not, complete behind the woman (Seedream reconstructs the hidden scene in its scene layers).
 */
export const WHITE_FIELD_PART: Part = { key: 'whiteField', name: 'Full-canvas off-white background', svg: '<path d="M0 0 H1000 V1000 H0Z M1000 0 L1000 1000 L520 1000 C700 760 760 420 1000 0Z" fill="#f3f4f6" fill-rule="evenodd"/>' };
/** The same woman holding a bag by its handle at her side instead: nothing crosses it, a clean split. */
export const BAG_PART: Part = { key: 'bag', name: 'Purple shopping bag', svg: '<rect x="380" y="652" width="95" height="150" rx="8" fill="#7c3aed"/><path d="M400 652 L410 610 L440 610 L455 652" fill="none" stroke="#5b21b6" stroke-width="8"/>' };
/** The woman cut in two (what a residual pass or Seedream can return): her body, and her holding arm and hand on their own. */
export const WOMAN_BODY_PART: Part = { key: 'womanBody', name: 'Woman base', svg: WOMAN_BODY };
export const WOMAN_ARM_PART: Part = { key: 'womanArm', name: 'Left hand and forearm', svg: WOMAN_ARM };
/** The woman with her fingers drawn into her own layer (what Seedream returns when it makes no fragment layer). */
export const WOMAN_WITH_FINGERS: Part = { key: 'womanFingers', name: 'Woman base', svg: HOLDING_PARTS.find(p => p.key === 'woman')!.svg + HOLDING_PARTS.find(p => p.key === 'fingers')!.svg };

/** The jewelry offer, back to front: three pairs of forearms (80 wide), each wearing a bangle stack wider than the wrist. */
const forearms = (x: number) => `<rect x="${x}" y="380" width="80" height="600" rx="30" fill="${SKIN}"/>`;
/** Four gold bands, each 200 wide around an 80-wide wrist (x−60 to x+140), y 540–630. */
export const BANGLE_BANDS = ['#d4a017', '#eab308', '#ca8a04', '#d4a017'];
const bangles = (x: number) => BANGLE_BANDS.map((color, i) => `<rect x="${x - 60}" y="${540 + i * 24}" width="200" height="18" rx="9" fill="${color}"/>`).join('');
export const BANGLE_PARTS: Part[] = [
  { key: 'background', name: 'Deep red gradient background', svg: '<rect width="1000" height="1000" fill="#7f1d1d"/>' },
  { key: 'leftHands', name: 'Left paired hands', svg: forearms(150) },
  { key: 'leftBangles', name: 'Left Coorgi gold bangle stack', svg: bangles(150) },
  { key: 'centerHands', name: 'Center crossed hands', svg: forearms(460) },
  { key: 'centerBangles', name: 'Center South-Indian gold bangle cluster', svg: bangles(460) },
  { key: 'rightHands', name: 'Right paired hands', svg: forearms(770) },
  { key: 'rightBangles', name: 'Right Bengali gold bangle stack', svg: bangles(770) },
  { key: 'standalone', name: 'Standalone gold bangle product', svg: '<circle cx="880" cy="190" r="55" fill="none" stroke="#eab308" stroke-width="16"/>' },
  { key: 'headline', name: '"BANGLES OF INDIA" headline', svg: '<rect x="330" y="120" width="340" height="60" fill="#fbbf24"/>' },
  { key: 'flower1', name: 'Small red flower accent', svg: '<circle cx="320" cy="250" r="9" fill="#ef4444"/>' },
  { key: 'flower2', name: 'Small red flower accent', svg: '<circle cx="680" cy="250" r="9" fill="#ef4444"/>' },
  { key: 'flower3', name: 'Small red flower accent', svg: '<circle cx="500" cy="300" r="9" fill="#ef4444"/>' },
];

const all = (parts: Part[]) => parts;
export const partPng = (part: Part) => render(part.svg);
/** A creative: these parts painted back to front. */
export const creative = (parts: Part[]) => render(all(parts).map(p => p.svg).join(''));
export const part = (parts: Part[], key: string) => parts.find(p => p.key === key)!;

const element = (id: string, type: string, z: number, attachment: Partial<SemanticElement['attachment']> = {}, independent = true, occluded_by: string[] = []): SemanticElement => ({
  id, type, description: `${id.replace(/_/g, ' ')} as seen in the creative`, editable_independently: independent, approximate_region: 'see image', z_order: z, confidence: 'high',
  occlusion: { is_occluded: occluded_by.length > 0, occluded_by, requires_reconstruction: false },
  attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false, ...attachment } });
/**
 * The recharge offer as the old planner saw it live (Paytm run): the phone separate from the woman, the gripping
 * fingers as their own "occlusion fragment" layer, the badge separate. The model also rated the grip risky here.
 */
export const holdingAnalysis = (phoneRisk: 'low' | 'medium' | 'high' = 'high'): SemanticAnalysis => {
  const elements = [
    element('background_white', 'background', 0), element('yellow_field', 'background shape', 1), element('headline_text', 'text', 2), element('cta_pill', 'button shape', 3),
    element('woman_base', 'person', 4, {}, true, ['phone_device', 'phone_grip_foreground']),
    element('phone_device', 'product', 5, { relation: 'held_in_hand', parent_id: 'woman_base', separation_risk: phoneRisk }, true, ['success_badge', 'phone_grip_foreground']),
    element('success_badge', 'screen graphic', 6, { relation: 'part_of_object', parent_id: 'phone_device' }),
    element('phone_grip_foreground', 'person occlusion fragment', 7),
  ];
  return { image_type: 'offer creative', scene_summary: 'A woman holding a phone next to a recharge offer.', elements,
    relationships: [{ source: 'woman_base', relationship: 'holds', target: 'phone_device' }, { source: 'phone_grip_foreground', relationship: 'belongs_to', target: 'woman_base' },
      { source: 'phone_grip_foreground', relationship: 'in_front_of', target: 'phone_device' }, { source: 'success_badge', relationship: 'displayed_on', target: 'phone_device' }],
    ambiguities: ['The gripping fingers interleave with the phone.'], recommended_layer_count: elements.length, decomposition_strategy: 'Split the phone, its badge and the grip from the woman.',
    downstream_decomposition_prompt: 'Create 8 layers back-to-front: white background; yellow field; headline; CTA pill; woman base excluding the phone-crossing grip fragments; smartphone; success badge; foreground gripping finger fragments.' };
};
/** The jewelry offer as the old planner saw it live (Tanishq run): every bangle stack its own product layer, worn by its hands. */
export const bangleAnalysis = (): SemanticAnalysis => {
  const elements = [
    element('background_red', 'background', 0),
    element('left_hands', 'person_anatomy', 1), element('left_bangles', 'product', 2, { relation: 'worn_by_human', parent_id: 'left_hands', separation_risk: 'medium' }),
    element('center_hands', 'person_anatomy', 3), element('center_bangles', 'product', 4, { relation: 'worn_by_human', parent_id: 'center_hands', separation_risk: 'medium' }),
    element('right_hands', 'person_anatomy', 5), element('right_bangles', 'product', 6, { relation: 'worn_by_human', parent_id: 'right_hands', separation_risk: 'medium' }),
    element('standalone_bangle', 'product', 7), element('main_headline', 'headline_text', 8),
  ];
  return { image_type: 'jewelry offer', scene_summary: 'Three pairs of hands wearing bangles under a headline.', elements,
    relationships: [{ source: 'left_bangles', relationship: 'worn_by', target: 'left_hands' }, { source: 'center_bangles', relationship: 'worn_by', target: 'center_hands' }, { source: 'right_bangles', relationship: 'worn_by', target: 'right_hands' }],
    ambiguities: [], recommended_layer_count: elements.length, decomposition_strategy: 'Separate hands and bangle products.',
    downstream_decomposition_prompt: 'Create 9 layers: red background; left hands; left bangle stack; center hands; center bangle cluster; right hands; right bangle stack; standalone bangle; BANGLES OF INDIA headline.' };
};

/** A fake image edit that fails the way gpt-image-2 did live: the masked area comes back as a black silhouette. */
export async function blackSilhouetteEdit(image: Buffer, mask: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer(), out = Buffer.from(data);
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 128) out.fill(8, i * 3, i * 3 + 3);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}
/** A fake image edit that fills the masked area with one flat color (a seam across a curve, a placeholder). */
export async function flatEdit(image: Buffer, mask: Buffer, color: [number, number, number]): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer(), out = Buffer.from(data);
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 128) out.set(color, i * 3);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}
