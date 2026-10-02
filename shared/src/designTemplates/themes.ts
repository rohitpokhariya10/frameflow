/** Local offer-creative design systems. Registration data and native CanvasElements only; no AI or remote artwork. */
import { createTemplateElement, orderElements } from './editing.js';
import { DESIGN_ASPECT_RATIOS, TEMPLATE_LIMITS, TemplateError, type DesignAspectRatio, type DesignTemplate, type NormalizedLayout, type TemplateElement, type TemplateTextElement } from './schema.js';
import { elementAtRatio } from './responsive.js';
export type ThemeTextRole = 'eyebrow' | 'headline' | 'subheading' | 'offer-value' | 'cta' | 'terms';
export interface OfferTheme {
  id: string; name: string; description: string; light?: boolean; motif: 'lights' | 'coins' | 'color';
  palette: { background: string; surface: string; gold: string; accent: string; ink: string; muted: string };
  extraColors?: readonly string[];
  typography: { heading: string; body: string; offer: string; headingWeight?: 400 | 600 | 700 };
  recommendations: { offers?: readonly string[]; headings: readonly string[]; body: readonly string[] };
  content: Record<ThemeTextRole, string>;
  ratioLayouts: Record<DesignAspectRatio, Record<string, NormalizedLayout>>;
}
const box = (x: number, y: number, width: number, height: number, rotation = 0): NormalizedLayout => ({ x, y, width, height, rotation });
/** Safe content bounds: 6% sides; story also protects the top/bottom interface zones. */
export const THEME_SAFE_AREAS: Record<DesignAspectRatio, NormalizedLayout> = {
  '1:1': box(.06,.06,.88,.88), '4:5': box(.06,.06,.88,.88), '3:4': box(.06,.06,.88,.88), '9:16': box(.07,.09,.86,.82), '16:9': box(.06,.07,.88,.86),
};
const horizontal = {
  'logo-slot': box(.07,.07,.2,.065), eyebrow: box(.07,.2,.48,.035), headline: box(.07,.265,.49,.2),
  subheading: box(.07,.49,.43,.08), 'offer-value': box(.09,.605,.41,.12), 'offer-badge': box(.07,.59,.46,.15),
  'hero-image-slot': box(.61,.25,.31,.43), 'hero-stage': box(.57,.21,.38,.54), cta: box(.07,.78,.38,.075), terms: box(.07,.885,.6,.025),
};
const portrait = (tall: boolean) => ({
  'logo-slot': box(.08,.065,.22,.055), eyebrow: box(.08,.16,.84,.03), headline: box(.08,.205,.84,.155),
  subheading: box(.08,.38,.82,.055), 'hero-image-slot': box(.48,.505,.4,tall ? .22 : .23), 'hero-stage': box(.44,.465,.49,.31),
  'offer-value': box(.095,.54,.33,.145), 'offer-badge': box(.07,.51,.37,.205), cta: box(.08,.805,.6,.065), terms: box(.08,.905,.8,.025),
});
const story = {
  'logo-slot': box(.09,.1,.28,.045), eyebrow: box(.09,.18,.82,.025), headline: box(.09,.215,.82,.12),
  subheading: box(.09,.35,.8,.045), 'hero-image-slot': box(.275,.435,.45,.2), 'hero-stage': box(.16,.41,.68,.25),
  'offer-value': box(.145,.69,.71,.07), 'offer-badge': box(.09,.675,.82,.105), cta: box(.19,.81,.62,.047), terms: box(.09,.885,.82,.02),
};
const wide = {
  'logo-slot': box(.07,.085,.17,.075), eyebrow: box(.07,.225,.47,.045), headline: box(.07,.305,.48,.21),
  subheading: box(.07,.55,.45,.065), 'offer-value': box(.087,.65,.435,.1), 'offer-badge': box(.07,.635,.47,.13),
  'hero-image-slot': box(.665,.255,.22,.49), 'hero-stage': box(.59,.2,.35,.61), cta: box(.07,.815,.26,.075), terms: box(.36,.85,.21,.035),
};
const layouts = { '1:1': horizontal, '4:5': portrait(false), '3:4': portrait(true), '9:16': story, '16:9': wide };
const body = ['Poppins', 'Hind', 'Mukta', 'Noto Sans Devanagari'];
export const OFFER_THEMES: readonly OfferTheme[] = [
  { id: 'diwali', name: 'Diwali', description: 'Festival lights & warm gold', motif: 'lights',
    palette: { background:'#351024', surface:'#641C3B', gold:'#F2C979', accent:'#EE8650', ink:'#FFF2D7', muted:'#DBC2C8' },
    typography: { heading:'Yatra One', body:'Poppins', offer:'Poppins' }, recommendations: { headings:['Yatra One','Tiro Devanagari Hindi','DM Serif Display','Cinzel'], body },
    content: { eyebrow:'FESTIVE SPECIAL', headline:'Celebrate More,\nSave More', subheading:'Special Diwali offers\nfor a limited time', 'offer-value':'UP TO 40% OFF', cta:'Explore Offers  →', terms:'*T&C apply' }, ratioLayouts: layouts },
  { id: 'dhanteras', name:'Dhanteras', description:'Prosperity in emerald & gold', motif:'coins',
    palette: { background:'#082F2A', surface:'#16483D', gold:'#E8C481', accent:'#B88948', ink:'#FFF2D5', muted:'#AFC7B9' },
    typography: { heading:'Cinzel', body:'Poppins', offer:'Poppins' }, recommendations: { headings:['Cinzel','Cormorant Garamond','DM Serif Display','Tiro Devanagari Hindi'], body },
    content: { eyebrow:'DHANTERAS SPECIAL', headline:'Bring Home More\nThis Dhanteras', subheading:'Celebrate prosperity with\nspecial festive savings', 'offer-value':'UP TO 30% OFF', cta:'View Offers  →', terms:'*T&C apply' }, ratioLayouts: layouts },
  { id:'holi', name:'Holi', description:'Playful colour, joyful savings', light:true, motif:'color',
    palette: { background:'#FFF8EF', surface:'#F8DBEA', gold:'#FCC949', accent:'#D72679', ink:'#362052', muted:'#715F80' },
    extraColors:['#25B8CA','#EA743C','#8858AD'],
    typography: { heading:'Baloo 2', body:'Poppins', offer:'Baloo 2', headingWeight:600 }, recommendations: { headings:['Baloo 2','Fredoka','Bungee','Luckiest Guy'], body },
    content: { eyebrow:'HOLI SPECIAL', headline:'Color Your Cart\nWith Savings', subheading:'Bright offers for a\nbrighter celebration', 'offer-value':'FLAT 30% OFF', cta:'Grab The Offer  →', terms:'*T&C apply' }, ratioLayouts: layouts },
];
export const offerTheme = (id?: string) => OFFER_THEMES.find(theme => theme.id === id);
export const themeColors = (theme?: OfferTheme): string[] => theme ? [...new Set([...Object.values(theme.palette), ...(theme.extraColors ?? [])])] : [];
export function themeFonts(theme: OfferTheme, role?: string) { if (['offer-value','offer-prefix','offer-suffix','offer'].includes(role ?? '') && theme.recommendations.offers) return theme.recommendations.offers; return ['headline','offer-value','heading','offer'].includes(role ?? '') ? theme.recommendations.headings : theme.recommendations.body; }
const textToken = (theme: OfferTheme, role: ThemeTextRole) => ({
  fontFamily: role === 'headline' ? theme.typography.heading : role === 'offer-value' ? theme.typography.offer : theme.typography.body,
  fontSize: ({ eyebrow:.018, headline:.074, subheading:.024, 'offer-value':.051, cta:.026, terms:.016 })[role],
  fontWeight: (role === 'headline' ? (theme.typography.headingWeight ?? 400) : ['cta','offer-value'].includes(role) ? 700 : 400) as 400|600|700,
  color: role === 'cta' || role === 'offer-value' ? (theme.light ? theme.palette.ink : theme.palette.background) : role === 'eyebrow' ? (theme.light ? theme.palette.accent : theme.palette.gold) : ['subheading','terms'].includes(role) ? theme.palette.muted : theme.palette.ink,
});
function responsive(theme: OfferTheme, role: string) {
  return Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r => [r, theme.ratioLayouts[r][role]])) as Record<DesignAspectRatio, NormalizedLayout>;
}
/** All motifs are editable native shapes; no asset storage, fetched URLs or hidden text baked into artwork. */
export function buildThemeStarter(theme: OfferTheme): TemplateElement[] {
  const elements: TemplateElement[] = [];
  const add = (element: TemplateElement, role: string, name: string, layout?: NormalizedLayout) => {
    const ratioLayouts = layout ? undefined : responsive(theme, role);
    elements.push({ ...element, id:`theme-${role}`, name, themeRole:role, zIndex:elements.length, layout:layout ?? ratioLayouts!['1:1'], ...(ratioLayouts ? { ratioLayouts } : {}) });
  };
  const shape = (role: string, name: string, fill: string, layout?: NormalizedLayout, options: { ellipse?: boolean; opacity?: number; stroke?: string; radius?: number; gradient?: { from:string; to:string; angle:number } } = {}) => {
    const e = createTemplateElement(options.ellipse ? 'ellipse' : 'rounded-rectangle', role, 0);
    if (e.type !== 'shape') return;
    add({ ...e, style:{ ...e.style, fill, opacity:options.opacity ?? 1, cornerRadius:options.radius ?? .2, stroke:options.stroke ?? null, strokeWidth: options.stroke ? .0015 : 0, ...(options.gradient ? { gradient:options.gradient } : {}) } }, role,name,layout);
  };
  const bg = createTemplateElement('background','background',0);
  if (bg.type === 'background') add({ ...bg, defaultContent:{ color:theme.palette.background, assetId:null } },'theme-background','Theme background',box(0,0,1,1));
  // Framing rails and restrained top lights unify the visual system without obscuring content.
  shape('theme-decoration-rail','Fine festive border',theme.palette.gold,box(.025,.025,.95,.005));
  shape('theme-decoration-footer','Fine footer border',theme.palette.gold,box(.025,.965,.95,.005));
  shape('hero-stage','Product display arch',theme.palette.surface,undefined,{radius:1, gradient:{ from:theme.palette.surface,to:theme.palette.background,angle:75 },stroke:theme.palette.gold});
  for (let i=0;i<5;i++) {
    const x=.61+i*.065;
    if (theme.motif === 'lights') {
      shape(`theme-decoration-thread-${i}`,'Golden hanging thread',theme.palette.gold,box(x,.025,.005,.038+i%2*.025));
      shape(`theme-decoration-light-${i}`,'Festive light',theme.palette.gold,box(x-.006,.062+i%2*.025,.018,.018),{ellipse:true});
    } else if (theme.motif === 'coins') {
      shape(`theme-decoration-coin-${i}`,'Prosperity coin',theme.palette.accent,box(x,.055+i%2*.014,.04,.04),{ellipse:true,stroke:theme.palette.gold});
    } else {
      shape(`theme-decoration-color-${i}`,'Colour confetti',['#D72679','#25B8CA','#FCC949','#EA743C','#8858AD'][i],box(x,.045+i%2*.025,.025,.025),{ellipse:true});
    }
  }
  if (theme.motif === 'lights') {
    // A restrained rangoli rosette frames the lamp; each petal stays a native editable ellipse.
    for (let i=0;i<8;i++) {
      const angle=i*Math.PI/4;
      shape(`theme-decoration-rangoli-${i}`,'Rangoli petal',theme.palette.gold,box(.874+Math.cos(angle)*.073-.016,.85+Math.sin(angle)*.073-.031,.032,.062,i*45),{ellipse:true,opacity:.18,stroke:theme.palette.gold});
    }
    shape('theme-decoration-diya-base','Diya bowl',theme.palette.accent,box(.83,.845,.095,.035),{ellipse:true});
    shape('theme-decoration-diya-flame','Diya flame',theme.palette.gold,box(.865,.8,.025,.053),{ellipse:true});
    shape('theme-decoration-diya-glow','Warm diya glow',theme.palette.gold,box(.82,.79,.12,.105),{ellipse:true,opacity:.12});
  } else if (theme.motif === 'coins') {
    for (let i=0;i<5;i++) shape(`theme-decoration-engraving-${i}`,'Coin engraving',theme.palette.accent,box(.617+i*.065,.062+i%2*.014,.026,.026),{ellipse:true,stroke:theme.palette.gold});
    for (let i=0;i<3;i++) shape(`theme-decoration-stack-${i}`,'Gold coin stack',theme.palette.accent,box(.82,.85-i*.013,.105,.026),{ellipse:true,stroke:theme.palette.gold});
  } else {
    // A local colour burst, with tapered oval marks and fine powder dots, rather than remote artwork.
    for (let i=0;i<12;i++) {
      const a=i*Math.PI/6, color=['#D72679','#25B8CA','#FCC949','#EA743C','#8858AD'][i%5];
      shape(`theme-decoration-gulal-${i}`,'Gulal burst',color,box(.865+Math.cos(a)*.077-.009,.85+Math.sin(a)*.077-.02,.018,.04,i*30),{ellipse:true,opacity:.65});
    }
    shape('theme-decoration-pink','Gulal pink', '#D72679',box(.8,.79,.13,.105),{ellipse:true,opacity:.9});
    shape('theme-decoration-cyan','Gulal cyan','#25B8CA',box(.86,.84,.09,.09),{ellipse:true,opacity:.8});
    shape('theme-decoration-yellow','Gulal yellow','#FCC949',box(.765,.875,.07,.06),{ellipse:true});
  }
  shape('offer-badge','Offer badge',theme.palette.gold,undefined,{radius:theme.motif==='color'?.55:.15});
  for (const [role,name,kind] of [['hero-image-slot','PRODUCT / HERO IMAGE','product'],['logo-slot','YOUR LOGO','logo']] as const) {
    const e=createTemplateElement(kind,role,0);
    if(e.type==='image')add({...e,behavior:{...e.behavior,fit:'contain'}},role,name);
  }
  for (const role of ['eyebrow','headline','subheading','offer-value','cta','terms'] as const) {
    const e = createTemplateElement(role === 'headline' ? 'heading' : role === 'offer-value' ? 'offer' : role === 'terms' || role === 'eyebrow' ? 'generic-text' : role,role,0) as TemplateTextElement;
    const token=textToken(theme,role);
    add({ ...e, defaultContent:{text:theme.content[role]}, editableProperties:{...e.editableProperties,fontFamily:true}, style:{...e.style,...token,lineHeight:role==='headline'?1.12:1.25,letterSpacing:role==='eyebrow'?.12:0,
      align:role==='offer-value'||role==='cta'?'center':'left',verticalAlign:'middle',backgroundColor:role==='cta'?theme.palette.gold:null,cornerRadius:role==='cta'?.2:0},
      behavior:{maxLines:role==='headline'?2:role==='offer-value'?4:role==='terms'?2:3,overflow:'shrink',minFontSize:['terms','eyebrow'].includes(role)?.012:.019} },role,({eyebrow:'Eyebrow',headline:'Headline',subheading:'Subheading','offer-value':'Offer',cta:'CTA',terms:'Terms'})[role]);
  }
  // Decorative motifs keep their physical proportions; anchor the whole corner motif together.
  for (const e of elements) if (e.themeRole?.startsWith('theme-decoration-') && !e.themeRole.endsWith('rail') && !e.themeRole.endsWith('footer') && !e.themeRole.includes('thread')) {
    const b=e.layout;
    e.ratioLayouts=Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{
      const [w,h]=r.split(':').map(Number),sx=Math.min(w,h)/w,sy=Math.min(w,h)/h;
      const corner=b.y>.7,ax=corner?.87:b.x+b.width/2,ay=corner?.85:b.y+b.height/2;
      return [r,box(ax+(b.x-ax)*sx,ay+(b.y-ay)*sy,b.width*sx,b.height*sy,b.rotation)];
    }));
  }
  return orderElements(elements);
}
const decoration = (e:TemplateElement) => !!e.themeRole && (/^(theme-decoration-|decoration-|background-decoration|frame-|arch-)/.test(e.themeRole) || ['hero-stage','premium-frame','product-stage','event-ticket'].includes(e.themeRole));
/** Styling preserves IDs, content, assets, user layers and ratio geometry. Only theme-owned ornaments are replaced. */
export function applyOfferTheme(template: DesignTemplate, themeId: string, mode:'style'|'replace'): DesignTemplate {
  const theme=offerTheme(themeId); if (!theme) throw new TemplateError('UNKNOWN_THEME','Choose an available theme.');
  if (template.themeId===themeId && mode==='style') return template;
  const {offerTemplate:_offer,...legacy}=template; void _offer; template=legacy;
  const starter=buildThemeStarter(theme);
  if (mode==='replace' || !template.elements.length) return {...template,themeId,elements:starter};
  const source=new Map(starter.map(e=>[e.themeRole,e]));
  const kept=template.elements.filter(e=>!decoration(e)).map(e=> {
    const aliases:Record<string,string>={background:'theme-background',logo:'logo-slot',product:'hero-image-slot',subheadline:'subheading','offer-prefix':'eyebrow','offer-suffix':'eyebrow',date:'subheading',location:'subheading'};
    const match=source.get(aliases[e.themeRole ?? ''] ?? e.themeRole);
    if (match && match.type===e.type) return {...e,style:{...match.style},...(e.type==='background'?{defaultContent:{...e.defaultContent,color:theme.palette.background}}:{})} as TemplateElement;
    return e; // Unrelated custom elements are deliberately not restyled.
  });
  const additions=starter.filter(decoration).map((e,i)=>({...e,id:`${template.id}-${themeId}-decoration-${i}`}));
  if (kept.length+additions.length>TEMPLATE_LIMITS.maxElements) throw new TemplateError('TOO_MANY_ELEMENTS','Not enough room for theme decorations. Remove a few elements or choose Replace starter.');
  return {...template,themeId,elements:orderElements([...additions.map((e,i)=>({...e,zIndex:i})),...kept.map((e,i)=>({...e,zIndex:i+additions.length}))])};
}
/** Freeze the currently previewed layout; retain every layer, copy, asset and font, and relinquish theme ownership. */
export function clearOfferTheme(template:DesignTemplate, ratio:DesignAspectRatio):DesignTemplate {
  const {themeId:_theme,offerTemplate:_offer,...rest}=template; void _theme; void _offer;
  return {...rest,elements:template.elements.map(e=> {const {themeRole:_role,...element}=elementAtRatio(e,ratio);void _role;return element as TemplateElement;})};
}
export function applyThemePairing(template:DesignTemplate):DesignTemplate {
  const theme=offerTheme(template.themeId); if(!theme)return template;
  return {...template,elements:template.elements.map(e=>e.type==='text'&&e.themeRole&&e.themeRole in theme.content?{...e,style:{...e.style,fontFamily:textToken(theme,e.themeRole as ThemeTextRole).fontFamily,fontWeight:textToken(theme,e.themeRole as ThemeTextRole).fontWeight}}:e)};
}
