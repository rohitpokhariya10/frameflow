/**
 * "Generate creative template", integrated rendering: every variant is ONE finished advertising image, made by the image
 * model from (a) clean reference cutouts of the products the creative keeps and (b) this variant's own creative
 * direction. The products are re-rendered inside the scene (lit by it, grounded in it, posed for its camera) instead of
 * their old pixels being pasted on top, so the result reads as one photograph, not a cutout on a new background.
 *
 * What stays, what varies, and why variants differ:
 *   - what stays consistent: each product's identity (design, shape, colours, materials, its own markings), from its
 *     reference cutout, or the identity the user asked for instead (then nothing of the old product's brand may remain);
 *   - what varies per variant: a creative direction (how the product is presented, the ad style, setting, surface,
 *     props, palette, light, mood, camera and layout). Directions are planned locally from a fixed set of distinct ad
 *     archetypes (planDirections), so N variants are N different kinds of creative even when the user writes nothing and
 *     even when the concept writer is unavailable; the writer only enriches each assigned direction;
 *   - what is regenerated: everything in the image, as one coherent render (light, shadows, reflections, edges).
 *
 * Sets made before this (no `rendering`, or `rendering: 'exact'`) keep the exact-source-pixel compositor of variants.ts.
 */
import type { SceneDescription, SceneObject } from './scene.js';
import { holderOf } from './scene.js';
import { brandInWords, namesWord, sameBrand } from './brands.js';
import { productNames } from './changePlan.js';
import { sanitizeEditInstruction } from './editPrompt.js';
import { cleanScenePrompt, clipWords, conceptDistance, type ConceptComposition, type ConceptFamily, type VariantConcept } from './variants.js';
import type { SemanticExpectation } from './verification.js';

/** integrated: the products are rendered into each scene from reference cutouts; exact: their source pixels are pasted (sets made before). */
export const VARIANT_RENDERINGS = ['integrated', 'exact'] as const;
export type VariantRendering = typeof VARIANT_RENDERINGS[number];

/** The ad archetypes a direction is drawn from: how the product is presented, not just where. */
export const PRESENTATIONS = ['hero-pedestal', 'lifestyle', 'in-hand', 'levitation', 'flat-lay', 'color-block', 'festive', 'tech', 'luxury', 'nature', 'minimal', 'urban'] as const;
export type Presentation = typeof PRESENTATIONS[number];
export interface CreativeDirection {
  id: Presentation; title: string; family: ConceptFamily;
  /** How the product is shown (on a pedestal, in a hand, in use…). */
  staging: string;
  /** The kind of advertisement and its layout feel. */
  style: string;
  environment: string; surface: string; props: string[]; palette: string[]; lighting: string; mood: string;
  camera: VariantConcept['camera']; composition: ConceptComposition;
  /** Only for products a hand can hold, or that can lie flat on a table. */
  smallOnly?: boolean;
}
/**
 * Twelve deliberately different directions. Words that would ask for lettering ("text", "sale", "offer", "logo",
 * "headline", "sign"…) are never used: every one of them passes scenePromptProblems.
 */
