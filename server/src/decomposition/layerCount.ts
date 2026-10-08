/**
 * The final output layers of a run, and the layer-name reading the protection and refinement steps share.
 *
 * Seedream is never asked for a layer count: it returns its natural semantic layers, and those are the output. Seedream
 * names layers in its own words ("Black power cable", "Floating orange spheres"); posterRole reads a role from such a
 * name (and the base's placement) for the steps that need one (interactionGrouping.ts, recursiveDecomposition.ts).
 */
import type { LayerInfo } from './layerizeArtifacts.js';

/** A final output layer; `sources` are the semantic layer files it was made from. */
export type OutputLayer = LayerInfo & { sources: string[] };
export type LayerCount = {
  /** Layers Seedream returned, and the semantic layers after local rendering. */
  providerReturnedLayers: number; semanticLayers: number; finalOutputLayers: number;
  groups: { name: string; file: string; sourceLayers: string[] }[];
  warnings: string[];
};
/** The run's output layers: its semantic layers, unchanged. */
export function normalizeLayerCount(layers: LayerInfo[]): { outputLayers: OutputLayer[]; layerCount: LayerCount } {
  const name = (l: LayerInfo) => l.name ?? (l.placement.kind === 'base' ? 'Base' : 'Layer');
  return { outputLayers: layers.map(l => ({ ...l, sources: [l.file] })), layerCount: { providerReturnedLayers: layers.filter(l => !l.rebuilt || l.rawFile).length, semanticLayers: layers.length,
    finalOutputLayers: layers.length, groups: layers.map(l => ({ name: name(l), file: l.file, sourceLayers: [l.file] })), warnings: [] } };
}

export type PosterRole = 'base' | 'background' | 'backdrop' | 'border' | 'support' | 'decor' | 'text' | 'product' | 'secondary' | 'unknown';
/** A name-level reading: a role, or a hint about its relation to a product (lighting effect, attached part, dish). */
type Hint = PosterRole | 'effect' | 'part' | 'container';

const words = (list: string) => new RegExp(`\\b(?:${list})\\b`, 'i');
const EFFECT = words('highlights?|reflections?|shadows?|glare|glow|shine|sheen|specular|gloss|flares?');
const TEXT = words('text|texts|headline|heading|title|caption|badge|label|logo|logotype|wordmark|price|slogan|tagline|typography|lettering|letters|words');
const BORDER = words('border|borders|frame|framing');
const BACKGROUND = words('background|wall|sky|studio|floor|gradient|scene');
const BACKDROP = words('backdrop|panel|card|board|colou?r ?block');
const DECOR = words('decor\\w*|ornament\\w*|graphics?|spheres?|orbs?|bubbles?|circles?|dots?|lines?|stripes?|grids?|stars?|starbursts?|sunbursts?|bursts?|rays?|sparkles?|confetti|patterns?|accents?|shapes?|waves?|swirls?|squiggles?|ovals?|ellipses?|triangles?|squares?|rectangles?|polygons?|geometric|blobs?|splash\\w*|motifs?');
const PRODUCT = words('main product|product|hero|main object|main item|centerpiece|centrepiece');
const SECONDARY = words('secondary|prop|props|accessory|accessories|companion');
const SUPPORT = words('support|pedestal|plinth|podium|platform|riser|stand|tabletop|countertop|shelf|slab|steps?|stairs|cube');
const CONTAINER = words('plate|bowl|dish|tray|platter|cup|mug|jar|basket|pan|pot|saucer');
const PART = words('cable|cord|wire|chain|rope|string|stem|shade|lampshade|bulb|canopy|cap|lid|handle|strap|buttons?|cameras?|lens|lenses|screen|case|body|legs?|arms?|feet|foot|knob|switch|plug|base|garnish|toppings?|sauce|crumbs?|pieces?|slices?|chunks?|bits|flakes?|sprinkles?|florets?|leaves|leaf|seeds?');
/** "Hero lamp on a white pedestal" is about the lamp: only the head, before a relation word, names the layer. */
export const head = (text: string) => text.split(/\b(?:with|including|plus|on|onto|over|under|beneath|below|above|beside|behind|around|against|in front of|near|next to|holding|supporting|inside|within|of the|for)\b/i)[0];

function nameHint(name: string): Hint {
  const h = head(name);
  if (EFFECT.test(h) && !PRODUCT.test(h)) return 'effect';
  if (TEXT.test(h)) return 'text';
  if (BORDER.test(h)) return 'border';
  if (BACKGROUND.test(h)) return 'background';
  if (BACKDROP.test(h)) return 'backdrop';
  if (DECOR.test(h)) return 'decor';
  if (PRODUCT.test(h)) return 'product';
  if (SECONDARY.test(h)) return 'secondary';
  if (SUPPORT.test(h)) return 'support';
  if (CONTAINER.test(h)) return 'container';
  if (PART.test(h)) return 'part';
  return 'unknown';
}
/** The clauses of a description that say what is in the layer: never those that exclude or only preserve something. */
const positiveClauses = (description: string) => description.split(/[.;:,]|\bbut\b/i).filter(c => !/\b(?:no|not|exclud\w*|without|except|avoid\w*|never|other than|keep out|preserve|keep its)\b/i.test(c));
/** Words that say how to extract or group rather than what is in a layer. */
const FILLER = new Set(['the', 'and', 'with', 'its', 'their', 'this', 'that', 'for', 'from', 'into', 'onto', 'one', 'layer', 'layers', 'extract', 'separate', 'separately', 'include', 'includes',
  'including', 'all', 'any', 'other', 'object', 'objects', 'only', 'each', 'keep', 'are', 'together', 'group', 'groups', 'grouped', 'whole', 'complete', 'entire', 'visible', 'original']);
export const layerWords = (name?: string, description?: string) =>
  new Set(([name ?? '', ...positiveClauses(description ?? '')].join(' ').toLowerCase().match(/\p{L}+/gu) ?? []).filter(word => word.length >= 3 && !FILLER.has(word)));
export const similarity = (a: Set<string>, b: Set<string>) => { let shared = 0; for (const word of a) if (b.has(word)) shared++; return shared / Math.max(1, a.size + b.size - shared); };
const HINT_ROLE: Record<Hint, PosterRole> = { base: 'base', background: 'background', backdrop: 'backdrop', border: 'border', support: 'support', decor: 'decor', text: 'text', product: 'product', secondary: 'secondary', unknown: 'unknown', effect: 'unknown', part: 'unknown', container: 'unknown' };
/** A layer's role from its placement and the provider's layer name alone. */
export const posterRole = (l: LayerInfo): PosterRole => l.placement.kind === 'base' ? 'base' : HINT_ROLE[nameHint(l.name ?? '')];
