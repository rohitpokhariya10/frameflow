/** Curated definitions and planned themes compile to the existing CanvasElement model. */
import { createTemplateElement, orderElements } from './editing.js';
import { DESIGN_ASPECT_RATIOS, assertDesignTemplate, type DesignTemplate, type DesignAspectRatio, type NormalizedLayout, type TemplateElement, type TemplateTextElement } from './schema.js';
import { isPremiumLayout, parseThemeSpec, type ThemeSpec, type OfferTemplateMetadata } from './themeSpec.js';
import { PREMIUM_DIWALI_TEMPLATES } from './premiumDefinitions.js';
import { compilePremiumTemplate } from './premiumCompiler.js';
import { premiumLayout } from './premiumLayouts.js';
import type { OfferTheme } from './themes.js';
export interface OfferTemplateDefinition { id: string; name: string; festival: 'diwali'; category: string; description: string; spec: ThemeSpec }
const base: ThemeSpec = {
  templateName:'Diwali Mega Sale',style:'sale',palette:{background:'#281035',primary:'#642050',accent:'#F7C568',text:'#FFF2DA'},
  typography:{headline:'Poppins',offer:'Poppins',body:'Poppins',cta:'Poppins'},
  content:{eyebrow:'DIWALI MEGA SALE',headline:'Celebrate more.\nSave more.',subheadline:'Festive favourites. Extraordinary prices.',offerPrefix:'UP TO',offerValue:'50%',offerSuffix:'OFF',cta:'SHOP NOW  →',terms:'*T&C apply',date:'',location:''},
  layout:{archetype:'OFFER_LEFT_PRODUCT_RIGHT',heroPlacement:'right',textAlignment:'left'},background:'GRADIENT',decorations:['LANTERN','RANGOLI_CORNER','DIYA','SPARKLES'],slots:{logo:true,product:true,heroImage:false},
};
export const DIWALI_TEMPLATES: readonly OfferTemplateDefinition[] = [
  {id:'diwali-mega-sale',name:'Diwali Mega Sale',festival:'diwali',category:'Retail · Ecommerce',description:'A bold offer, a bright stage, a bigger celebration.',spec:base},
  {id:'diwali-luxury-gold',name:'Luxury Gold Diwali',festival:'diwali',category:'Premium · Jewellery',description:'Sculpted arches, warm gold and room to breathe.',spec:{...base,templateName:'Luxury Gold Diwali',style:'premium',palette:{background:'#171315',primary:'#392229',accent:'#DAB777',text:'#FAEBD2'},typography:{headline:'Cinzel',offer:'DM Serif Display',body:'Poppins',cta:'Poppins'},content:{...base.content,eyebrow:'THE FESTIVAL EDIT',headline:'A little light.\nA lasting impression.',subheadline:'Discover thoughtful gifts for extraordinary moments.',offerPrefix:'EXCLUSIVE FESTIVE PRIVILEGE',offerValue:'Save 25%',offerSuffix:'',cta:'EXPLORE THE EDIT  →'},layout:{archetype:'SPLIT_LAYOUT',heroPlacement:'right',textAlignment:'left'},background:'DARK_PREMIUM',decorations:['ARCH','GOLD_RING','DIYA','SPARKLES']}},
  {id:'diwali-product-spotlight',name:'Product Spotlight',festival:'diwali',category:'Beauty · Consumer products',description:'A luminous product story in warm saffron and ivory.',spec:{...base,templateName:'Product Spotlight',style:'product',palette:{background:'#FFF1DC',primary:'#EDC48F',accent:'#853C29',text:'#422B27'},typography:{headline:'DM Serif Display',offer:'Poppins',body:'Poppins',cta:'Poppins'},content:{...base.content,eyebrow:'LIGHT UP YOUR EVERYDAY',headline:'Made to glow.',subheadline:'Your festive favourite, beautifully reimagined.',offerPrefix:'',offerValue:'FLAT 30% OFF',offerSuffix:'',cta:'FIND YOUR GLOW  →'},layout:{archetype:'PRODUCT_CENTER',heroPlacement:'center',textAlignment:'center'},background:'RADIAL_GLOW',decorations:['BOKEH','FLOWER_ACCENT','DIYA']}},
  {id:'diwali-festive-greeting',name:'Festive Greeting',festival:'diwali',category:'Brand · Greeting + offer',description:'Expressive festival lettering, intricate rangoli and a gift.',spec:{...base,templateName:'Festive Greeting',style:'greeting',palette:{background:'#123E40',primary:'#205C56',accent:'#F0CD87',text:'#FFF2D6'},typography:{headline:'Yatra One',offer:'Poppins',body:'Poppins',cta:'Poppins'},content:{...base.content,eyebrow:'MAY YOUR WORLD SHINE',headline:'Happy\nDiwali',subheadline:'A season of light. A little joy for everyone.',offerPrefix:'A FESTIVE GIFT FOR YOU',offerValue:'20% OFF',offerSuffix:'',cta:'CELEBRATE WITH US  →'},layout:{archetype:'EDITORIAL_GREETING',heroPlacement:'right',textAlignment:'center'},background:'FESTIVE_PATTERN',decorations:['RANGOLI_CORNER','LANTERN','DIYA','SPARKLES']}},
  {id:'diwali-store-event',name:'Event / Store Promo',festival:'diwali',category:'Local retail · Events',description:'An invitation with a clear date, destination and offer.',spec:{...base,templateName:'Event / Store Promo',style:'event',palette:{background:'#7A2630',primary:'#4A1626',accent:'#F9D891',text:'#FFF2DB'},typography:{headline:'Baloo 2',offer:'Poppins',body:'Poppins',cta:'Poppins'},content:{...base.content,eyebrow:'YOU ARE INVITED',headline:'The Diwali\nShopping Nights',subheadline:'Gifts, festive finds & a warm welcome.',offerPrefix:'IN-STORE SPECIAL',offerValue:'Up to 40% off',offerSuffix:'',cta:'VISIT OUR STORE  →',date:'24–27 OCT  ·  11 AM–9 PM',location:'YOUR STORE · YOUR CITY'},layout:{archetype:'EVENT_PROMO',heroPlacement:'right',textAlignment:'left'},background:'GRADIENT',decorations:['LANTERN','DIYA','SPARKLES']}},
];
const b=(x:number,y:number,width:number,height:number):NormalizedLayout=>({x,y,width,height,rotation:0});
type Boxes=Record<string,NormalizedLayout>;
/** Geometry is deliberately authored by campaign archetype and canvas class; never scaled from another output. */
export function offerLayout(spec:ThemeSpec,ratio:DesignAspectRatio):Boxes {
  if(isPremiumLayout(spec.layout.archetype))return premiumLayout(spec.layout.archetype,ratio);
  const wide=ratio==='16:9', story=ratio==='9:16', portrait=ratio==='4:5'||ratio==='3:4', tall=story||portrait;
  const type=spec.layout.heroPlacement==='center' && ['OFFER_LEFT_PRODUCT_RIGHT','SPLIT_LAYOUT'].includes(spec.layout.archetype) ? 'CENTERED_SALE' : spec.layout.archetype;
  let boxes:Boxes={
    logo:b(.07,.055,.22,.05),eyebrow:b(.07,.17,.49,.035),headline:b(.07,.22,.52,.19),subheadline:b(.07,.435,.48,.075),
    'offer-prefix':b(.09,.555,.43,.035),'offer-value':b(.085,.60,.44,.12),'offer-suffix':b(.09,.733,.42,.033),
    product:b(.62,.30,.31,.43),cta:b(.07,.825,.48,.065),terms:b(.07,.92,.84,.025),date:b(.07,.465,.49,.035),location:b(.07,.515,.5,.04),
  };
  if(tall) boxes={...boxes,logo:b(.08,story?.09:.055,.28,.04),eyebrow:b(.08,story?.15:.13,.84,.027),headline:b(.08,story?.19:.18,.84,.135),subheadline:b(.08,story?.335:.33,.84,.05),
    'offer-prefix':b(.08,.44,.40,.027),'offer-value':b(.08,.48,.41,.105),'offer-suffix':b(.08,.595,.4,.028),product:b(.52,.435,.40,story?.23:.29),cta:b(.12,story?.815:.825,.76,.055),terms:b(.08,story?.9:.923,.84,.023)};
  if(wide) boxes={...boxes,logo:b(.065,.07,.18,.07),eyebrow:b(.065,.20,.48,.035),headline:b(.065,.27,.50,.19),subheadline:b(.065,.49,.47,.06),
    'offer-prefix':b(.07,.59,.42,.035),'offer-value':b(.065,.63,.46,.12),'offer-suffix':b(.07,.755,.42,.035),product:b(.64,.21,.27,.57),cta:b(.065,.81,.31,.07),terms:b(.41,.845,.18,.034)};
  if(type==='SPLIT_LAYOUT') {
    boxes.product=b(wide?.65:tall?.28:.60,tall?.405:.23,tall?.44:wide?.27:.32,tall?.26:wide?.50:.49);
    if(tall){boxes['offer-prefix']=b(.14,.705,.72,.025);boxes['offer-value']=b(.16,.737,.68,.05);boxes['offer-suffix']=b(.14,.79,.72,.018);}
    else {boxes['offer-prefix']=b(.07,.60,.48,.035);boxes['offer-value']=b(.07,.65,.46,.09);}
  }
  if(type==='PRODUCT_CENTER') {
    boxes={...boxes,eyebrow:b(.12,tall?.15:.16,.76,.03),headline:b(.10,tall?.20:.215,.80,.10),subheadline:b(.14,tall?.31:.33,.72,.045),product:b(.27,tall?.39:.40,.46,tall?.32:.31),
      'offer-prefix':b(.14,.72,.72,.025),'offer-value':b(.14,.755,.72,.05),'offer-suffix':b(.14,.81,.72,.023),cta:b(.16,.855,.68,.05)};
    if(wide)boxes={...boxes,eyebrow:b(.08,.23,.40,.04),headline:b(.07,.30,.42,.14),subheadline:b(.08,.48,.4,.07),product:b(.60,.15,.30,.62),'offer-value':b(.08,.66,.40,.085),'offer-prefix':b(.08,.60,.40,.03),'offer-suffix':b(.08,.75,.4,.025),cta:b(.09,.81,.38,.07)};
  }
  if(type==='EDITORIAL_GREETING'||type==='CENTERED_SALE') {
    boxes={...boxes,eyebrow:b(.15,tall?.155:.17,.70,.03),headline:b(.14,tall?.21:.235,.72,tall?.17:.23),subheadline:b(.16,tall?.40:.48,.68,.055),
      product:b(.64,tall?.53:.56,.22,tall?.19:.20),'offer-prefix':b(.15,tall?.52:.57,.43,.03),'offer-value':b(.12,tall?.565:.625,.47,.085),'offer-suffix':b(.15,tall?.66:.72,.43,.03),cta:b(.18,.825,.64,.06)};
    if(wide) boxes={...boxes,eyebrow:b(.08,.19,.49,.04),headline:b(.08,.26,.49,.27),subheadline:b(.08,.55,.49,.065),product:b(.71,.24,.20,.34),'offer-prefix':b(.67,.62,.27,.03),'offer-value':b(.64,.66,.30,.09),'offer-suffix':b(.67,.77,.27,.025),cta:b(.12,.79,.40,.075)};
  }
  if(type==='CENTERED_SALE') {
    boxes={...boxes,eyebrow:b(.12,tall?.155:.16,.76,.03),headline:b(.10,tall?.205:.22,.80,.12),subheadline:b(.14,.35,.72,.05),product:b(.34,.425,.32,.25),
      'offer-prefix':b(.14,.69,.72,.025),'offer-value':b(.14,.725,.72,.065),'offer-suffix':b(.14,.795,.72,.022),cta:b(.18,.845,.64,.05)};
  }
  if(type==='EVENT_PROMO') {
    boxes={...boxes,headline:b(.07,tall?.20:wide?.265:.22,tall?.84:.53,tall?.15:.19),subheadline:b(.07,tall?.365:.44,tall?.84:.50,.055),date:b(.09,tall?.455:.55,tall?.43:.46,tall?.047:.04),location:b(.09,tall?.515:.60,tall?.43:.46,tall?.05:.04),
      'offer-prefix':b(.09,tall?.60:.68,tall?.44:.46,.026),'offer-value':b(.09,tall?.638:.72,tall?.44:.46,.067),'offer-suffix':b(.09,.79,.45,.02),product:b(tall?.58:wide?.65:.65,tall?.46:.30,tall?.34:wide?.27:.27,tall?.26:.43)};
  }
  if(ratio==='3:4'){boxes.product={...boxes.product,y:boxes.product.y+.012,height:boxes.product.height-.012};boxes.cta={...boxes.cta,y:boxes.cta.y+.007};}
  // Mirroring changes geometry only; content, reading direction and ornament proportions stay intact.
  if(spec.layout.heroPlacement==='left') for(const key of Object.keys(boxes))if(!['logo','terms'].includes(key))boxes[key]={...boxes[key],x:1-boxes[key].x-boxes[key].width};
  return boxes;
}
export const offerFonts = {offers:['Poppins','Baloo 2','Fredoka'],headings:['Yatra One','Tiro Devanagari Hindi','DM Serif Display','Cinzel','Poppins','Baloo 2','Fredoka'],body:['Poppins','Hind','Mukta','Noto Sans Devanagari']};
/** Inspector palette/font adapter; old starter theme shape remains compatible. */
export function offerTemplateTheme(template:DesignTemplate):OfferTheme|undefined {
  const spec=template.offerTemplate?.spec;if(!spec)return;
  return {id:template.themeId!,name:spec.templateName,description:'Editable Diwali campaign',motif:'lights',palette:{background:spec.palette.background,surface:spec.palette.primary,gold:spec.palette.accent,accent:spec.palette.accent,ink:spec.palette.text,muted:spec.palette.text},typography:{heading:spec.typography.headline,offer:spec.typography.offer,body:spec.typography.body},recommendations:isPremiumLayout(spec.layout.archetype)?{headings:[spec.typography.headline,'Cormorant Garamond','DM Serif Display','Cinzel','Montserrat','Noto Sans Devanagari'],offers:['Montserrat','Poppins','Hind'],body:['Poppins','DM Sans','Hind','Noto Sans Devanagari']}:offerFonts,content:{eyebrow:spec.content.eyebrow,headline:spec.content.headline,subheading:spec.content.subheadline,'offer-value':spec.content.offerValue,cta:spec.content.cta,terms:spec.content.terms},ratioLayouts:Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,offerLayout(spec,r)])) as OfferTheme['ratioLayouts']};
}
const readable=(color:string)=>{const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.4?'#21151C':'#FFF8E9';};
export function compileOfferTemplate(template:DesignTemplate,input:ThemeSpec,source:OfferTemplateMetadata['source'],definitionId:string):DesignTemplate {
  const spec=parseThemeSpec(input);
  if(isPremiumLayout(spec.layout.archetype))return compilePremiumTemplate(template,spec,source,definitionId);
  const p=spec.palette,elements:TemplateElement[]=[];
  const layouts=Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,offerLayout(spec,r)])) as Record<DesignAspectRatio,Boxes>;
  const add=(element:TemplateElement,role:string,name:string,positions:Record<DesignAspectRatio,NormalizedLayout>)=>elements.push({...element,id:`offer-${role}`,name,themeRole:role,zIndex:elements.length,layout:positions['1:1'],ratioLayouts:positions});
  const same=(box:NormalizedLayout)=>Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,box])) as Record<DesignAspectRatio,NormalizedLayout>;
  const byRole=(role:string)=>Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,layouts[r][role]])) as Record<DesignAspectRatio,NormalizedLayout>;
  const shape=(role:string,name:string,fill:string,positions:Record<DesignAspectRatio,NormalizedLayout>,radius=0,opacity=1,stroke:string|null=null,gradient?:{from:string;to:string;angle:number})=>{
    const e=createTemplateElement('rounded-rectangle',role,0);if(e.type==='shape')add({...e,style:{...e.style,fill,cornerRadius:radius,opacity,stroke,strokeWidth:stroke ? .001 : 0,...(gradient?{gradient}:{})}},role,name,positions);
  };
  const bg=createTemplateElement('background','background',0);if(bg.type==='background')add({...bg,defaultContent:{color:p.background,assetId:null}},'background','Campaign background',same(b(0,0,1,1)));
  if(spec.background!=='SOLID')shape('background-decoration','Festive gradient',p.primary,same(b(0,0,1,1)),0,1,null,{from:p.background,to:p.primary,angle:spec.style==='product'?90:28});
  shape('frame-top','Gold top rule',p.accent,same(b(.035,.025,.93,.005)));
  shape('frame-bottom','Gold footer rule',p.accent,same(b(.035,.975,.93,.005)));
  if(spec.style==='premium'){
    shape('premium-frame','Inset gilded frame',p.background,same(b(.025,.025,.95,.95)),.01,.35,p.accent);
    for(const pad of [.018,.033])shape(`arch-${pad}`,'Architectural gold arch',p.primary,Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{const q=layouts[r].product;return[r,b(q.x-pad,q.y-pad,q.width+pad*2,q.height+pad*2)];})) as Record<DesignAspectRatio,NormalizedLayout>,1,.6,p.accent);
  } else if(spec.style==='sale'||spec.style==='product') shape('product-stage','Product pedestal',p.accent,Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{const q=layouts[r].product;return[r,b(q.x-.02,q.y+q.height-.015,q.width+.04,.025)];})) as Record<DesignAspectRatio,NormalizedLayout>,.6,spec.style==='product'?.25:.85);
  if(spec.style==='event')shape('event-ticket','Event information panel',p.primary,Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{const q=layouts[r].date;return[r,b(q.x-.025,q.y-.02,q.width+.05,r==='9:16'||r==='4:5'||r==='3:4'?.13:.125)];})) as Record<DesignAspectRatio,NormalizedLayout>,.08,.65,p.accent);
  const art:Record<string,string>={DIYA:'diya',LANTERN:'lantern',RANGOLI_CORNER:'rangoli',SPARKLES:'sparkles',BOKEH:'bokeh',FLOWER_ACCENT:'flower'};
  for(const token of [...new Set([...spec.decorations, ...(spec.background==='RADIAL_GLOW'?['BOKEH']:spec.background==='FESTIVE_PATTERN'?['RANGOLI_CORNER']:[])])]) {
    if(token==='ARCH'||token==='GOLD_RING'){if(spec.style==='premium')continue;shape(`ornament-${token}`,'Gold display arch',p.primary,byRole('product'),1,.3,p.accent);continue;}
    const e=createTemplateElement('generic-image',token,0);if(e.type!=='image')continue;
    const positions=Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{
      const [w,h]=r.split(':').map(Number),sx=Math.min(w,h)/w,sy=Math.min(w,h)/h;
      const size=token==='LANTERN'?.24:token==='DIYA'?.17:token==='RANGOLI_CORNER'?.43:token==='FLOWER_ACCENT'?.24:1;
      const x=token==='LANTERN'?.76:token==='DIYA'?.83:token==='FLOWER_ACCENT'?.03:.005;
      const y=token==='LANTERN'?0:token==='DIYA'?.97-size*sy:token==='FLOWER_ACCENT'?.70:0;
      return[r,b(Math.min(x,1-size*sx),y,size*sx,size*sy)];
    })) as Record<DesignAspectRatio,NormalizedLayout>;
    add({...e,defaultContent:{assetId:`diwali-art-${art[token]}`},behavior:{...e.behavior,fit:'contain'},style:{...e.style,opacity:token==='RANGOLI_CORNER'?.16:token==='BOKEH'?.7:1}},`decoration-${token}`,`${token.toLowerCase().replaceAll('_',' ')} ornament`,positions);
  }
  for(const [role,kind,enabled] of [['product','product',spec.slots.product],['logo','logo',spec.slots.logo],['hero-image','hero',spec.slots.heroImage]] as const){
    if(!enabled)continue;const e=createTemplateElement(kind,role,0);if(e.type!=='image')continue;
    // A secondary hero gets a separate local slot, never overlaps the primary product slot.
    add({...e,behavior:{...e.behavior,fit:'contain'}},role,role==='logo'?'YOUR LOGO':role==='product'?'YOUR PRODUCT':'CAMPAIGN IMAGE',role==='hero-image'?same(b(.78,.11,.14,.11)):byRole(role));
  }
  const content:Record<string,string>={eyebrow:spec.content.eyebrow,headline:spec.content.headline,subheadline:spec.content.subheadline,'offer-prefix':spec.content.offerPrefix,'offer-value':spec.content.offerValue,'offer-suffix':spec.content.offerSuffix,cta:spec.content.cta,terms:spec.content.terms,...(spec.style==='event'||spec.content.date||spec.content.location?{date:spec.content.date,location:spec.content.location}:{})};
  for(const [role,text] of Object.entries(content)){
    const e=createTemplateElement(role==='headline'?'heading':role==='offer-value'?'offer':role==='cta'?'cta':'generic-text',role,0) as TemplateTextElement;
    const main=role==='headline',offer=role==='offer-value',cta=role==='cta',size=main?(spec.style==='greeting'?.14:.07):offer?(spec.style==='sale'?.12:.06):cta?.022:role==='terms'?.013:role==='eyebrow'||role==='offer-prefix'||role==='offer-suffix'?.018:.022;
    add({...e,defaultContent:{text},editableProperties:{...e.editableProperties,fontFamily:true},style:{...e.style,fontFamily:main?spec.typography.headline:offer?spec.typography.offer:cta?spec.typography.cta:spec.typography.body,fontSize:size,fontWeight:main?(spec.style==='sale'?700:spec.style==='event'?600:400):offer||cta?700:400,color:cta?readable(p.accent):offer||role==='eyebrow'?p.accent:p.text,backgroundColor:cta?p.accent:null,align:cta?'center':spec.layout.textAlignment,verticalAlign:'middle',lineHeight:1.15,letterSpacing:role==='eyebrow'?.12:0,cornerRadius:cta?.12:0},behavior:{maxLines:main?3:offer?4:3,overflow:'shrink',minFontSize:role==='terms'?.01:role==='eyebrow'||role==='offer-prefix'||role==='offer-suffix'?.012:.017}},role,({headline:'Headline','offer-value':'Offer',cta:'CTA',subheadline:'Supporting copy','offer-prefix':'Offer prefix','offer-suffix':'Offer suffix',eyebrow:'Eyebrow',terms:'Terms',date:'Date / time',location:'Location'})[role]??role,byRole(role));
  }
  return assertDesignTemplate({...template,name:spec.templateName,themeId:definitionId,supportedAspectRatios:[...DESIGN_ASPECT_RATIOS],offerTemplate:{version:1,source,definitionId,festival:'diwali',spec},elements:orderElements(elements)});
}
export function applyCuratedOffer(template:DesignTemplate,id:string):DesignTemplate {
  const definition=[...DIWALI_TEMPLATES,...PREMIUM_DIWALI_TEMPLATES].find(d=>d.id===id);if(!definition)throw new Error('Unknown Diwali template.');
  return compileOfferTemplate(template,definition.spec,'curated',definition.id);
}