export const CREATIVE_DIRECTIONS: readonly CreativeDirection[] = [
  { id: 'hero-pedestal', title: 'Studio hero', family: 'studio', staging: 'the product stands as the hero on a sculpted pedestal, turned slightly to show its best three-quarter side',
    style: 'clean premium studio product advertisement, centred and symmetrical', environment: 'a seamless curved studio backdrop with a soft gradient glow behind the product', surface: 'a sculpted cylindrical pedestal with a satin finish',
    props: ['a few floating geometric spheres', 'soft pools of reflected light'], palette: ['deep navy', 'soft silver', 'cool white'], lighting: 'a dramatic key light from the upper left with a crisp rim light outlining the product', mood: 'premium and confident',
    camera: 'low-angle', composition: { x: 0.5, y: 0.58, scale: 0.62, copySpace: 'top' } },
  { id: 'lifestyle', title: 'In everyday life', family: 'lifestyle', staging: 'the product in use in a real, tidy home or workplace where it naturally belongs, placed off-centre like an editorial lifestyle photo',
    style: 'authentic lifestyle advertising photograph with a shallow depth of field', environment: 'a bright, stylish modern interior that suits the product, softly blurred behind it', surface: 'the natural wood or stone surface where the product is normally used',
    props: ['a few everyday items that fit how the product is used, kept secondary', 'a green plant'], palette: ['warm white', 'natural oak', 'sage green'], lighting: 'soft natural window light from the side with gentle shadows', mood: 'warm and relatable',
    camera: 'eye-level', composition: { x: 0.64, y: 0.6, scale: 0.5, copySpace: 'left' } },
  { id: 'in-hand', title: 'In hand', family: 'lifestyle', smallOnly: true, staging: 'one well-groomed hand presents the product toward the camera with a natural grip; only the hand and forearm are visible, no face',
    style: 'close-up lifestyle advertising shot with a dynamic diagonal composition', environment: 'a softly blurred city street or cafe background with warm bokeh', surface: 'no surface: the product is held in the hand',
    props: ['soft bokeh highlights'], palette: ['warm amber', 'soft cream', 'muted teal'], lighting: 'golden-hour backlight with a soft fill on the product', mood: 'personal and aspirational',
    camera: 'eye-level', composition: { x: 0.55, y: 0.52, scale: 0.6, copySpace: 'right' } },
  { id: 'levitation', title: 'Dynamic levitation', family: 'abstract', staging: 'the product floats at a slight dynamic tilt in mid-air, surrounded by motion elements that express what it does',
    style: 'high-energy commercial key visual with motion and depth', environment: 'a bold gradient backdrop with swirling ribbons of light and splashes or particles that suit the product', surface: 'no surface: the product floats, with a soft shadow far below it',
    props: ['dynamic splashes or particles', 'flowing ribbons of light'], palette: ['electric blue', 'vivid magenta', 'white'], lighting: 'punchy studio light with coloured rim lights', mood: 'energetic and bold',
    camera: 'low-angle', composition: { x: 0.5, y: 0.5, scale: 0.58, copySpace: 'bottom' } },
  { id: 'flat-lay', title: 'Top-down flat lay', family: 'minimal', smallOnly: true, staging: 'the product laid flat and seen from directly above, neatly arranged with a few complementary objects in a graphic knolling layout',
    style: 'editorial top-down flat-lay advertisement', environment: 'a textured paper or linen tabletop seen straight from above', surface: 'a textured paper surface',
    props: ['complementary everyday objects in a tidy grid', 'a sprig of greenery'], palette: ['sand', 'terracotta', 'off-white'], lighting: 'soft overhead daylight with short, crisp shadows', mood: 'organised and crafted',
    camera: 'top-down', composition: { x: 0.42, y: 0.5, scale: 0.55, copySpace: 'right' } },
  { id: 'color-block', title: 'Bold colour-block poster', family: 'abstract', staging: 'the product large and slightly off-centre, overlapping bold geometric colour blocks like a modern promotional poster',
    style: 'graphic poster-style advertisement with flat colour panels and one large calm panel kept empty for copy added later', environment: 'flat bold colour fields with geometric circles and arches, crisp edges and a subtle paper grain', surface: 'a simple geometric block casting one crisp shadow',
    props: ['geometric circles and arches', 'a subtle halftone texture'], palette: ['tangerine', 'cobalt', 'cream'], lighting: 'bright, even light with one crisp graphic shadow', mood: 'bold and punchy',
    camera: 'eye-level', composition: { x: 0.66, y: 0.6, scale: 0.6, copySpace: 'left' } },
  { id: 'festive', title: 'Festive celebration', family: 'festive', staging: 'the product as the centrepiece of a festive celebration setup, raised on a decorated tray',
    style: 'warm festive-season advertisement with rich layered decor', environment: 'a festive setting with glowing oil lamps, warm fairy-light bokeh and seasonal decorations', surface: 'a decorated brass tray on a carved wooden table',
    props: ['glowing oil lamps', 'marigold flowers', 'wrapped gift boxes'], palette: ['saffron', 'deep maroon', 'gold'], lighting: 'a warm candle-like glow with sparkling highlights', mood: 'joyful and celebratory',
    camera: 'high-angle', composition: { x: 0.5, y: 0.62, scale: 0.55, copySpace: 'top' } },
  { id: 'tech', title: 'Futuristic tech', family: 'tech', staging: 'the product on a glowing reflective platform in a futuristic space, with light trails tracing around it',
    style: 'sleek futuristic technology advertisement with neon accents and glossy reflections', environment: 'a dark futuristic space with neon light trails, glass panels and faint holographic grid lines', surface: 'a glossy black platform with a glowing edge ring',
    props: ['neon light trails', 'glass panels with reflections'], palette: ['midnight black', 'cyan', 'violet'], lighting: 'dark ambient light with cyan and violet neon accents and a sharp specular highlight', mood: 'innovative and sleek',
    camera: 'low-angle', composition: { x: 0.5, y: 0.6, scale: 0.58, copySpace: 'top' } },
  { id: 'luxury', title: 'Luxury editorial', family: 'luxury', staging: 'the product on a dark polished marble block, lit like a jewellery photograph',
    style: 'luxury editorial advertisement with deep shadows and fine highlights', environment: 'a moody dark set with soft drifting smoke and a warm spotlight beam', surface: 'a black marble block with fine gold veins',
    props: ['thin brass accents', 'soft drifting smoke'], palette: ['black', 'champagne gold', 'deep emerald'], lighting: 'a single warm spotlight from above with deep falloff and fine rim highlights', mood: 'exclusive and refined',
    camera: 'eye-level', composition: { x: 0.4, y: 0.6, scale: 0.5, copySpace: 'right' } },
  { id: 'nature', title: 'Natural elements', family: 'nature', staging: 'the product resting on natural stone among fresh natural elements that suggest freshness and purity',
    style: 'fresh natural-elements product advertisement', environment: 'a sunlit natural setting with water ripples, smooth stones and fresh leaves, softly blurred behind', surface: 'a flat natural stone slab',
    props: ['fresh green leaves', 'water droplets', 'smooth river stones'], palette: ['fresh green', 'stone grey', 'sky blue'], lighting: 'bright dappled sunlight from the upper right', mood: 'fresh and pure',
    camera: 'eye-level', composition: { x: 0.45, y: 0.62, scale: 0.55, copySpace: 'top' } },
  { id: 'minimal', title: 'Soft minimal', family: 'minimal', staging: 'the product on a low pastel plinth among soft arches, with generous calm space around it',
    style: 'soft minimal Scandinavian-style product advertisement', environment: 'a pastel set with soft arches and gentle curved shadows', surface: 'a low matte pastel plinth',
    props: ['soft pastel arches', 'a single dried flower stem'], palette: ['blush pink', 'sand beige', 'soft lilac'], lighting: 'soft diffused daylight from the left with long gentle shadows', mood: 'calm and gentle',
    camera: 'eye-level', composition: { x: 0.38, y: 0.62, scale: 0.45, copySpace: 'right' } },
  { id: 'urban', title: 'City at dusk', family: 'outdoor', staging: 'the product on a rooftop ledge with a dramatic city skyline at dusk behind it',
    style: 'cinematic outdoor advertisement with a wide view', environment: 'a rooftop terrace at blue hour with a glowing city skyline', surface: 'a smooth concrete ledge',
    props: ['soft city bokeh lights', 'a potted olive tree'], palette: ['indigo', 'amber', 'slate'], lighting: 'cool dusk ambient light with a warm glow from the city', mood: 'cinematic and urban',
    camera: 'low-angle', composition: { x: 0.6, y: 0.64, scale: 0.5, copySpace: 'top' } },
];
/** The directions that lead a set: strong, broadly suitable ad looks (the rest follow by diversity). */
const LEADS: readonly Presentation[] = ['hero-pedestal', 'lifestyle', 'color-block', 'tech', 'luxury', 'nature'];

