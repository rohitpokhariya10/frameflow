/**
 * Feature 2, automatic: the user changes the fields they care about and clicks Generate Creative; nothing is asked.
 *
 * The rules of changePlan.ts still decide what a change takes along (old brand marks, offers, parts, the hand around a
 * held object). Where they used to stop and ask (other copies of the product, accessories, a kept old logo, a brand in
 * two words, a product photo against the words, an uncertain resolver suggestion), autoResolve answers with the option
 * a sensible art director would pick, records why, and plans again, until nothing is open.
 *
 * Precedence: what the user typed > what their change implies > what the template showed. The user's own edits are never
 * overridden. When the user's change makes the creative about a different kind of product (three kitchen appliances →
 * "premium sports bike"), the ad is now about that product: the other advertised products of the old offer go, and the
 * background, display stands and decorations are restyled to suit it. A same-kind change (a Samsung phone → an iPhone)
 * stays a local replacement: the old brand's marks go, independent objects stay.
 */
import { applyConflictOption, basePlan, mergeResolution, targetPhrase, type ChangePlan, type ConflictOption, type ObjectEdit, type PlanConflict, type PlanContext, type PlanEntry, type ResolverProposal, type SceneDraft } from './changePlan.js';
import { brandInWords, namesWord, sameBrand } from './brands.js';
import { isForeground, sceneTarget, type SceneDescription, type SceneObject } from './scene.js';
import { sanitizeEditInstruction } from './editPrompt.js';

/**
 * Product kinds, as word patterns. A phrase's kind is its head noun's (the match that ends last: "coffee machine" is an
 * appliance, "sports bike" a vehicle). Product lines name their kind ("iPhone" is a phone). Knowledge of words, not rules
 * about categories: any two kinds are compared the same way.
 */
