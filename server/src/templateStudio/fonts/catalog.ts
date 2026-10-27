/**
 * THE FONT CATALOGUE: every font the AI art director may suggest.
 *
 * The planner sees each entry's family, category, description and best uses,
 * and picks one per text area to suit the template and the campaign. The
 * editor's font menu shows the same list. Brand fonts uploaded to a brand kit
 * (with a confirmed licence) are added on top of this list at runtime.
 *
 * All fonts here are SIL Open Font License 1.1 (from Google Fonts), free for
 * commercial use when bundled with the software; each folder in
 * server/assets/template-studio/fonts keeps its OFL.txt, and the README there
 * records which files are modified and how Reserved Font Names are respected.
 *
 * FrameFlow bundles the Generator families that FrameFlow's editor also offers
 * (shared/src/fonts), so text restored as native editor elements after
 * decomposition uses the same family as the rendered poster. Left out: Lato,
 * Unbounded, Dela Gothic One, Baloo 2, Mukta and Hind (over 1 MB each; the
 * renderer cannot shape Devanagari anyway) and Big Shoulders Display (not in
 * the editor's catalogue).
 *
 * To add a font:
 *   1. Put one static .ttf per weight in
 *      server/assets/template-studio/fonts/<folder>/ with its OFL.txt.
 *      Variable fonts must be instanced to static files first; text is rendered
 *      with opentype.js, which cannot read some advanced substitution tables
 *      (remove GSUB if a file fails to load; kerning is kept). A modified file
 *      must not keep a Reserved Font Name its OFL.txt declares: use the
 *      unmodified file or rename it.
 *   2. Add an entry below. Write the description for an art director: the
 *      feel of the font and where it works best.
 */

export type FontUse = "headline" | "offer" | "subheadline" | "body" | "accent";

export interface CatalogFont {
  family: string;
  category: string;
  /** What it feels like and where it works; shown to the AI and in the editor. */
  description: string;
  bestFor: FontUse[];
  /** [weight, file path relative to assets/fonts]. */
  faces: [number, string][];
}

const range = (dir: string, prefix: string, weights: number[]): [number, string][] => weights.map((w) => [w, `${dir}/${prefix}-${w}.ttf`]);