/** "the product" as "the product group" when a set shows several products together (the verbs stay singular). */
export const groupWords = (text: string, count: number) => count > 1 ? text.replace(/\b([Tt])he product\b(?! group)/g, '$1he product group') : text;
/** The least share of the canvas a group of products takes, so no product of it ends up tiny or cut. */
export const groupScale = (scale: number, count: number) => count > 1 ? Math.max(scale, 0.62) : scale;
/** A direction as a concept: the brief the concept writer enriches, and what a variant uses when no writer answers. */
export function directionConcept(d: CreativeDirection, count = 1): VariantConcept {
  const g = (t: string) => groupWords(t, count);
  return { title: d.title, family: d.family, theme: g(d.style), environment: g(d.environment), surface: g(d.surface), props: [...d.props], palette: [...d.palette], lighting: g(d.lighting), mood: d.mood,
    camera: d.camera, composition: { ...d.composition, scale: groupScale(d.composition.scale, count) }, presentation: d.id,
    staging: count > 1 ? `all ${count} products together as one arranged group, each complete and fully visible: ${g(d.staging)}` : d.staging, style: g(d.style) };
}
/**
 * Whether a written staging shows every product of a group: it must speak of them together (plural, a group, all of
 * them) and never of one alone. A writer that stages one product of three is not trusted with that variant's staging.
 */
