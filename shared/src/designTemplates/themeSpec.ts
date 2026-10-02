/** Bounded design input. This is data, never executable markup, geometry or an asset address. */
import { isCatalogFont } from '../fonts/catalog.js';
export const THEME_STYLES = ['sale', 'premium', 'product', 'greeting', 'event'] as const;
export const THEME_LAYOUTS = ['OFFER_LEFT_PRODUCT_RIGHT', 'CENTERED_SALE', 'PRODUCT_CENTER', 'EDITORIAL_GREETING', 'EVENT_PROMO', 'SPLIT_LAYOUT'] as const;
export const THEME_DECORATIONS = ['DIYA', 'LANTERN', 'RANGOLI_CORNER', 'SPARKLES', 'ARCH', 'GOLD_RING', 'BOKEH', 'FLOWER_ACCENT'] as const;
export const THEME_BACKGROUNDS = ['SOLID', 'GRADIENT', 'RADIAL_GLOW', 'FESTIVE_PATTERN', 'DARK_PREMIUM'] as const;
export interface ThemeSpec {
  templateName: string; style: typeof THEME_STYLES[number];
  palette: { background: string; primary: string; accent: string; text: string };
  typography: { headline: string; offer: string; body: string; cta: string };
  content: { eyebrow: string; headline: string; subheadline: string; offerPrefix: string; offerValue: string; offerSuffix: string; cta: string; terms: string; date: string; location: string };
  layout: { archetype: typeof THEME_LAYOUTS[number]; heroPlacement: 'left' | 'right' | 'center'; textAlignment: 'left' | 'center' };
  background: typeof THEME_BACKGROUNDS[number]; decorations: (typeof THEME_DECORATIONS[number])[];
  slots: { logo: boolean; product: boolean; heroImage: boolean };
}
export interface OfferTemplateMetadata { version: 1; source: 'curated' | 'ai'; definitionId: string; festival: 'diwali'; spec: ThemeSpec }
export class ThemeSpecError extends Error { constructor(message: string) { super(message); this.name = 'ThemeSpecError'; } }
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ThemeSpecError('Theme fields must be objects.');
  return v as Record<string, unknown>;
};
const text = (v: unknown, field: string, max: number, required = false) => {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || (/[<>]|javascript:|data:|https?:\/\//i.test(v) || [...v].some(char=>char.charCodeAt(0)<9))) throw new ThemeSpecError(`Invalid ${field}: use plain text, at most ${max} characters.`);
  return v.trim();
};
const choice = <T extends string>(v: unknown, values: readonly T[], field: string): T => {
  if (!values.includes(v as T)) throw new ThemeSpecError(`Unsupported ${field}.`);
  return v as T;
};
/** Unknown properties are refused; omitted optional copy/slots get predictable defaults. */
export function parseThemeSpec(value: unknown): ThemeSpec {
  const v = object(value);
  const keys = ['templateName','style','palette','typography','content','layout','background','decorations','slots'];
  if (Object.keys(v).some(k => !keys.includes(k))) throw new ThemeSpecError('Unknown theme field.');
  const p = object(v.palette), t = object(v.typography), c = object(v.content), l = object(v.layout), s = object(v.slots ?? {});
  const exact = (record: Record<string, unknown>, allowed: string[]) => { if (Object.keys(record).some(k=>!allowed.includes(k))) throw new ThemeSpecError('Unknown theme property.'); };
  exact(p,['background','primary','accent','text']); exact(t,['headline','offer','body','cta']);
  exact(c,['eyebrow','headline','subheadline','offerPrefix','offerValue','offerSuffix','cta','terms','date','location']);
  exact(l,['archetype','heroPlacement','textAlignment']); exact(s,['logo','product','heroImage']);
  const color = (key: string) => { if (typeof p[key] !== 'string' || !/^#[\da-f]{6}$/i.test(p[key])) throw new ThemeSpecError(`Invalid ${key} color.`); return p[key] as string; };
  const font = (key: string) => { if (!isCatalogFont(t[key])) throw new ThemeSpecError(`Unsupported ${key} font.`); return t[key] as string; };
  const slot = (key: string, fallback: boolean) => { if (s[key] === undefined) return fallback; if (typeof s[key] !== 'boolean') throw new ThemeSpecError(`Invalid ${key} slot.`); return s[key] as boolean; };
  const decorations = v.decorations ?? [];
  if (!Array.isArray(decorations) || decorations.length > 6) throw new ThemeSpecError('Choose at most six decorations.');
  return {
    templateName: text(v.templateName,'template name',100,true), style: choice(v.style,THEME_STYLES,'creative type'),
    palette: { background:color('background'),primary:color('primary'),accent:color('accent'),text:color('text') },
    typography: { headline:font('headline'),offer:font('offer'),body:font('body'),cta:font('cta') },
    content: { eyebrow:text(c.eyebrow,'eyebrow',60),headline:text(c.headline,'headline',140,true),subheadline:text(c.subheadline,'support copy',240),offerPrefix:text(c.offerPrefix,'offer prefix',40),offerValue:text(c.offerValue,'offer',160),offerSuffix:text(c.offerSuffix,'offer suffix',50),cta:text(c.cta,'CTA',60,true),terms:text(c.terms,'terms',240),date:text(c.date,'date',80),location:text(c.location,'location',120) },
    layout: { archetype:choice(l.archetype,THEME_LAYOUTS,'layout'),heroPlacement:choice(l.heroPlacement,['left','right','center'],'product position'),textAlignment:choice(l.textAlignment,['left','center'],'alignment') },
    background:choice(v.background,THEME_BACKGROUNDS,'background'),decorations:[...new Set(decorations.map(d=>choice(d,THEME_DECORATIONS,'decoration')))],
    slots:{logo:slot('logo',true),product:slot('product',true),heroImage:slot('heroImage',false)},
  };
}
const str = { type:'string' };
const enumeration = (values: readonly string[]) => ({ type:'string',enum:values });
const record = (properties: Record<string, unknown>) => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
/** Strict structured response schema; runtime validation also enforces lengths, catalog membership and colors. */
export const THEME_SPEC_SCHEMA = record({
  templateName:str,style:enumeration(THEME_STYLES),palette:record({background:str,primary:str,accent:str,text:str}),
  typography:record({headline:str,offer:str,body:str,cta:str}),
  content:record(Object.fromEntries(['eyebrow','headline','subheadline','offerPrefix','offerValue','offerSuffix','cta','terms','date','location'].map(k=>[k,str]))),
  layout:record({archetype:enumeration(THEME_LAYOUTS),heroPlacement:enumeration(['left','right','center']),textAlignment:enumeration(['left','center'])}),
  background:enumeration(THEME_BACKGROUNDS),decorations:{type:'array',items:enumeration(THEME_DECORATIONS),maxItems:6},
  slots:record({logo:{type:'boolean'},product:{type:'boolean'},heroImage:{type:'boolean'}}),
});
export function parseThemePrompt(value: unknown): string {
  const v=object(value);
  if(Object.keys(v).some(k=>k!=='prompt') || typeof v.prompt!=='string' || !v.prompt.trim() || v.prompt.length>2000) throw new ThemeSpecError('Describe your creative in 1–2,000 characters.');
  return v.prompt.trim();
}