export const FONT_CATALOG: CatalogFont[] = [
  // --- Clean geometric sans: closest free matches to brand fonts like PP Telegraf --------------
  {
    family: "Poppins",
    category: "geometric sans",
    description: "Clean, modern, tech-forward; reliable for headlines and body.",
    bestFor: ["headline", "offer", "subheadline", "body"],
    faces: [[300, "poppins/Poppins-Light.ttf"], [400, "poppins/Poppins-Regular.ttf"], [500, "poppins/Poppins-Medium.ttf"], [600, "poppins/Poppins-SemiBold.ttf"], [700, "poppins/Poppins-Bold.ttf"], [800, "poppins/Poppins-ExtraBold.ttf"]],
  },
  {
    family: "Outfit",
    category: "geometric sans",
    description: "Round, friendly geometric sans with a contemporary fintech feel; very close in spirit to PP Telegraf. Bold weights make strong offer headlines.",
    bestFor: ["headline", "offer", "subheadline", "body"],
    faces: range("outfit", "Outfit", [400, 500, 600, 700, 800]),
  },
  {
    family: "Urbanist",
    category: "geometric sans",
    description: "Crisp, minimal geometric sans; modern and premium. Heavy weights work well in uppercase.",
    bestFor: ["headline", "offer", "subheadline", "body"],
    faces: range("urbanist", "Urbanist", [400, 500, 600, 700, 800, 900]),
  },
  {
    family: "Lexend",
    category: "geometric sans",
    description: "Wide, very legible geometric sans; calm and clear. Good for informative subheads and body copy.",
    bestFor: ["headline", "subheadline", "body"],
    faces: range("lexend", "Lexend", [400, 500, 600, 700, 800]),
  },
  {
    family: "Plus Jakarta Sans",
    category: "modern grotesk",
    description: "Polished startup/brand sans with slightly tight shapes; professional and modern.",
    bestFor: ["headline", "subheadline", "body"],
    faces: range("plusjakartasans", "PlusJakartaSans", [400, 500, 600, 700, 800]),
  },
  {
    family: "Manrope",
    category: "modern grotesk",
    description: "Neutral, technical sans; clean body text and understated headlines.",
    bestFor: ["subheadline", "body"],
    faces: range("manrope", "Manrope", [400, 500, 600, 700, 800]),
  },
  {
    family: "Sora",
    category: "geometric sans",
    description: "Slightly wide, techy geometric sans; digital products, payments, apps.",
    bestFor: ["headline", "subheadline", "body"],
    faces: range("sora", "Sora", [400, 600, 700, 800]),
  },

  // --- Bold display: offers, sales, campaign headlines --------------------------------------------
  {
    family: "Bricolage Grotesque",
    category: "expressive grotesk display",
    description: "Characterful, trendy display grotesk with quirky details; editorial and youthful campaigns.",
    bestFor: ["headline", "offer"],
    faces: range("bricolagegrotesque", "BricolageGrotesque", [600, 700, 800]),
  },
  {
    family: "Syne",
    category: "art display",
    description: "Distinctive, artsy display with wide bold forms; fashion, culture, creative brands.",
    bestFor: ["headline"],
    faces: range("syne", "Syne", [600, 700, 800]),
  },
  {
    family: "Rubik",
    category: "rounded sans",
    description: "Softly rounded, approachable sans; heavy weights give chunky, sticker-like offer text.",
    bestFor: ["headline", "offer", "subheadline", "body"],
    faces: range("rubik", "Rubik", [400, 500, 700, 900]),
  },
  {
    family: "Archivo Black",
    category: "heavy grotesk display",
    description: "Chunky, confident headlines; bold modern campaigns.",
    bestFor: ["headline", "offer"],
    faces: [[900, "archivoblack/ArchivoBlack-Regular.ttf"]],
  },
  {
    family: "Lilita One",
    category: "rounded heavy display",
    description: "Fat, rounded, playful display; fun offers, food, kids, casual retail. Great with sticker plates.",
    bestFor: ["headline", "offer"],
    faces: [[400, "lilitaone/LilitaOne-Regular.ttf"]],
  },
  {
    family: "Titan One",
    category: "rounded heavy display",
    description: "Bubbly, extra-heavy rounded display; loud, cheerful promotions.",
    bestFor: ["headline", "offer"],
    faces: [[400, "titanone/TitanOne-Regular.ttf"]],
  },
  {
    family: "Bungee",
    category: "signage display",
    description: "Urban signage-style caps; street, sports, gaming, bold sale banners.",
    bestFor: ["headline", "offer"],
    faces: [[400, "bungee/Bungee-Regular.ttf"]],
  },
  {
    family: "Bebas Neue",
    category: "condensed display",
    description: "Tall all-caps headlines; sporty, bold, retail sale energy.",
    bestFor: ["headline", "offer"],
    faces: [[400, "bebasneue/BebasNeue-Regular.ttf"]],
  },
  {
    family: "Anton",
    category: "condensed heavy display",
    description: "Very heavy condensed headlines; loud offers and prices.",
    bestFor: ["headline", "offer"],
    faces: [[400, "anton/Anton-Regular.ttf"]],
  },
  {
    family: "Teko",
    category: "condensed display",
    description: "Squared, condensed techy display; sports, automotive, electronics prices.",
    bestFor: ["headline", "offer"],
    faces: range("teko", "Teko", [500, 600, 700]),
  },
  {
    family: "Staatliches",
    category: "retro condensed display",
    description: "Retro poster-style caps; events, festivals.",
    bestFor: ["headline"],
    faces: [[400, "staatliches/Staatliches-Regular.ttf"]],
  },
  {
    family: "Righteous",
    category: "rounded display",
    description: "Playful, rounded retro headlines; food, kids, casual.",
    bestFor: ["headline"],
    faces: [[400, "righteous/Righteous-Regular.ttf"]],
  },


  // --- Serif and script accents ----------------------------------------------------------------------
  {
    family: "DM Serif Display",
    category: "elegant serif display",
    description: "Premium editorial headlines; jewellery, beauty, luxury.",
    bestFor: ["headline"],
    faces: [[400, "dmserifdisplay/DMSerifDisplay-Regular.ttf"]],
  },
  {
    family: "Abril Fatface",
    category: "fashion serif display",
    description: "High-contrast fashion/magazine headlines.",
    bestFor: ["headline"],
    faces: [[400, "abrilfatface/AbrilFatface-Regular.ttf"]],
  },
  {
    family: "Pacifico",
    category: "script",
    description: "Casual brush script for short accent words only.",
    bestFor: ["accent"],
    faces: [[400, "pacifico/Pacifico-Regular.ttf"]],
  },
];