export function stagingShowsAll(staging: string | undefined, count: number): boolean {
  if (count < 2) return true;
  if (!staging) return false;
  if (/\b(?:alone|on its own|by itself|solo|single|only one|just one|lone)\b/i.test(staging)) return false;
  return /\b(?:products|group|together|all|both|trio|pair|three|four|five|two|each|side by side|lineup|line-up|row|cluster|ensemble|collection|set of|family)\b/i.test(staging);
}

/** Product categories a hand can hold or that can lie flat on a table (words, any language the analysis used). */
const SMALL = /\b(?:phone|smartphone|mobile|earbud|earbuds|earphone|headphone|headphones|headset|watch|smartwatch|band|bottle|can|cup|mug|glass|jar|tube|cream|lotion|serum|lipstick|perfume|fragrance|cosmetic|makeup|soap|shampoo|snack|chocolate|candy|biscuit|pack|packet|box|wallet|sunglasses|glasses|camera|remote|controller|mouse|keyboard|charger|cable|power ?bank|speaker|tablet|book|card|pen|ring|necklace|bracelet|earring|jewellery|jewelry|toy|shoe|sneaker|cap|bag)\b/i;
const LARGE = /\b(?:fridge|refrigerator|washing|washer|dryer|purifier|dispenser|appliance|television|tv|oven|microwave|air ?conditioner|ac|cooler|heater|sofa|couch|bed|table|chair|wardrobe|car|bike|scooter|motorcycle|cycle|treadmill|machine|stove|chimney|dishwasher)\b/i;
/** Every kept product is small enough to hold or lay flat (unknown or large products are not). */
export const smallProducts = (objects: Pick<SceneObject, 'category' | 'description'>[]) => objects.length > 0 && objects.every(o => SMALL.test(o.category) && !LARGE.test(`${o.category}`));

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(w => b.has(w)).length / Math.max(1, Math.min(a.size, b.size));
/** A small, stable number from a string (a set's id): which direction leads, so new sets do not all start alike. */
export const directionSeed = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * N directions, as different from each other (and from directions the set already used) as the pool allows:
 * the first from the lead list (rotated by the seed), then each next one the farthest from those chosen. Directions that
 * need a small product are left out for large ones; "in hand" is left out when a kept person already holds the product.
 * A direction that repeats the original creative's own setting is used last, so variants do not look like the source.
 */
export function planDirections(count: number, context: { small: boolean; people: boolean; original?: string; seed?: number; used?: VariantConcept[]; products?: number }): CreativeDirection[] {
  // One hand holds one product: "in hand" only for a single small product that nobody kept already holds.
  const pool = CREATIVE_DIRECTIONS.filter(d => (!d.smallOnly || context.small) && !(d.id === 'in-hand' && (context.people || (context.products ?? 1) > 1)));
  const original = words(context.original ?? ''), echoes = (d: CreativeDirection) => original.size > 0 && overlap(words(`${d.environment} ${d.surface} ${d.props.join(' ')}`), original) >= 0.34;
  const used = context.used ?? [], chosen: CreativeDirection[] = [];
  const nearest = (d: CreativeDirection) => Math.min(Infinity, ...[...used, ...chosen.map(directionConcept)].map(c => conceptDistance(directionConcept(d), c)));
  const usedIds = new Set(used.map(c => c.presentation).filter(Boolean));
  const leads = LEADS.filter(id => pool.some(d => d.id === id) && !usedIds.has(id)), seed = context.seed ?? 0;
  while (chosen.length < count) {
    const left = pool.filter(d => !chosen.includes(d) && !usedIds.has(d.id));
    const candidates = left.length ? left : pool.filter(d => !chosen.includes(d));
    if (!candidates.length) break;
    let next: CreativeDirection | undefined;
    if (!chosen.length && !used.length && leads.length) {
      const fresh = leads.map(id => pool.find(d => d.id === id)!).filter(d => !echoes(d));
      const from = fresh.length ? fresh : leads.map(id => pool.find(d => d.id === id)!);
      next = from[seed % from.length];
    } else next = [...candidates].sort((a, b) => (Number(echoes(a)) - Number(echoes(b))) || (nearest(b) - nearest(a)))[0];
    chosen.push(next);
  }
  return chosen;
}

