/**
 * Words that say what a planned element or a provider layer is, for protecting people in decompositions: the planner's
 * normalization (semanticPlanner.ts) and the layer grouping after Seedream (interactionGrouping.ts) read names with the
 * same vocabulary. Matching is by whole words, case-insensitive; geometry always has the last word in the grouping.
 */
const words = (list: string) => new RegExp(`\\b(?:${list})\\b`, 'i');

/** A person or a part of one: the parent that hands, fingers, held objects and worn items stay with. */
export const PERSON = words('woman|women|man|men|girl|girls|boy|boys|person|persons|people|model|models|lady|ladies|child|children|kid|kids|baby|bride|groom|dancers?|couple|family|human|humans|subject|hands?|arms?|forearms?|wrists?|palms?|portrait|figure|customer|athlete|player|student|mother|father|person_anatomy');
/** A body part on its own (not a whole person): it goes back to the person it was cut from when it touches one. */
export const BODY_PART = words('hands?|arms?|forearms?|wrists?|palms?|elbows?|shoulders?|legs?|feet|foot');
export const WHOLE_PERSON = words('woman|women|man|men|girl|girls|boy|boys|person|persons|people|model|models|lady|ladies|child|children|kid|kids|baby|bride|groom|dancers?|couple|family|human|humans|subject|portrait|figure|customer|athlete|player|student|mother|father');
/** A piece of a hand that only exists because a grip interleaves with what it holds. */
export const FRAGMENT = words('fingers?|fingertips?|thumbs?|knuckles?|fragments?|grip|gripping|occlusion|occluding');
/** Worn or attached jewelry and accessories. */
export const ORNAMENT = words('bangles?|bracelets?|rings?|earrings?|necklaces?|pendants?|chains?|jewel\\w*|ornaments?|anklets?|bindis?|kadas?|kadga|churi|chudi|mangalsutra|tikka|brooch\\w*|watch(?:es)?|wristwatch\\w*|wristbands?|bands?|accessor\\w*|hairpins?|hair ?clips?|nose ?pins?|nath|cuffs?');
/** Text-like layers: never merged into a person, whatever other words they carry ("BANGLES OF INDIA" headline). */
export const TEXTISH = /["“”]|\b(?:text|texts|headline|heading|title|caption|label|labels|logo|logos|logotype|wordmark|lettering|typography|copy|paragraph|tagline|slogan|price|prices|footer|url|disclaimer|legal)\b/i;
/** Lighting and shadow layers: never a person, even when they name one ("dancer cast shadows"). */
export const EFFECT = words('shadows?|glow|glows|reflections?|highlights?|vignette|light|lighting|rays?|flares?');

/**
 * The scene and its design: backgrounds, atmosphere (glow, vignette, lighting) and large brand shapes (a curved field, a
 * wedge, a sweep). Large layers named this way are background, never removed from it.
 */
export const SCENE = words('background|backdrop|wall|floor|sky|gradient|vignette|glow|lighting|light|studio|scene|canvas|field|wedge|curve|curved|swoosh|sweep|wave|blob|backplate|surface');
/** `my_id_name` → "my id name", for matching ids with layer names. */
export const idWords = (id: string) => id.replace(/[_-]+/g, ' ');
