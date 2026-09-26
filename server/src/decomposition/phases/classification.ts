import type { ElementClassification, ElementKind, ProposalReviewTarget, ProposalSummary } from '@frameflow/shared';

/**
 * Scene element classification decides the reconstruction route for each reviewed target:
 * IMAGE_OBJECT → source segmentation (SAM), TEXT → text reconstruction, SHAPE → vector geometry,
 * BACKGROUND → preserved background layer, UNKNOWN → stays reviewable (the user must choose).
 *
 * An explicit user type always wins. Otherwise wording from the provider name (then description) is used; conflicting
 * or missing evidence on a discovered element yields UNKNOWN rather than a guess. Targets the user created, grouped or
 * named up front express "isolate this" intent and default to IMAGE_OBJECT.
 */
const TEXT = /\b(text|texts|headline|headlines|title|heading|caption|label|labels|signature|paragraph|copy|wordmark|typography|slogan|tagline|lettering|letters|words?|quote|price)\b/i;
const SHAPE = /\b(panel|rectangle|rectangular|square|circle|circular|ellipse|oval|bar|banner|line|divider|shape|frame|border|badge|card|button|pill|stripe|box|blob|gradient block)\b/i;
const BACKGROUND = /\b(background|backdrop|wallpaper|sky|scenery|environment)\b/i;
const OBJECT = /(\b(person|woman|women|man|men|girl|boy|people|child|face|hand|hands|body|figure|model|bottle|car|dog|cat|animal|device|laptop|shoe|shoes|bag|handbag|cup|mug|plant|flower|food|chair|table|watch|camera|headphones)\b|phone)/i;

const ROLE_KIND: Record<ProposalReviewTarget['role'], ElementKind | undefined> = { object: 'IMAGE_OBJECT', foreground: 'IMAGE_OBJECT', text: 'TEXT', shape: 'SHAPE', background: 'BACKGROUND', unknown: undefined };
export const KIND_ROLE: Record<Exclude<ElementKind, 'UNKNOWN'>, ProposalReviewTarget['role']> = { IMAGE_OBJECT: 'object', TEXT: 'text', SHAPE: 'shape', BACKGROUND: 'background' };

function kindsIn(text: string): ElementKind[] {
  const kinds: ElementKind[] = [];
  if (OBJECT.test(text)) kinds.push('IMAGE_OBJECT');
  // Words describing a product/person are still text: text evidence overrides object nouns.
  if (TEXT.test(text)) { kinds.push('TEXT'); if (kinds[0] === 'IMAGE_OBJECT') kinds.shift(); }
  if (SHAPE.test(text)) kinds.push('SHAPE');
  // "background panel" describes a shape; background only stands alone.
  if (BACKGROUND.test(text) && !kinds.includes('SHAPE') && !kinds.includes('TEXT')) kinds.push('BACKGROUND');
  return kinds;
}

export function classifyTarget(target: ProposalReviewTarget, proposals: ProposalSummary[] = []): ElementClassification {
  if (target.baseLayer) return { kind: 'BACKGROUND', confidence: 'high', source: 'base-layer', reasons: ['DISCOVERED_BASE_LAYER'] };
  const explicit = ROLE_KIND[target.role];
  if (explicit) return { kind: explicit, confidence: 'user', source: 'user-role', reasons: [`USER_ROLE_${target.role.toUpperCase()}`] };
  const operation = target.provenance?.operation;
  if (target.groupMode === 'group' || operation === 'user-group') return { kind: 'IMAGE_OBJECT', confidence: 'medium', source: 'user-intent', reasons: ['USER_GROUPED_OBJECT'] };
  const members = proposals.filter(p => target.proposalIds.includes(p.id));
  const names = [target.label, ...members.map(p => p.label)].join(' | ');
  const descriptions = [target.description ?? '', ...members.map(p => p.description ?? '')].join(' | ');
  const byName = kindsIn(names);
  if (byName.length === 1) return { kind: byName[0], confidence: 'medium', source: 'provider-label', reasons: [`NAME_SUGGESTS_${byName[0]}`] };
  if (byName.length > 1) return { kind: 'UNKNOWN', confidence: 'low', source: 'provider-label', reasons: ['CONFLICTING_NAME_EVIDENCE', ...byName.map(k => `NAME_SUGGESTS_${k}`)] };
  const byDescription = kindsIn(descriptions);
  if (byDescription.length === 1) return { kind: byDescription[0], confidence: 'low', source: 'provider-description', reasons: [`DESCRIPTION_SUGGESTS_${byDescription[0]}`] };
  if (operation === 'target-label' || operation === 'user-created' || operation === 'user-split')
    return { kind: 'IMAGE_OBJECT', confidence: 'low', source: 'user-intent', reasons: ['USER_REQUESTED_ISOLATION', ...(byDescription.length > 1 ? ['CONFLICTING_DESCRIPTION_EVIDENCE'] : [])] };
  return { kind: 'UNKNOWN', confidence: 'low', source: 'default', reasons: byDescription.length > 1 ? ['CONFLICTING_DESCRIPTION_EVIDENCE', ...byDescription.map(k => `DESCRIPTION_SUGGESTS_${k}`)] : ['NO_TYPE_EVIDENCE'] };
}