/** A canvas position and size in plain words, for the editable direction and the prompt. */
export function placementPhrase(c: ConceptComposition): string {
  const across = c.x < 0.42 ? 'left of centre' : c.x > 0.58 ? 'right of centre' : 'centred', down = c.y < 0.45 ? ', high in the frame' : c.y > 0.64 ? ', low in the frame' : '';
  const size = c.scale < 0.45 ? 'small, with generous space around them' : c.scale < 0.66 ? 'filling about half of the frame' : 'large, filling most of the frame';
  return `${across}${down}, ${size}`;
}
/** An integrated concept as its editable creative direction (the product and integration rules are added around it when sent). */
export function directionScene(c: VariantConcept, count = 1): string {
  const open = c.composition.copySpace === 'none' ? '' : ` Keep the ${c.composition.copySpace} part of the frame calm and uncluttered for copy added later.`;
  // Each part ends once ("light.." never), and the layout comes early so a long direction never loses it.
  const end = (t: string) => t.trim().replace(/[\s.;,!]+$/, ''), g = (t: string) => groupWords(end(t), count);
  return cleanScenePrompt([count > 1 ? `Show all ${count} products together in this scene, each complete and fully visible.` : '', c.style || c.theme ? `${g(c.style || c.theme)}.` : '', c.staging ? `Presentation: ${g(c.staging)}.` : '',
    `Layout: the ${count > 1 ? 'product group' : 'products'} ${placementPhrase({ ...c.composition, scale: groupScale(c.composition.scale, count) })}.${open}`, `Camera: ${c.camera} view.`,
    `Setting: ${g(c.environment)}.`, `Surface: ${g(c.surface)}.`, c.props.length ? `Props: ${c.props.map(end).join(', ')}.` : '', `Palette: ${c.palette.map(end).join(', ') || 'harmonious with the product'}.`,
    `Lighting: ${g(c.lighting) || 'soft and natural'}.`, `Mood: ${end(c.mood) || 'premium'}.`].filter(Boolean).join(' '));
}

/** A kept product of an integrated set: what it is, and what the user asked it to be instead (if anything). */
export interface VariantProduct {
  id: string; label: string; category: string;
  /** What the analysis read it as ("Samsung Galaxy S24 smartphone"). */
  detected: string;
  /** How it looks, in a few words (tells two products of the same kind apart). Sets made before have none. */
  look?: string;
  /** The identity the user asked for instead (a replacement); absent: the product stays as it is. */
  requested?: string;
  /** The brand of the requested product: the user's brand field, or the one brand their words name (never a guess). */
  brand?: string;
  /** The old product's names that must not come back (its brand, lines, own marks), when it was replaced by another brand or line. */
  staleNames?: string[];
  /** Why a kept product is left out of the creatives (an accessory of a replaced product that would bring the old brand back). */
  omitted?: string;
}
export const PRODUCT_NAME_LIMIT = 120;
/** What a product is, in a few words: its brand and model when visible, then its category. */
export function productIdentity(o: Pick<SceneObject, 'category' | 'identity'>): string {
  const parts = [o.identity?.brand ?? '', o.identity?.model ?? '', o.category].map(p => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) if (!out.some(x => namesWord(x, p) || namesWord(p, x))) out.push(p);
  // A model that already starts with its brand ("Galaxy S24" after "Samsung") reads as one name.
  return sanitizeEditInstruction(out.join(' ')).slice(0, PRODUCT_NAME_LIMIT);
}
/** An analysis description without where the object stood (a new creative places it anew), at most ~150 characters. */
const lookOf = (description: string) => clipWords(sanitizeEditInstruction(description)
  .replace(/,?\s*(?:positioned|placed|standing|sitting|shown|located|resting|set)\s+(?:at|on|in|beside|behind|near|next to|to the)\b[^,.;]*/gi, '')
  .replace(/\s+,/g, ',').replace(/[\s.;,]+$/, ''), 150);