const KINDS: [kind: string, pattern: RegExp][] = [
  ['phone', /\b(?:phones?|smart ?phones?|mobiles?|mobile phones?|cell ?phones?|handsets?|iphones?|pixel|redmi|poco|moto|galaxy(?! (?:buds|watch|tab|book)))\b/gi],
  ['tablet', /\b(?:tablets?|ipads?|galaxy tab)\b/gi],
  ['laptop', /\b(?:laptops?|notebooks?|macbooks?|thinkpads?|ideapads?|chromebooks?|ultrabooks?|galaxy book)\b/gi],
  ['computer', /\b(?:computers?|desktops?|pcs?|imacs?|monitors?)\b/gi],
  ['watch', /\b(?:watch(?:es)?|smart ?watch(?:es)?|wrist ?watch(?:es)?|apple watch|galaxy watch)\b/gi],
  ['audio', /\b(?:ear ?buds|ear ?phones?|head ?phones?|headsets?|airpods|airdopes|rockerz|buds|speakers?|sound ?bars?|earpods)\b/gi],
  ['camera', /\b(?:cameras?|dslrs?|mirrorless|gopro|lens(?:es)?)\b/gi],
  ['tv', /\b(?:tvs?|televisions?|bravia|projectors?)\b/gi],
  ['console', /\b(?:playstation|xbox|consoles?|gaming console)\b/gi],
  ['vehicle', /\b(?:bikes?|motor ?bikes?|motorcycles?|scooters?|cars?|suvs?|sedans?|trucks?|bicycles?|cycles?|e-?bikes?|vehicles?|jeeps?|hatchbacks?)\b/gi],
  ['laundry', /\b(?:washing machines?|washers?|dryers?|laundry)\b/gi],
  ['kitchen', /\b(?:ice (?:makers?|machines?|appliances?|dispensers?)|refrigerators?|fridges?|freezers?|ovens?|microwaves?|blenders?|mixers?|grinders?|juicers?|kettles?|toasters?|coffee (?:machines?|makers?)|espresso machines?|cookers?|chimneys?|dishwashers?|air ?fryers?|fryers?|stoves?|cooktops?|induction)\b/gi],
  ['water', /\b(?:water (?:purifiers?|appliances?|dispensers?|filters?|coolers?)|purifiers?|faucets?|taps?|dispensers?)\b/gi],
  ['climate', /\b(?:air ?conditioners?|acs?|coolers?|heaters?|fans?|humidifiers?|dehumidifiers?|air purifiers?)\b/gi],
  ['cleaning', /\b(?:vacuums?|vacuum cleaners?|robot vacuums?|mops?)\b/gi],
  ['fragrance', /\b(?:perfumes?|fragrances?|colognes?|eau de (?:parfum|toilette)|deodorants?|body sprays?|attar)\b/gi],
  ['skincare', /\b(?:serums?|creams?|lotions?|moisturi[sz]ers?|skin ?care|sunscreens?|face ?wash(?:es)?|cleansers?|toners?|face masks?)\b/gi],
  ['makeup', /\b(?:lipsticks?|foundations?|mascaras?|eyeliners?|make ?up|nail polish(?:es)?|blush(?:es)?|compacts?|kajal)\b/gi],
  ['haircare', /\b(?:shampoos?|conditioners?|hair oils?|hair dryers?|straighteners?|trimmers?|shavers?|razors?)\b/gi],
  ['footwear', /\b(?:shoes?|sneakers?|boots?|sandals?|heels|slippers?|loafers?|trainers?)\b/gi],
  ['apparel', /\b(?:shirts?|t-?shirts?|dress(?:es)?|jackets?|jeans|trousers|sarees?|kurtas?|hoodies?|sweaters?|suits?|tops?|skirts?|clothing|outfits?)\b/gi],
  ['bag', /\b(?:bags?|handbags?|backpacks?|wallets?|purses?|luggage|suitcases?|totes?)\b/gi],
  ['eyewear', /\b(?:sunglasses|glasses|spectacles|eyewear|frames)\b/gi],
  ['jewellery', /\b(?:rings?|necklaces?|bracelets?|earrings?|jewell?e?ry|pendants?|bangles?|chains?)\b/gi],
  ['food', /\b(?:chocolates?|snacks?|chips|biscuits?|cookies?|burgers?|pizzas?|noodles|cereals?|cakes?|sweets?|ice ?creams?|coffee|tea)\b/gi],
  ['beverage', /\b(?:drinks?|sodas?|colas?|beers?|wines?|juices?|energy drinks?|whisk(?:e)?y)\b/gi],
  ['furniture', /\b(?:sofas?|couch(?:es)?|beds?|mattress(?:es)?|chairs?|tables?|wardrobes?|desks?|shelves|shelf)\b/gi],
];
/** Broad words that name no kind of their own: they fit any household appliance, or any device. */
const APPLIANCE_KINDS = new Set(['laundry', 'kitchen', 'water', 'climate', 'cleaning']), DEVICE_KINDS = new Set(['phone', 'tablet', 'laptop', 'computer', 'watch', 'audio', 'camera', 'tv', 'console']);
const GENERIC: [kind: string, pattern: RegExp][] = [['appliance', /\b(?:appliances?|machines?)\b/gi], ['device', /\b(?:devices?|gadgets?|electronics)\b/gi]];
/** The kind of product a phrase names (its head noun's), if any word of it is known. */
export function productKind(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let best: { kind: string; end: number; length: number } | undefined;
  for (const [kind, pattern] of KINDS) for (const m of text.matchAll(pattern)) {
    const end = m.index! + m[0].length;
    if (!best || end > best.end || (end === best.end && m[0].length > best.length)) best = { kind, end, length: m[0].length };
  }
  if (best) return best.kind;
  for (const [kind, pattern] of GENERIC) if (pattern.test(text)) { pattern.lastIndex = 0; return kind; }
  return undefined;
}
const compatible = (a: string, b: string) => a === b || (a === 'appliance' && APPLIANCE_KINDS.has(b)) || (b === 'appliance' && APPLIANCE_KINDS.has(a)) || (a === 'device' && DEVICE_KINDS.has(b)) || (b === 'device' && DEVICE_KINDS.has(a));
/** Words that describe, not name, a product ("premium", "matte black", "pro max"). */
const DESCRIPTIVE = new Set(['premium', 'new', 'latest', 'luxury', 'luxurious', 'modern', 'classic', 'stylish', 'elegant', 'smart', 'pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'air', 'edition', 'limited', 'special',
  'black', 'white', 'silver', 'gold', 'golden', 'blue', 'red', 'green', 'pink', 'grey', 'gray', 'purple', 'yellow', 'orange', 'brown', 'beige', 'matte', 'glossy', 'metallic', 'titanium', 'steel', 'colour', 'color',
  'big', 'small', 'large', 'compact', 'portable', 'wireless', 'sleek', 'slim', 'best', 'top', 'high', 'end', 'quality', 'beautiful', 'cool', 'stunning', 'with', 'and', 'the', 'for', 'model', 'series', 'version']);
