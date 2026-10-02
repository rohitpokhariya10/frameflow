import { describe, expect, it } from 'vitest';
import { PREMIUM_DIWALI_TEMPLATES } from './premiumDefinitions.js';
import { DIWALI_TEMPLATES, applyCuratedOffer, compileOfferTemplate } from './offerTemplates.js';
import { createTemplateDraft, updateElement } from './editing.js';
import { DESIGN_ASPECT_RATIOS, templateErrors } from './schema.js';
import { parseThemeSpec, PREMIUM_LAYOUTS, THEME_SPEC_SCHEMA } from './themeSpec.js';
import { premiumAssetPath } from './premiumAssets.js';
import { templateAtRatio, setRatioLayout } from './responsive.js';
import { emptyLibrary, saveDesignTemplate, serializeLibrary, parseLibrary } from './library.js';
import { createCreative, setCreativeOverride, applyCreative } from './creative.js';
import { canvasElementsToVariant } from '../canvasEditorAdapter.js';
const now='2026-10-02T00:00:00Z',draft=()=>createTemplateDraft('premium-test',now);
it('keeps five current templates and adds exactly six distinct premium families',()=>{
  expect(DIWALI_TEMPLATES.map(d=>d.id)).toEqual(['diwali-mega-sale','diwali-luxury-gold','diwali-product-spotlight','diwali-festive-greeting','diwali-store-event']);
  expect(PREMIUM_DIWALI_TEMPLATES).toHaveLength(6);
  expect(new Set(PREMIUM_DIWALI_TEMPLATES.map(d=>d.spec.layout.archetype)).size).toBe(6);
});
for(const def of PREMIUM_DIWALI_TEMPLATES)describe(def.id,()=>{
  it('compiles bounded native text and replaceable business images, locally in all ratios',()=>{
    const template=applyCuratedOffer(draft(),def.id);expect(templateErrors(template)).toEqual([]);
    expect(template.elements.length).toBeLessThan(50);
    for(const role of ['headline','subheadline','offer-value','cta','terms']){
      const e=template.elements.find(e=>e.themeRole===role)!;expect(e.type).toBe('text');expect(e.editableProperties.content).toBe(true);expect(e.editableProperties.fontFamily).toBe(true);expect(e.editableProperties.color).toBe(true);
    }
    for(const role of ['logo',...(def.spec.slots.product?['product']:[]),...(def.spec.slots.heroImage?['hero-image']:[])]){
      const e=template.elements.find(e=>e.themeRole===role)!;expect(e.type).toBe('image');expect(e.editableProperties.image).toBe(true);if(e.type==='image'&&role!=='hero-image')expect(e.behavior.fit).toBe('contain');
    }
    for(const e of template.elements)if(e.type==='image'&&e.defaultContent.assetId)expect(premiumAssetPath(e.defaultContent.assetId)).toMatch(/^\/assets\/diwali-premium\//);
    for(const ratio of DESIGN_ASPECT_RATIOS){
      const result=templateAtRatio(template,ratio);expect(templateErrors(result)).toEqual([]);
      // Business text boxes must not collide with each other in authored layouts.
      const texts=result.elements.filter(e=>e.type==='text'&&e.visible!==false&&e.defaultContent.text.trim());
      for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
        const a=texts[i].layout,b=texts[j].layout;const overlap=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1e-6&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1e-6;
        expect(overlap,`${ratio}: ${texts[i].name} / ${texts[j].name}`).toBe(false);
      }
      const variant=canvasElementsToVariant(result.elements,{width:1080,height:1080},{id:'v',name:'preview'});expect(variant.elements).toHaveLength(result.elements.filter(e=>e.type==='text').length);expect(variant.layers).toHaveLength(result.elements.filter(e=>e.type==='image'||e.type==='shape').length);
    }
    const original=JSON.stringify(template);
    for(let n=0;n<8;n++)for(const ratio of DESIGN_ASPECT_RATIOS)templateAtRatio(template,ratio);
    expect(JSON.stringify(template)).toBe(original);
    expect(templateAtRatio(template,'9:16').elements).not.toEqual(templateAtRatio(template,'16:9').elements);
  });
  it('preserves assets, fonts, colors, geometry, family and ratio on save/reload and isolates SPOC edits',()=>{
    let t=applyCuratedOffer(draft(),def.id);
    t=updateElement(t,'offer-headline',e=>e.type==='text'?{...e,defaultContent:{text:'दीवाली की खुशियाँ'},style:{...e.style,fontFamily:'Hind',color:'#FFFFFF'}}:e);
    const imageId=def.spec.slots.heroImage?'offer-hero-image':def.spec.slots.product?'offer-product':'offer-decoration-scene';
    t=updateElement(t,imageId,e=>e.type==='image'?{...e,defaultContent:{assetId:'user-transparent-image'}}:e);
    t=setRatioLayout(t,'offer-headline','16:9',{x:.12});t.canvas.masterAspectRatio='16:9';
    const saved=saveDesignTemplate(emptyLibrary(),t,now);const loaded=parseLibrary(serializeLibrary(saved.library)).templates[0];expect(loaded).toEqual(t);
    const before=JSON.stringify(loaded);let creative=createCreative(loaded,{id:'creative',name:'Campaign',now});
    creative=setCreativeOverride(creative,loaded,'offer-headline',{text:'Our Diwali',fontFamily:'Poppins'},now);
    creative=setCreativeOverride(creative,loaded,imageId,{assetId:'new-product'},now);
    for(const ratio of DESIGN_ASPECT_RATIOS){const output=applyCreative(loaded,{...creative,aspectRatio:ratio});expect(output.elements.find(e=>e.id===imageId)?.defaultContent).toEqual({assetId:'new-product'});expect(output.elements.find(e=>e.id==='offer-headline')?.defaultContent).toEqual({text:'Our Diwali'});}
    expect(JSON.stringify(loaded)).toBe(before);
  });
  it('accepts the same premium family through the bounded planner and remains idempotent',()=>{
    const planned=parseThemeSpec(def.spec),t=compileOfferTemplate(draft(),planned,'ai','diwali-ai');
    expect(t.offerTemplate?.source).toBe('ai');expect(compileOfferTemplate(t,planned,'ai','diwali-ai')).toEqual(t);expect(templateErrors(t)).toEqual([]);
  });
});
it('keeps independent dual offers and native event metadata, validates optional premium copy',()=>{
  const jewellery=applyCuratedOffer(draft(),'premium-jewellery'),event=applyCuratedOffer(draft(),'premium-event');
  for(const role of ['offer-value','second-offer-value','second-offer-label'])expect(jewellery.elements.some(e=>e.themeRole===role&&e.type==='text')).toBe(true);
  for(const role of ['date','time','dress-code','location'])expect(event.elements.some(e=>e.themeRole===role&&e.type==='text')).toBe(true);
  expect(JSON.stringify(THEME_SPEC_SCHEMA)).toContain('secondOfferValue');
  for(const field of ['secondOfferValue','secondOfferLabel','time','dressCode'])expect(()=>parseThemeSpec({...PREMIUM_DIWALI_TEMPLATES[0].spec,content:{...PREMIUM_DIWALI_TEMPLATES[0].spec.content,[field]:'x'.repeat(121)}})).toThrow();
  for(const layout of PREMIUM_LAYOUTS)expect(JSON.stringify(THEME_SPEC_SCHEMA)).toContain(layout);
  for(const id of ['../../secret','https://invalid.test/file','premium-photo-missing','toString'])expect(premiumAssetPath(id)).toBeUndefined();
});

