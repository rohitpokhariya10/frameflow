/** Redmi-style creative built entirely with Sharp/SVG. No provider assets or requests. */
import sharp from 'sharp';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';

export const CURATION_CANVAS = { width: 512, height: 512 };
const background = '<rect width="512" height="512" fill="#edf8f3"/><path d="M0 440L512 390V512H0Z" fill="#ffffff"/>';
const person = '<circle cx="155" cy="205" r="28" fill="#ca976d"/><path d="M120 235H185L210 330L185 375H110L100 310Z" fill="#335f8f"/><path d="M125 360L210 370L235 425H210L170 397H115Z" fill="#48334d"/>';
const held = '<rect x="176" y="246" width="23" height="44" rx="3" fill="#db7843"/>';
const phone = '<rect x="335" y="180" width="100" height="220" rx="13" fill="#205b54"/><rect x="342" y="190" width="86" height="198" rx="9" fill="#9bddca"/><circle cx="357" cy="207" r="9" fill="#183333"/>';
const headline = '<path d="M45 48H145V61H45ZM45 68H190V81H45Z" fill="#23463f"/>';
const parts = [
  { name: 'Layer 0', svg: '' },
  { name: 'Scene plate', svg: background },
  { name: 'Seated model', svg: person, type: 'person', id: 'seated_model' },
  { name: 'Held phone', svg: held, type: 'product', id: 'held_phone' },
  { name: 'Translucent oversized-phone shadow', svg: '<ellipse cx="385" cy="403" rx="67" ry="17" fill="#194a40" opacity=".22"/>' },
  { name: 'Oversized phone product', svg: phone, type: 'product', id: 'oversized_phone' },
  { name: 'Headline outline', svg: headline.replaceAll('#23463f', '#508575').replace('M45 48', 'M43 46'), type: 'text outline', id: 'headline_outline' },
  { name: 'Headline', svg: headline, type: 'text', id: 'headline' },
  { name: 'Pro badge', svg: '<rect x="210" y="49" width="47" height="30" rx="6" fill="#224c42"/>', type: 'badge', id: 'pro_badge' },
  { name: 'Chinese secondary text', svg: '<path d="M45 108H110V114H45ZM45 121H125V127H45Z" fill="#32534c"/>', type: 'text', id: 'secondary_text' },
  { name: 'Fallback helper', svg: '' },
  { name: 'Layer 12', svg: '<rect x="470" y="470" width="3" height="3" fill="#000" opacity=".025"/>' },
  { name: 'Duplicate phone product', svg: phone },
];
const png = (svg: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${svg}</svg>`)).png().toBuffer();
export async function curationFixture() {
  const source = await png(background + parts.slice(2, 10).map(p => p.svg).join(''));
  const layers = await Promise.all(parts.map(async (p, i) => ({ name: p.name, png: i === 0 ? source : await png(p.svg) })));
  const elements: SemanticElement[] = parts.filter(p => p.id).map((p, i) => ({ id: p.id!, type: p.type!, description: p.name, editable_independently: true,
    approximate_region: 'creative', z_order: i + 1, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
    attachment: p.id === 'held_phone' ? { relation: 'held_in_hand', parent_id: 'seated_model', separation_risk: 'high', keep_with_parent: true }
      : { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } }));
  const semantic: SemanticAnalysis = { image_type: 'advertisement', scene_summary: 'Mint geometric phone advertisement with seated person, headline and badge.', elements,
    relationships: [{ source: 'seated_model', relationship: 'holding', target: 'held_phone' }], ambiguities: [], recommended_layer_count: elements.length,
    decomposition_strategy: 'Keep the grip intact and group headline effects.', downstream_decomposition_prompt: 'Separate useful people, products and text from the clean background.' };
  return { source, layers, semantic };
}