const same = (a: string, b: string) => a.trim().toLocaleLowerCase().replace(/\s+/g, ' ') === b.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
/** A product name the user typed is plain words: no quotes, prices or offers (the creative stays text-free). */
const NOT_A_NAME = /["“”«»]|₹|\$|%|\b(?:price|prices|discount|offer|offers|sale|coupon|cashback|emi|logo|logos|watermark|text|headline|caption|slogan|tagline)\b/i;
export function productNameProblems(value: unknown): string[] {
  const clean = sanitizeEditInstruction(value);
  if (!clean) return [];
  if (clean.length > PRODUCT_NAME_LIMIT) return [`A product name is at most ${PRODUCT_NAME_LIMIT} characters.`];
  return NOT_A_NAME.test(clean) ? ['Name the product only (for example "Apple iPhone 15"): prices, offers, logos and other text are not added to these creatives.'] : [];
}
/**
 * The products of an integrated set, with the identities the user asked for. A requested name equal to what was detected
 * changes nothing. A replaced product's old names (productNames) become stale unless the new identity names them too
 * (a Galaxy S23 → Galaxy S24 keeps "Samsung" and "Galaxy"). A kept accessory or same-brand companion of a replaced
 * product, itself unchanged, is left out: its old brand would otherwise come back next to the new product.
 */
export function variantProducts(scene: SceneDescription, ids: string[], requests: Record<string, { name?: string; brand?: string }> = {}): VariantProduct[] {
  const seen = [...new Set(scene.objects.map(o => o.identity?.brand ?? '').filter(Boolean))];
  const out: VariantProduct[] = ids.map(id => scene.objects.find(o => o.id === id)).filter((o): o is SceneObject => !!o).map(o => {
    const detected = productIdentity(o) || o.label, ask = requests[o.id] ?? {}, look = lookOf(o.description);
    const name = sanitizeEditInstruction(ask.name ?? '').slice(0, PRODUCT_NAME_LIMIT), brandField = sanitizeEditInstruction(ask.brand ?? '').slice(0, 60);
    if (!name || same(name, detected)) return { id: o.id, label: o.label, category: o.category, detected, ...(look ? { look } : {}) };
    const read = brandInWords(name, seen), brand = brandField || (read && 'brand' in read ? read.brand : undefined);
    const requested = brand && !namesWord(name, brand) ? `${brand} ${name}` : name;
    const staleNames = productNames(scene, o).map(n => n.name).filter(n => !namesWord(requested, n) && !(brand && sameBrand(n, brand)));
    return { id: o.id, label: o.label, category: o.category, detected, requested, ...(brand ? { brand } : {}), ...(staleNames.length ? { staleNames } : {}) };
  });
  const replaced = out.filter(p => p.requested && p.staleNames?.length);
  for (const p of out) {
    if (p.requested) continue;
    const o = scene.objects.find(x => x.id === p.id)!;
    const tied = replaced.find(r => scene.relations.some(rel => ['accessory_of', 'same_brand_as'].includes(rel.relation) && rel.confidence >= 0.6 && ((rel.source === p.id && rel.target === r.id) || (rel.source === r.id && rel.target === p.id)))
      || (o.identity?.brand && r.staleNames!.some(n => sameBrand(n, o.identity!.brand))));
    if (tied) p.omitted = `left out: it carries the brand of the replaced ${tied.label}, which would come back next to ${tied.requested}`;
  }
  return out;
}
/** The products a set renders (not left out). */
export const renderedProducts = (products: VariantProduct[]) => products.filter(p => !p.omitted);

/** What the image model is given as references, in the order they are attached. */
export interface CreativeReferences {
  /** The kept, unchanged products cut out on a plain neutral background (their labels, left to right). */
  sheet?: string[];
  /** The sheet's tiles left to right, each the product ids standing together in it (products that touched stay together). */
  groups?: string[][];
  /** The original creative itself, when the products could not be cut out cleanly. */
  original?: boolean;
  /** The user's photo of the requested product. */
  photo?: { productId: string };
}
const list = (items: string[], word = 'and') => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
const plain = (t: string) => sanitizeEditInstruction(t).replace(/["“”]/g, '\'');
/** The rendered products in the order the prompt numbers them: the sheet's tiles left to right, then the others. */
export function productOrder(products: VariantProduct[], references: CreativeReferences): VariantProduct[] {
  const shown = renderedProducts(products), order = (references.groups ?? []).flat(), rank = (p: VariantProduct) => { const i = order.indexOf(p.id); return i < 0 ? 1000 + shown.indexOf(p) : i; };
  return [...shown].sort((a, b) => rank(a) - rank(b));
}
const named = (p: VariantProduct) => p.requested ? plain(p.requested) : `${plain(p.detected)}${p.look ? ` (${plain(p.look)})` : ''}`;
const numbers = (ks: number[]) => list(ks.map(String));
/**
 * The exact prompt of an integrated variant, in labelled parts: the products (consistent across every variant, every
 * one of them numbered and required), this variant's creative direction (what varies), how it is integrated
 * (regenerated as one image), a final count, and what is never drawn. `scene` is the variant's editable direction.
 */
export function compileCreativePrompt(input: { products: VariantProduct[]; references: CreativeReferences; scene: string; ratio: string; people: boolean; hands?: boolean }): string {
  const products = productOrder(input.products, input.references), n = products.length, refs: string[] = [], no = (id: string) => products.findIndex(p => p.id === id) + 1;
  const sheetAt = input.references.sheet?.length ? 1 : 0, originalAt = input.references.original ? sheetAt + 1 : 0, photoAt = input.references.photo ? Math.max(sheetAt, originalAt) + 1 : 0;
  const tiles = (input.references.groups ?? []).map(g => g.map(no).filter(k => k > 0)).filter(g => g.length);
  if (sheetAt) refs.push(`Reference image ${sheetAt} shows ${n > 1 ? `the ${input.references.sheet!.length} unchanged products` : 'the product'} cut out on a plain neutral background${tiles.length > 1 || tiles.some(t => t.length > 1) ? `, left to right: ${tiles.map(t => t.length > 1 ? `products ${numbers(t)} standing together` : `product ${t[0]}`).join('; ')}` : ''}. Use it only for how ${n > 1 ? 'they look' : 'it looks'}, never for the layout, background or angle. Where a cut-out has a gap or a straight cut edge because something stood in front of it in the original photo, draw that part complete.`);
  if (originalAt) refs.push(`Reference image ${originalAt} is the original advertisement: take only the ${n > 1 ? `${n} products listed below` : 'product'} from it, and ignore its background, props, layout, colours, camera angle and any text in it.`);
  const photo = input.references.photo && products.find(p => p.id === input.references.photo!.productId);
  if (photoAt && photo) refs.push(`Reference image ${photoAt} is a photo of ${plain(photo.requested ?? photo.detected)}: match that product's real appearance.`);
  const lines = products.map((p, i) => {
    if (!p.requested) return `${i + 1}. ${named(p)}: reproduce it faithfully${sheetAt || originalAt ? ' from the reference' : ''}, complete with every part attached to it (taps, cables, stands, lids), with the same design, shape, proportions, colours, materials, finish, screens, buttons and the brand markings printed on it. Do not redesign, simplify, crop or rebrand it.`;
    const stale = p.staleNames?.length ? ` Nothing of the original ${plain(p.category)} may remain: no ${list(p.staleNames.map(plain), 'or')} logo, wordmark, model name or design cue anywhere in the image.` : '';
    return `${i + 1}. ${plain(p.requested)} (asked for instead of the original ${plain(p.category)}): show it as a genuine ${plain(p.requested)} with its own correct, recognisable design${p.brand ? ` and only ${plain(p.brand)} branding` : ''}.${stale}`;
  });
  const notes: string[] = [];
  for (const t of tiles.filter(t => t.length > 1)) notes.push(`Products ${numbers(t)} belong together: keep them touching and arranged as on the sheet, each complete.`);
  const kinds = new Map<string, number[]>();
  products.forEach((p, i) => { if (!p.requested) kinds.set(p.category.toLowerCase(), [...(kinds.get(p.category.toLowerCase()) ?? []), i + 1]); });
  for (const [kind, ks] of kinds) if (ks.length > 1) notes.push(`Products ${numbers(ks)} are ${ks.length} separate ${plain(kind)} units with their own designs: show every one of them, never just one.`);
  const people = input.people ? 'The person from the reference stays the same person, holding or wearing the products as before; add no other people.'
    : input.hands ? 'Only one hand and forearm may appear, holding the product naturally; no face and no other people.' : 'Do not add people, hands or body parts.';
  const all = n > 1 ? `exactly ${n} products, and all ${n} must appear in the image, each complete, fully visible and recognisable (none left out, cropped by the frame, hidden behind another or merged into another)` : 'one product, complete, fully visible and recognisable';
  return [
    `Create one finished, premium advertising image in ${input.ratio} format: an art-directed commercial photograph that is ready to publish, with the ${n > 1 ? `${n} products` : 'product'} as the clear hero.`,
    ...refs,
    `PRODUCTS (keep consistent): ${all}.\n${lines.join('\n')}${notes.length ? `\n${notes.join('\n')}` : ''}\nAdd no other products.`,
    `CREATIVE DIRECTION (this variant's own concept; compose it freshly and do not copy the reference's layout, background, props or camera angle${n > 1 ? `; arrange all ${n} products within it` : ''}):\n${cleanScenePrompt(input.scene)}`,
    'INTEGRATION (regenerate everything as one coherent image): render the products as real objects inside this scene, lit by its own light with matching colour temperature, in correct perspective for the camera, with natural contact shadows and reflections on what they rest on, and clean natural edges: no halo, outline, sticker look, flat lighting or mismatched edges. The products may be turned or re-posed to suit the composition, but their design never changes. ' + people,
    ...(n > 1 ? [`FINAL CHECK: the finished image shows exactly ${n} products: ${products.map((p, i) => `${i + 1}) ${p.requested ? plain(p.requested) : plain(p.detected)}`).join(', ')}. If any is missing or cut off, recompose (smaller, closer together, or overlapping slightly) until all ${n} fit completely.`] : []),
    'NEVER: add text, letters, numbers, prices, discounts, captions, badges with lettering, watermarks or logos anywhere in the scene. The only markings allowed are the ones printed on the products themselves.',
  ].join('\n\n');
}

/** What the AI check verifies for an integrated variant: every product present and complete (identity, not pixels), the requested changes, and no text. */
export function integratedExpectations(products: VariantProduct[], people: number, references: CreativeReferences = {}): SemanticExpectation[] {
  const shown = productOrder(products, references), kept = shown.filter(p => !p.requested), changed = shown.filter(p => p.requested), n = shown.length;
  const out: SemanticExpectation[] = [];
  if (kept.length) out.push({ id: 'protected-kept', expectation: `${kept.length > 1 ? `all ${kept.length} of these original products are present, each` : 'this original product is present,'} complete and recognisable with the same design, colours, markings and attached parts (taps, cables, stands) as in the original: ${kept.map((p, i) => `${i + 1}) ${named(p)}`).join('; ')}. It is re-rendered in a new scene, so pose and lighting may differ; a missing product or a missing attached part is a failure` });
  if (changed.length) out.push({ id: 'replacement-done', expectation: changed.map(p => `the original ${plain(p.category)} is now shown as ${plain(p.requested!)}`).join('; ') });
  const branded = changed.filter(p => p.brand);
  if (branded.length) out.push({ id: 'brand-consistent', expectation: branded.map(p => `${plain(p.requested!)} shows only ${plain(p.brand!)} branding, if any`).join('; ') });
  const stale = changed.flatMap(p => p.staleNames ?? []);
  if (stale.length) out.push({ id: 'old-references-absent', expectation: `no ${list([...new Set(stale)].map(plain), 'or')} logo, wordmark or model name appears anywhere` });
  out.push({ id: 'subject-count', expectation: `exactly ${n} product${n === 1 ? ' is' : 's are'} visible (${n === 1 ? 'the one listed' : `the ${n} listed, none missing and none extra`}), and exactly ${people} ${people === 1 ? 'person or character is' : 'people or characters are'} visible (a single presenting hand does not count)` });
  out.push({ id: 'no-added-text', expectation: 'the image contains no text, letters, numbers, prices, badges with lettering, watermarks or logos (markings printed on the products themselves are allowed)' });
  out.push({ id: 'no-duplicates', expectation: 'each product appears exactly once, with no second copy, ghost or outline of it' });
  return out;
}
/** Whether a direction shows the product in a hand (the prompt then allows one hand). */
export const showsHand = (c: Pick<VariantConcept, 'presentation' | 'staging'> | undefined, scene = '') => c?.presentation === 'in-hand' || /\b(?:hand|hands|holding|held)\b/i.test(`${c?.staging ?? ''} ${scene}`);
/** Kept people of a set (they stay the same people in every creative). */
export const keptPeople = (scene: SceneDescription, ids: string[]) => ids.map(id => scene.objects.find(o => o.id === id)).filter(o => o && (o.kind === 'person' || o.kind === 'character')).length;
/** A kept product held by a kept person: the person and the hold stay. */
export const heldInSet = (scene: SceneDescription, ids: string[]) => ids.some(id => { const h = holderOf(scene, id); return !!h && ids.includes(h); });
