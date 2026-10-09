/**
 * Brands the user's own words name, read locally (no model call), for any product category. Two sources:
 *
 *   - the brands the image itself shows: every product identity and printed brand mark the analysis found (so a brand
 *     of any category, known or not, is recognised when the user writes it);
 *   - a small, non-exhaustive seed of widely known brand names and product lines of one brand ("Galaxy" is Samsung's),
 *     a fast path only.
 *
 * Neither is the system's knowledge of brands: anything else (an unfamiliar brand, a line not listed) is read by the
 * resolver model, whose answer is accepted only when the user's own words name it. Whole words only, so "Mi" is never
 * found in "minimal"; words naming two different brands are ambiguous and asked, never guessed.
 */

/** Brands as they are written; matched whole-word and case-insensitively. Short or common-word names are left out. */
export const KNOWN_BRANDS = [
  'Apple', 'Samsung', 'Xiaomi', 'OnePlus', 'Oppo', 'Vivo', 'Realme', 'Google', 'Motorola', 'Nokia', 'Sony', 'LG', 'Huawei', 'Honor', 'Tecno', 'Infinix',
  'Lava', 'Micromax', 'iQOO', 'Asus', 'Lenovo', 'Dell', 'HP', 'Acer', 'Microsoft', 'Amazon', 'boAt', 'JBL', 'Bose', 'Sennheiser', 'Marshall', 'Philips',
  'Panasonic', 'Whirlpool', 'Haier', 'Bosch', 'Godrej', 'Voltas', 'IFB', 'Havells', 'Bajaj', 'Prestige', 'Kent', 'Aquaguard', 'Dyson', 'Canon', 'Nikon',
  'Fujifilm', 'GoPro', 'Titan', 'Fossil', 'Casio', 'Garmin', 'Fitbit', 'Nike', 'Adidas', 'Puma', 'Reebok', 'Levi\'s', 'Zara', 'Coca-Cola', 'Pepsi',
] as const;
/** Product lines that belong to exactly one brand. */
export const PRODUCT_LINES: Record<string, string> = {
  iPhone: 'Apple', iPad: 'Apple', MacBook: 'Apple', iMac: 'Apple', AirPods: 'Apple', 'Apple Watch': 'Apple',
  Galaxy: 'Samsung', Pixel: 'Google', Redmi: 'Xiaomi', Poco: 'Xiaomi', Mijia: 'Xiaomi', Moto: 'Motorola', ThinkPad: 'Lenovo', IdeaPad: 'Lenovo',
  Bravia: 'Sony', PlayStation: 'Sony', Xbox: 'Microsoft', Kindle: 'Amazon', Rockerz: 'boAt', Airdopes: 'boAt', 'Air Jordan': 'Nike',
};
/** Short forms a brand also advertises under; matched only as written ("Mi", never the word "mi"). */
export const BRAND_ALIASES: Record<string, string> = { Mi: 'Xiaomi', Coke: 'Coca-Cola' };

/**
 * Names that are also everyday words ("apple green", "a galaxy pattern", "lava lamp", "honor"): they count only written
 * as a name (capitalized as here) and never right before a colour word.
 */
const EVERYDAY_WORDS = new Set(['Apple', 'Lava', 'Honor', 'Titan', 'Prestige', 'Puma', 'Amazon', 'Kent', 'Marshall', 'Vivo', 'Galaxy', 'Pixel', 'Moto', 'Kindle', 'Poco']);
const COLOUR_AFTER = /^[\s-]+(?:green|red|white|black|blue|pink|yellow|orange|purple|grey|gray|gold|silver|brown|tone|toned|colou?r(?:ed)?|shade|shaped)\b/i;
/** The same brand, whatever its case ("xiaomi" is "Xiaomi"). */
export const sameBrand = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLocaleLowerCase() === b.toLocaleLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` has `word` as a whole word (letters and digits are word characters, in any script). */
export function namesWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
/** A brand or line named in the text: whole word; an everyday word or a short form only as written (or in capitals), not as a colour. */
function namesBrand(text: string, name: string): boolean {
  const alias = Object.keys(BRAND_ALIASES).find(a => sameBrand(a, name)), written = alias ?? name;
  if (!EVERYDAY_WORDS.has(written) && !alias) return namesWord(text, name);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(?:${escape(written)}|${escape(written.toLocaleUpperCase())})(?=$|[^\\p{L}\\p{N}])`, 'gu');
  for (let m = re.exec(text); m; m = re.exec(text)) if (!COLOUR_AFTER.test(text.slice(m.index + m[0].length))) return true;
  return false;
}
export type BrandReading =
  | { brand: string; via: 'brand' }
  | { brand: string; via: 'line'; line: string }
  | { ambiguous: string[] };
/**
 * The one brand the words name (written out, or by a product line), the brands when they name several, or undefined.
 * A product line and its own brand together ("Samsung Galaxy") are one brand.
 */
export function brandInWords(text: string | undefined, seen: readonly string[] = []): BrandReading | undefined {
  if (!text?.trim()) return undefined;
  const found = new Map<string, { via: 'brand' | 'line'; line?: string }>();
  // The image's own brands first (written as the analysis read them), then the seed; one entry per brand, whatever its case.
  // A brand mark that is a line or short form of a seed brand ("Redmi", "mi") is that brand, never a second one.
  for (const name of [...seen, ...KNOWN_BRANDS]) {
    if (name.trim().length < 2 || !namesBrand(text, name)) continue;
    const owner = seedBrandOf(name), brand = owner ?? name, line = Object.keys(PRODUCT_LINES).find(l => sameBrand(l, name));
    if (![...found.keys()].some(b => sameBrand(b, brand))) found.set(brand, owner && line ? { via: 'line', line } : { via: 'brand' });
  }
  for (const [line, brand] of Object.entries(PRODUCT_LINES)) if (namesBrand(text, line) && ![...found.keys()].some(b => sameBrand(b, brand))) found.set(brand, { via: 'line', line });
  if (found.size > 1) return { ambiguous: [...found.keys()] };
  const [entry] = found.entries();
  if (!entry) return undefined;
  const [brand, how] = entry;
  return how.via === 'line' ? { brand, via: 'line', line: how.line! } : { brand, via: 'brand' };
}
/** The brand a product line or short form of the seed belongs to ("Redmi" and "Mi" are Xiaomi's), if any. */
export const seedBrandOf = (name: string | undefined) => !name ? undefined : Object.entries({ ...PRODUCT_LINES, ...BRAND_ALIASES }).find(([n]) => sameBrand(n, name))?.[1];
/** The seed's other names for a brand: its short forms and its product lines. */
export const seedNamesOf = (brand: string | undefined) => ({
  aliases: Object.entries(BRAND_ALIASES).filter(([, b]) => sameBrand(b, brand)).map(([n]) => n),
  lines: Object.entries(PRODUCT_LINES).filter(([, b]) => sameBrand(b, brand)).map(([n]) => n),
});
/** Whether the text names a brand-like name: whole word; `asWritten` (like an everyday word or a short form of the seed) only as written or in capitals. */
export function namesName(text: string, name: string, asWritten = false): boolean {
  if (!asWritten) return namesBrand(text, name);
  return new RegExp(`(^|[^\\p{L}\\p{N}])(?:${escape(name)}|${escape(name.toLocaleUpperCase())})($|[^\\p{L}\\p{N}])`, 'u').test(text);
}