it('keeps solid decorations outside business safe zones in all premium ratios',()=>{
  for(const def of PREMIUM_DIWALI_TEMPLATES)for(const ratio of DESIGN_ASPECT_RATIOS){
    const t=templateAtRatio(applyCuratedOffer(draft(),def.id),ratio);
    const business=t.elements.filter(e=>e.themeRole==='logo'||e.type==='text'&&e.defaultContent.text.trim());
    const decor=t.elements.filter(e=>/^decoration-(lantern-|thread-|floral|architecture-)/.test(e.themeRole??''));
    for(const a of decor)for(const c of business){const x=a.layout,y=c.layout;
      const overlap=Math.min(x.x+x.width,y.x+y.width)-Math.max(x.x,y.x)>1e-6&&Math.min(x.y+x.height,y.y+y.height)-Math.max(x.y,y.y)>1e-6;
      expect(overlap,`${def.id} ${ratio}: ${a.name} / ${c.name}`).toBe(false);
    }
  }
});
it('keeps blank optional offers and explicitly requested empty product slots editable',()=>{
  for(const def of PREMIUM_DIWALI_TEMPLATES){
    const t=compileOfferTemplate(draft(),{...def.spec,slots:{...def.spec.slots,product:true}},'ai','ai-test');
    expect(t.elements.find(e=>e.themeRole==='product')?.visible).toBe(true);
    for(const e of t.elements.filter(e=>e.type==='text'&&e.defaultContent.text===''))expect(e.visible).toBe(true);
  }
});