/** The words of a phrase that could name a product: not brands, model codes or descriptive words. */
const nameWords = (text: string, brands: string[]) => (text.toLowerCase().match(/[\p{L}][\p{L}'’-]{2,}/gu) ?? []).filter(w => !DESCRIPTIVE.has(w) && !brands.some(b => sameBrand(b, w)));
/**
 * Whether a requested product is the same kind of product as the object it replaces (a phone for a phone, any appliance
 * for an appliance). Unknown words fall back to shared words; words naming only a brand or model ("Vivo X100") are taken
 * as the same kind, since nothing in them names another one.
 */
export function sameProductKind(value: string, o: Pick<SceneObject, 'category' | 'description' | 'identity'>, brands: string[] = []): boolean {
  const next = productKind(value), was = productKind(o.category) ?? productKind(o.description) ?? productKind(o.identity?.model);
  if (next && was) return compatible(next, was);
  const words = nameWords(value, brands);
  if (!words.length) return true;
  const own = new Set(nameWords(`${o.category} ${o.description} ${o.identity?.model ?? ''}`, brands));
  return words.some(w => own.has(w) || own.has(w.replace(/s$/, '')));
}

/** What the user's changes make of the creative, for the plan and the one-line summary shown before generating. */
export interface CreativeIntent {
  /** none: nothing typed; local: changes in place; replace: products swapped for the same kind; new-product: the ad is now about another kind of product. */
  kind: 'none' | 'local' | 'replace' | 'new-product';
  /** new-product: the object that becomes the hero, and what it becomes. */
  heroId?: string; hero?: string;
  /** Short everyday words, never a promise: "Creating a sports bike ad. AI will update the scene and remove unrelated products." */
  summary: string;
}
const productLike = (o: SceneObject) => !o.ignored && isForeground(o) && (o.kind === 'product' || o.kind === 'object');
const area = (o: SceneObject) => o.box.w * o.box.h;
/** "a"/"an" as the words are said ("an LG washing machine", "a premium bike"). */
const article = (text: string) => {
  if (/^(?:an?|the)\b/i.test(text)) return text;
  const first = text.split(/\s+/)[0] ?? '', acronym = /^[A-Z0-9]{2,}$/.test(first);
  const vowel = acronym ? /^[AEFHILMNORSX8]/.test(first) : /^[aeiou]/i.test(first) && !/^(?:uni|use|euro|one)/i.test(first);
  return `${vowel ? 'an' : 'a'} ${text}`;
};
/** A leading describing word in lower case ("Premium sports bike" → "premium sports bike"); names stay as typed ("Apple", "LG"). */
const lowerFirst = (t: string) => { const first = t.split(/\s+/)[0] ?? ''; return DESCRIPTIVE.has(first.toLowerCase()) ? first.toLowerCase() + t.slice(first.length) : t; };
const brandOfEdit = (scene: SceneDescription, e: ObjectEdit) => e.brand || (() => { const read = brandInWords(e.value, scene.objects.map(o => o.identity?.brand ?? '').filter(Boolean)); return read && 'brand' in read ? read.brand : undefined; })();
/** The user's changes, read as intent: which product leads, and whether the creative becomes about another kind of product. */
export function creativeIntent(scene: SceneDescription, draft: SceneDraft): CreativeIntent {
  const edits = Object.entries(draft.edits).filter(([id, e]) => e.action !== 'keep' && scene.objects.some(o => o.id === id && !o.ignored));
  if (!edits.length) return { kind: 'none', summary: 'No changes: Generate Creative makes a fresh version of this creative with the same products.' };
  const brands = scene.objects.map(o => o.identity?.brand ?? '').filter(Boolean);
  const replaced = edits.filter(([id, e]) => e.action === 'replace' && productLike(scene.objects.find(o => o.id === id)!) && (e.value || e.brand)).map(([id, e]) => ({ o: scene.objects.find(o => o.id === id)!, e }));
  // The lead: the most important replaced product, then the first in the order the products are offered (left to right).
  const lead = [...replaced].sort((a, b) => (a.o.importance === 'main' ? 0 : 1) - (b.o.importance === 'main' ? 0 : 1) || a.o.box.x - b.o.box.x)[0];
  const mainish = (o: SceneObject) => o.importance === 'main' || scene.mainCandidates.includes(o.id) || !scene.objects.some(x => productLike(x) && x.id !== o.id && area(x) > area(o));
  if (lead && lead.e.value && mainish(lead.o) && !sameProductKind(lead.e.value, lead.o, brands)) {
    const hero = sanitizeEditInstruction(brandOfEdit(scene, lead.e) && !namesWord(lead.e.value, brandOfEdit(scene, lead.e)!) ? `${brandOfEdit(scene, lead.e)} ${lead.e.value}` : lead.e.value);
    const others = scene.objects.filter(o => productLike(o) && o.id !== lead.o.id && !draft.edits[o.id]);
    const also = replaced.filter(r => r !== lead && r.e.value).map(r => article(lowerFirst(sanitizeEditInstruction(r.e.value!))));
    return { kind: 'new-product', heroId: lead.o.id, hero, summary: `Creating ${also.length ? `an ad for ${article(lowerFirst(hero))} and ${also.join(' and ')}` : `${article(lowerFirst(hero))} ad`} in the same template. AI will adapt the scene${others.length ? ' and remove unrelated products' : ''}, keeping the layout as far as the new product allows.` };
  }
  if (replaced.length) {
    const one = replaced.length === 1 ? replaced[0] : undefined, branded = replaced.some(r => brandOfEdit(scene, r.e) || r.o.identity?.brand);
    const what = one ? `the ${one.o.category.toLowerCase()} with ${one.e.value ? article(lowerFirst(sanitizeEditInstruction(brandOfEdit(scene, one.e) && !namesWord(one.e.value, brandOfEdit(scene, one.e)!) ? `${brandOfEdit(scene, one.e)} ${one.e.value}` : one.e.value))) : `a ${brandOfEdit(scene, one.e)} one`}` : `${replaced.length} products`;
    const rest = edits.length > replaced.length ? ' Your other changes are applied too.' : '';
    return { kind: 'replace', summary: `Replacing ${what}.${branded ? ' Related branding will be updated.' : ''}${rest} The original layout stays the same.` };
  }
  const names = edits.map(([id]) => scene.objects.find(o => o.id === id)!).map(o => o.kind === 'scenery' ? 'the background' : `the ${o.category.toLowerCase()}`);
  const list = names.length < 3 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return { kind: 'local', summary: `Changing ${list}. The layout and everything else stay as they are.` };
}

/** One decision the AI made instead of asking. */
export interface AutoDecision { id: string; question: string; choice: string }
export interface AutoResolution { plan: ChangePlan; intent: CreativeIntent; decisions: AutoDecision[] }
/** The option an art director would pick for a question the rules raised. */
function chooseOption(scene: SceneDescription, draft: SceneDraft, c: PlanConflict, intent: CreativeIntent): ConflictOption | undefined {
  const usable = (o: ConflictOption | undefined) => o && o.effects.some(e => e.kind !== 'focus') ? o : undefined;
  const pick = (...ids: string[]) => ids.map(id => usable(c.options.find(o => o.id === id))).find(Boolean);
  const changedBrand = () => {
    const id = c.targetIds[c.targetIds.length - 1], o = scene.objects.find(x => x.id === id), e = draft.edits[id];
    const brand = e ? brandOfEdit(scene, e) : undefined;
    return !!o && !!e && (!sameBrand(brand, o.identity?.brand) || (!brand && !!o.identity?.brand));
  };
  if (c.id.startsWith('rule:identity:')) return pick('generic');
  if (c.id.startsWith('rule:product-brand:')) return pick('words', 'brand-1');
  // Other copies of the replaced product: a new kind of product → they go; a new brand → they become the new product too
  // (no half-old, half-new set); the same brand → they stay.
  if (c.id.startsWith('rule:set:')) {
    if (intent.kind === 'new-product') return pick('remove');
    if (!changedBrand()) return pick('keep');
    // The copies become the new product, each in its own original colour (a colour typed for one product is that one's).
    const replace = pick('replace');
    return replace ? { ...replace, effects: replace.effects.map(e => e.kind === 'edit' && e.edit.value ? { ...e, edit: { ...e.edit, value: inOwnColour(e.edit.value) } } : e) } : pick('remove');
  }
  // An accessory of the replaced product goes with it when the ad changes kind or brand; otherwise it stays.
  if (c.id.startsWith('rule:accessory:')) return intent.kind === 'new-product' || changedBrand() ? pick('remove') : pick('keep');
  // An old brand mark, offer or part the user did not ask to keep: it never stays on something it no longer describes.
  if (c.kind === 'dependency') return pick('remove', 'remove-both') ?? scoredOption(scene, draft, c, intent);
  if (c.kind === 'image-text') return pick('photo', 'words');
  // An uncertain suggestion of the resolver: applied when the ad changes product, ignored for a small change.
  if (c.id.startsWith('resolver:uncertain:')) return intent.kind === 'new-product' ? pick('apply') : pick('keep');
  return scoredOption(scene, draft, c, intent);
}
/**
 * Any other question (the resolver's own): each option scored by what it does to the scene against the user's intent.
 * A new kind of product favours removing or adapting the old offer; a change of brand favours removing what carries the
 * old brand; a small change favours keeping what is unrelated. Ties keep the resolver's own order (its recommendation).
 */
function scoredOption(scene: SceneDescription, draft: SceneDraft, c: PlanConflict, intent: CreativeIntent): ConflictOption | undefined {
  const replacedBrands = Object.entries(draft.edits).filter(([, e]) => e.action === 'replace' || e.brand).map(([id, e]) => ({ old: scene.objects.find(o => o.id === id)?.identity?.brand, now: brandOfEdit(scene, e) }))
    .filter(b => b.old && !sameBrand(b.old, b.now)).map(b => b.old!);
  const oldBrand = (id: string) => { const o = scene.objects.find(x => x.id === id), m = scene.marks.find(x => x.id === id);
    return replacedBrands.some(b => sameBrand(b, o?.identity?.brand) || (!!m && namesWord(m.text, b))); };
  const score = (option: ConflictOption) => option.effects.reduce((sum, e) => {
    if (e.kind === 'focus') return sum - 5; // "I will describe it": never chosen for the user
    if (e.kind === 'remove-reference') return sum - 1;
    if (draft.edits[e.targetId]) return sum - 3; // never against the user's own change
    const a = e.edit.action;
    if (intent.kind === 'new-product') return sum + (a === 'keep' ? -1 : 1);
    if (oldBrand(e.targetId)) return sum + (a === 'remove' || a === 'replace' ? 1 : -1);
    return sum + (a === 'keep' ? 1 : a === 'remove' ? -0.5 : 0);
  }, 0);
  return c.options.map((option, order) => ({ option, order, score: score(option) })).filter(x => x.score > -5)
    .sort((a, b) => b.score - a.score || a.order - b.order)[0]?.option;
}
/**
 * The plan of a draft with nothing left to ask: the rules (and the resolver's saved answer, if any) planned again after
 * each automatic answer. What the AI decided is recorded and marked as inferred, never as the user's own request.
 */
export function autoResolve(scene: SceneDescription, draft: SceneDraft, context: PlanContext = {}, proposal?: ResolverProposal): AutoResolution {
  const intent = creativeIntent(scene, draft), decisions: AutoDecision[] = [], reasons = new Map<string, string>();
  let working: SceneDraft = { ...draft, edits: { ...draft.edits } };
  // A new kind of product leads the ad: the old offer's other products go, the scene is restyled to suit the new one.
  if (intent.kind === 'new-product') {
    const hero = intent.hero!, plain = sceneWords(scene, draft.edits[intent.heroId!]);
    for (const o of scene.objects) {
      if (o.ignored || draft.edits[o.id] || o.id === intent.heroId) continue;
      let edit: ObjectEdit | undefined, why = '';
      // A held one goes too; the rules then let the hand rest naturally.
      if (productLike(o)) { edit = { action: 'remove' }; why = `The ad is now about ${hero}: ${o.label} does not belong in it.`; }
      // Scene wording names no brand, so a brand is never read onto a stand or a backdrop.
      else if (o.kind === 'scenery' && o.importance === 'background') { edit = { action: 'modify', value: `a fresh, premium setting that suits an advertisement for ${plain}` }; why = `The background is restyled to suit ${hero}.`; }
      else if (o.kind === 'furniture') { edit = { action: 'modify', value: `staging that suits ${plain}, or none if it needs none` }; why = `The display staging is adapted to ${hero}.`; }
      else if (o.kind === 'decoration') { edit = { action: 'modify', value: `decorations that suit ${plain}` }; why = `The decorations are adapted to ${hero}.`; }
      else if (o.kind === 'effect') { edit = { action: 'remove' }; why = `${o.label} belonged to the old scene; the new scene makes its own.`; }
      if (edit) { working.edits[o.id] = edit; reasons.set(o.id, why); decisions.push({ id: `intent:${o.id}`, question: `${o.label}`, choice: why }); }
    }
  }
  let plan = planOf(scene, working, context, proposal);
  for (let round = 0; round < 6 && plan.conflicts.length; round++) {
    for (const c of plan.conflicts) {
      const option = chooseOption(scene, working, c, intent);
      if (!option) continue;
      working = applyConflictOption(working, option).draft;
      decisions.push({ id: c.id, question: c.question, choice: option.label });
      for (const e of option.effects) if (e.kind === 'edit' && !draft.edits[e.targetId]) reasons.set(e.targetId, `AI decided: ${option.label}.`);
    }
    plan = planOf(scene, working, context, proposal);
  }
  // Anything still open stays as it is: generation is never blocked by an ordinary question.
  const left = plan.conflicts.map(c => `Kept as it is (not decided automatically): ${c.question}`);
  const entries = harmonize(scene, plan.entries.map(e => reasons.has(e.targetId) && e.source === 'explicit' ? { ...e, source: 'inferred' as const, reason: reasons.get(e.targetId)! } : e), decisions);
  const changes = entries.some(e => e.operation !== 'keep');
  plan = { ...plan, entries, conflicts: [], notes: [...plan.notes, ...left], status: changes ? 'clear' : 'unchanged', ...(intent.kind === 'new-product' ? { intent: { kind: 'new-product' as const, heroId: intent.heroId!, hero: intent.hero! } } : {}) };
  return { plan, intent, decisions };
}
/** The hero in words that name no brand or product line ("LG Washing Machine" → "a washing machine"; "the new product" when nothing else is left). */
function sceneWords(scene: SceneDescription, edit: ObjectEdit | undefined): string {
  const brands = scene.objects.map(o => o.identity?.brand ?? '').filter(Boolean), brand = edit ? brandOfEdit(scene, edit) : undefined;
  let words = sanitizeEditInstruction(edit?.value ?? '');
  if (brand) words = words.replace(new RegExp(`(^|\\s)${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  if (!words || brandInWords(words, brands)) return 'the new product';
  return article(words.toLowerCase());
}
/**
 * One fate per element, and one name per fate: an element that changes is never also kept, an entry is never listed
 * twice, and a kept text block or logo that the prompt would name exactly like a removed one goes with it (the image
 * model could not tell them apart, and "remove X … keep X" is never sent). The user's own choices are never touched.
 */
function harmonize(scene: SceneDescription, entries: PlanEntry[], decisions: AutoDecision[]): PlanEntry[] {
  const changed = new Set(entries.filter(e => e.operation !== 'keep').map(e => e.targetId)), seen = new Set<string>();
  let out = entries.filter(e => !(e.operation === 'keep' && changed.has(e.targetId))).filter(e => !seen.has(e.id) && !!seen.add(e.id));
  const named = new Map<string, PlanEntry[]>();
  for (const e of out) named.set(targetPhrase(scene, e.targetId), [...(named.get(targetPhrase(scene, e.targetId)) ?? []), e]);
  for (const [phrase, group] of named) {
    const gone = group.find(e => e.operation === 'remove'), kept = group.filter(e => e.operation === 'keep' && e.source !== 'explicit' && e.targetType !== 'object');
    if (!gone || !kept.length) continue;
    out = out.filter(e => !kept.includes(e));
    for (const k of kept) {
      out.push({ ...k, id: `inferred:${k.targetId}:remove`, operation: 'remove', source: 'inferred', reason: `It reads as ${phrase}, like text that is removed; both go so the instruction is unambiguous.` });
      decisions.push({ id: `name:${k.targetId}`, question: `${sceneTarget(scene, k.targetId)?.item.label ?? k.targetId}`, choice: 'Removed with the matching old text' });
    }
  }
  return out;
}
/** A product name without the colour typed for one product ("iPhone 18 Pro Max Midnight colour" → "iPhone 18 Pro Max, in this one's original colour"). */
const COLOUR_WORDS = /\b(?:in\s+(?:a\s+)?)?(?:[\p{L}-]+\s+)?colou?r(?:way)?\b|\b(?:black|white|silver|gold|golden|blue|red|green|pink|grey|gray|purple|yellow|orange|brown|beige|midnight|starlight|graphite|lavender|violet|teal|navy|cream|rose)\b/giu;
export function inOwnColour(value: string): string {
  const stripped = value.replace(COLOUR_WORDS, ' ').replace(/\s+/g, ' ').replace(/[\s,;-]+$/, '').trim();
  return stripped && stripped !== value.trim() ? `${stripped}, in this one's original colour` : value;
}
function planOf(scene: SceneDescription, draft: SceneDraft, context: PlanContext, proposal?: ResolverProposal): ChangePlan {
  const base = basePlan(scene, draft, context);
  return proposal ? mergeResolution(scene, draft, base, proposal).plan : base;
}
