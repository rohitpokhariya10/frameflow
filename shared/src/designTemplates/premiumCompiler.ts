/** Hybrid compiler: bounded scene choices + native business layers, shared by curated and planned themes. */
import { createTemplateElement, orderElements } from './editing.js';
import { assertDesignTemplate, DESIGN_ASPECT_RATIOS, type DesignTemplate, type DesignAspectRatio, type NormalizedLayout, type TemplateElement, type TemplateTextElement } from './schema.js';
import { premiumBox as b, premiumLayout } from './premiumLayouts.js';
import { isPremiumLayout, type ThemeSpec, type OfferTemplateMetadata } from './themeSpec.js';
type Positions=Record<DesignAspectRatio,NormalizedLayout>;
export function compilePremiumTemplate(template:DesignTemplate,spec:ThemeSpec,source:OfferTemplateMetadata['source'],definitionId:string):DesignTemplate {
  const family=spec.layout.archetype;if(!isPremiumLayout(family))throw new Error('Unknown premium family.');
  const p=spec.palette, c=spec.content,elements:TemplateElement[]=[];
  const layouts=Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,premiumLayout(family,r)]));
  const same=(box:NormalizedLayout)=>Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,box])) as Positions;
  const at=(role:string)=>Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,layouts[r][role]])) as Positions;
  const adapted=(portrait:NormalizedLayout,wide:NormalizedLayout)=>Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,r==='16:9'?wide:portrait])) as Positions;
  const add=(e:TemplateElement,role:string,name:string,positions:Positions)=>elements.push({...e,id:`offer-${role}`,themeRole:role,name,zIndex:elements.length,layout:positions['1:1'],ratioLayouts:positions});
  const shape=(role:string,name:string,fill:string,positions:Positions,opacity=1,gradient?:{from:string;to:string;angle:number})=>{
    const e=createTemplateElement('rectangle',role,0);if(e.type==='shape')add({...e,style:{...e.style,fill,opacity,...(gradient?{gradient}:{})}},role,name,positions);
  };
  const picture=(role:string,name:string,assetId:string|null,positions:Positions,options:{fit?:'contain'|'cover';opacity?:number;kind?:'generic-image'|'product'|'hero'|'logo';visible?:boolean}={})=>{
    const e=createTemplateElement(options.kind??'generic-image',role,0);if(e.type==='image')add({...e,visible:options.visible??true,defaultContent:{assetId},style:{...e.style,opacity:options.opacity??1},behavior:{...e.behavior,fit:options.fit??'cover'}},role,name,positions);
  };
  const bg=createTemplateElement('background','background',0);if(bg.type==='background')add({...bg,defaultContent:{color:p.background,assetId:null}},'background','Campaign background',same(b(0,0,1,1)));
  shape('background-decoration','Atmospheric colour',p.background,same(b(0,0,1,1)),1,{from:p.background,to:p.primary,angle:90});
  // Low-contrast photographic decor stays independent of the replaceable business image.
  const scene=family==='PREMIUM_EVENT'?'city':family==='PREMIUM_PRODUCT_GIFT'?'lamps':family==='LANTERN_NIGHT'?'night':family==='ELEGANT_GREETING'?'lamps':'lanterns';
  picture('decoration-scene','Festive environment',`premium-photo-${scene}`,at('scene'),{fit:'contain',opacity:family==='PREMIUM_EVENT'?.14:family==='LANTERN_NIGHT'?.18:family==='PREMIUM_PRODUCT_GIFT'?.35:.09});
  picture('decoration-light','Atmosphere · light & grain','premium-atmosphere',same(b(0,0,1,1)),{opacity:.75});
  if(['ELEGANT_GREETING','PREMIUM_EVENT'].includes(family))picture('decoration-sparks','Distant fireworks','premium-sparks',same(b(0,0,1,1)),{fit:'contain',opacity:.32});
  if(spec.decorations.includes('LANTERN')&&!['ELEGANT_GREETING','PREMIUM_PRODUCT_GIFT','LANTERN_NIGHT'].includes(family)) {
    const centered=family==='PREMIUM_JEWELLERY_OFFER';
    for(const [i,x] of (centered?[.34,.57]:[.015,.915]).entries()) {
      const y=i%2?.018:0;
      picture(`decoration-lantern-${i}`,`Hanging lantern ${i+1}`,'premium-photo-hanging-lantern',adapted(b(x,y,centered?.085:.065,centered?.13:.22),b(i?.91:.80,y,.045,.22)),{fit:'contain'});
      shape(`decoration-thread-${i}`,`Lantern cord ${i+1}`,p.accent,adapted(b(x+.04,0,.005,.035),b((i?.91:.80)+.022,0,.005,.035)),.4);
    }
  }
  if(family==='PREMIUM_JEWELLERY_OFFER') {
    // An inset border consists of four native rules so the centre remains genuinely transparent.
    shape('frame-left','Fine gold border · left',p.accent,same(b(.035,.035,.005,.93)),.6);
    shape('frame-right','Fine gold border · right',p.accent,same(b(.96,.035,.005,.93)),.6);
    shape('decoration-offer-divider','Offer divider',p.accent,Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>[r,r==='16:9'?b(.31,.41,.005,.29):b(.495,.34,.005,.19)])) as Positions,.55);
  }
  if(family==='PREMIUM_EVENT') {
    picture('decoration-architecture-left','Illuminated architecture · left','premium-photo-city-left',adapted(b(0,.45,.23,.53),b(0,.13,.22,.87)),{fit:'cover',opacity:.8});
    picture('decoration-architecture-right','Illuminated architecture · right','premium-photo-city-right',adapted(b(.77,.45,.23,.53),b(.78,.13,.22,.87)),{fit:'cover',opacity:.8});
  }
  if(family==='PREMIUM_JEWELLERY_OFFER')shape('frame-top','Fine gold border · top',p.accent,same(b(.035,.032,.93,.005)),.6);
  if(family==='PREMIUM_JEWELLERY_OFFER')shape('frame-bottom','Fine gold border · bottom',p.accent,same(b(.035,.973,.93,.005)),.6);
  if(family==='PREMIUM_PRODUCT_GIFT')picture('decoration-gifting','Gift presentation','premium-photo-gift-stage',adapted(b(.18,.265,.58,.43),b(.065,.28,.30,.57)),{opacity:.85,fit:'contain'});
  if(spec.slots.heroImage){
    const asset=family==='ELEGANT_GREETING'?'greeting':family==='LANTERN_NIGHT'?'lantern-people':'celebration';
    picture('hero-image','YOUR HERO',`premium-photo-${asset}`,at('hero-image'),{kind:'hero',fit:family==='LANTERN_NIGHT'?'cover':'contain'});
    if(family==='LANTERN_NIGHT'){
      picture('decoration-night-veil','Night scene lighting','premium-night-veil',same(b(0,0,1,1)));
      picture('decoration-sparks','Distant fireworks','premium-sparks',same(b(0,0,1,1)),{fit:'contain',opacity:.22});
    }
  }
  if(spec.slots.product){
    const sample=family==='PREMIUM_ECOMMERCE_SALE'?'products':family==='PREMIUM_PRODUCT_GIFT'?'product':null;
    picture('product','YOUR PRODUCT',sample?`premium-photo-${sample}`:null,at('product'),{kind:'product',fit:'contain'});
  }
  if(['PREMIUM_JEWELLERY_OFFER','PREMIUM_PRODUCT_GIFT','PREMIUM_ECOMMERCE_SALE'].includes(family))picture('decoration-floral','Marigold & clay diya','premium-photo-floral',adapted(family==='PREMIUM_ECOMMERCE_SALE'?b(.85,.70,.10,.095):family==='PREMIUM_PRODUCT_GIFT'?b(.81,.60,.15,.09):b(.85,.59,.105,.105),family==='PREMIUM_ECOMMERCE_SALE'?b(.90,.635,.085,.10):family==='PREMIUM_PRODUCT_GIFT'?b(.48,.87,.09,.08):b(.895,.85,.085,.07)),{fit:'contain',opacity:.9});
  if(spec.slots.logo)picture('logo','YOUR LOGO',null,at('logo'),{kind:'logo',fit:'contain'});
  // Native rules reinforce the campaign/date hierarchy without baking any copy into a photo.
  if(family==='PREMIUM_ECOMMERCE_SALE'||family==='PREMIUM_EVENT') {
    const dateRule=Object.fromEntries(DESIGN_ASPECT_RATIOS.map(r=>{const box=layouts[r].date;return [r,b(box.x,box.y-.009,box.width,.005)];})) as Positions;
    shape('decoration-date-rule','Date divider',p.accent,dateRule,.5);
  }
  const copy:Record<string,string>={eyebrow:c.eyebrow,headline:c.headline,subheadline:c.subheadline,'offer-prefix':c.offerPrefix,'offer-value':c.offerValue,'offer-suffix':c.offerSuffix,cta:c.cta,terms:c.terms};
  if(family==='PREMIUM_JEWELLERY_OFFER'){copy['second-offer-value']=c.secondOfferValue??'';copy['second-offer-label']=c.secondOfferLabel??'';}
  if(family==='PREMIUM_EVENT'||c.date||c.location){copy.date=c.date;copy.location=c.location;}
  if(family==='PREMIUM_EVENT'){copy.time=c.time??'';copy['dress-code']=c.dressCode??'';}
  const labels:Record<string,string>={headline:'Headline',subheadline:'Supporting copy',eyebrow:'Eyebrow','offer-prefix':'Offer prefix','offer-value':'Offer','offer-suffix':'Offer wording','second-offer-value':'Second offer','second-offer-label':'Second offer wording',date:'Date',time:'Time','dress-code':'Dress code',location:'Location',cta:'CTA',terms:'Terms'};
  for(const [role,text] of Object.entries(copy)){
    const headline=role==='headline',offer=role==='offer-value'||role==='second-offer-value',cta=role==='cta';
    const e=createTemplateElement(headline?'heading':offer?'offer':cta?'cta':'generic-text',role,0) as TemplateTextElement;
    const size=headline?(family==='PREMIUM_JEWELLERY_OFFER'?.066:family==='PREMIUM_PRODUCT_GIFT'?.078:family==='PREMIUM_ECOMMERCE_SALE'?.105:.125):offer?(family==='PREMIUM_JEWELLERY_OFFER'?.235:.038):role==='terms'?.013:role==='eyebrow'?.017:role==='subheadline'?.025:cta?.02:.025;
    const major=offer||['eyebrow','date','time'].includes(role);
    add({...e,visible:true,defaultContent:{text},editableProperties:{...e.editableProperties,fontFamily:true},style:{...e.style,fontFamily:headline?spec.typography.headline:offer?spec.typography.offer:cta?spec.typography.cta:spec.typography.body,fontSize:size,fontWeight:headline?(family==='PREMIUM_ECOMMERCE_SALE'||family==='PREMIUM_JEWELLERY_OFFER'?700:400):offer||cta?700:400,color:major||headline&&family==='PREMIUM_ECOMMERCE_SALE'?p.accent:p.text,align:'center',verticalAlign:'middle',lineHeight:headline?1.02:1.18,letterSpacing:role==='eyebrow'?.14:0,backgroundColor:null},behavior:{maxLines:headline?3:offer?3:4,overflow:'shrink',minFontSize:Math.min(size,role==='terms'?.009:role==='eyebrow'?.010:.014)}},role,labels[role],at(role));
  }
  return assertDesignTemplate({...template,name:spec.templateName,themeId:definitionId,supportedAspectRatios:[...DESIGN_ASPECT_RATIOS],offerTemplate:{version:1,source,definitionId,festival:'diwali',spec},elements:orderElements(elements)});
}
