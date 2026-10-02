import { describe, expect, it } from 'vitest';
import { DIWALI_TEMPLATES, applyCuratedOffer, compileOfferTemplate, offerLayout } from './offerTemplates.js';
import { applyOfferTheme, clearOfferTheme } from './themes.js';
import { parseThemeSpec, parseThemePrompt } from './themeSpec.js';
import { createTemplateDraft } from './editing.js';
import { DESIGN_ASPECT_RATIOS, templateErrors } from './schema.js';
import { createCreative, applyCreative } from './creative.js';
import { emptyLibrary, saveDesignTemplate, serializeLibrary, parseLibrary, duplicateDesignTemplate } from './library.js';
import { templateAtRatio } from './responsive.js';
import { canvasElementsToVariant } from '../canvasEditorAdapter.js';
import { builtinDiwaliAsset } from './diwaliAssets.js';
const now='2026-10-01T00:00:00Z';
const draft=()=>createTemplateDraft('test',now);
for(const definition of DIWALI_TEMPLATES)describe(definition.name,()=>{
  it('compiles locally with native business layers, real ornament assets and five safe distinct layouts',()=>{
    const template=applyCuratedOffer(draft(),definition.id);
    expect(templateErrors(template)).toEqual([]);expect(template.elements.length).toBeLessThan(50);
    for(const role of ['logo','product','eyebrow','headline','offer-prefix','offer-value','offer-suffix','subheadline','cta','terms'])expect(template.elements.some(e=>e.themeRole===role)).toBe(true);
    if(definition.spec.style==='event')for(const role of ['date','location'])expect(template.elements.some(e=>e.themeRole===role&&e.type==='text')).toBe(true);
    for(const ratio of DESIGN_ASPECT_RATIOS){
      const resolved=templateAtRatio(template,ratio);expect(templateErrors(resolved)).toEqual([]);
      const v=canvasElementsToVariant(resolved.elements,{width:1080,height:1080},{id:'v',name:'test'});
      expect(v.elements.length).toBeGreaterThanOrEqual(8);
      for(const e of resolved.elements)if(e.type==='image'&&e.defaultContent.assetId)expect(builtinDiwaliAsset(e.defaultContent.assetId)).toContain('<svg');
    }
    expect(offerLayout(definition.spec,'1:1')).not.toEqual(offerLayout(definition.spec,'16:9'));
    expect(offerLayout(definition.spec,'4:5')).not.toEqual(offerLayout(definition.spec,'9:16'));
  });
  it('persists metadata, font choices, independent duplicates and SPOC content without mutating the base',()=>{
    const template=applyCuratedOffer(draft(),definition.id);
    const saved=saveDesignTemplate(emptyLibrary(),template,now);
    const reopened=parseLibrary(serializeLibrary(saved.library));expect(reopened.templates[0]).toEqual(template);
    const duplicate=duplicateDesignTemplate(reopened,template.id,'another',now).template;duplicate.elements[0].name='changed';expect(template.elements[0].name).not.toBe('changed');
    const creative=createCreative(template,{id:'c',name:'campaign',now});
    const original=JSON.stringify(template);
    creative.contentOverrides['offer-headline']={text:'नया ऑफर'};
    for(const ratio of DESIGN_ASPECT_RATIOS){creative.aspectRatio=ratio;const result=applyCreative(template,creative);expect(JSON.stringify(result)).toContain('नया ऑफर');}
    expect(JSON.stringify(template)).toBe(original);
  });
});
const spec=DIWALI_TEMPLATES[0].spec;
it('AI specifications compile to the same native canvas and survive reload without a planner',()=>{
  for(const def of DIWALI_TEMPLATES){const template=compileOfferTemplate(draft(),def.spec,'ai','diwali-ai');expect(templateErrors(template)).toEqual([]);expect(parseLibrary(serializeLibrary(saveDesignTemplate(emptyLibrary(),template,now).library)).templates[0].offerTemplate?.source).toBe('ai');}
});
it('normalizes omitted optional fields and accepts Hindi copy',()=>{
  const parsed=parseThemeSpec({...spec,content:{headline:'दीवाली स्पेशल ऑफर',cta:'अभी खरीदें'},slots:undefined,decorations:undefined});
  expect(parsed.content.offerPrefix).toBe('');expect(parsed.slots.product).toBe(true);expect(parsed.decorations).toEqual([]);
  expect(templateErrors(compileOfferTemplate(draft(),parsed,'ai','diwali-ai'))).toEqual([]);
});
it.each([
  null,{}, {...spec,layout:{...spec.layout,archetype:'JS'}}, {...spec,palette:{...spec.palette,background:'red'}},
  {...spec,typography:{...spec.typography,body:'Imaginary Font'}}, {...spec,decorations:Array(7).fill('DIYA')},
  {...spec,content:{...spec.content,headline:''}}, {...spec,content:{...spec.content,cta:''}},
  {...spec,content:{...spec.content,headline:'a'.repeat(141)}}, {...spec,content:{...spec.content,headline:'<script>alert(1)</script>'}},
  {...spec,assetUrl:'https://untrusted.invalid'}, {...spec,ratio:'5:7'}, {...spec,slots:{logo:'yes'}},
  {...spec,layout:{...spec.layout,code:'alert(1)'}},
])('rejects invalid or executable/unbounded planner fields %#',value=>expect(()=>parseThemeSpec(value)).toThrow());
it('bounds planner requests without silently truncating them',()=>{
  expect(parseThemePrompt({prompt:' x '})).toBe('x');expect(parseThemePrompt({prompt:'x'.repeat(2000)})).toHaveLength(2000);
  for(const v of [{prompt:''},{prompt:'x'.repeat(2001)},{prompt:'x',ratio:'1:1'},null])expect(()=>parseThemePrompt(v)).toThrow();
});

it('covers bounded placement, optional slots, decorations and arbitrary Unicode without executable fields',()=>{
  for(const [field,value] of [
    ['decorations',['UNKNOWN']],['layout',{...spec.layout,heroPlacement:'outside'}],['layout',{...spec.layout,textAlignment:'justify'}],
    ['content',{...spec.content,offerValue:'x'.repeat(161)}],['palette',{...spec.palette,extra:'red'}],
  ])expect(()=>parseThemeSpec({...spec,[field as string]:value})).toThrow();
  const value=parseThemeSpec({...spec,content:{...spec.content,headline:'दीवाली की खुशियाँ ✨',offerValue:'₹1,500 🎁'},slots:{logo:false,product:false,heroImage:true},layout:{...spec.layout,heroPlacement:'left'}});
  const template=compileOfferTemplate(draft(),value,'ai','ai');expect(templateErrors(template)).toEqual([]);
  expect(template.elements.filter(e=>e.type==='image'&&!e.themeRole?.startsWith('decoration-')).map(e=>e.themeRole)).toEqual(['hero-image']);
});
it('all planner archetypes and placements produce bounded templates with no ornament accumulation',()=>{
  for(const layout of ['OFFER_LEFT_PRODUCT_RIGHT','CENTERED_SALE','PRODUCT_CENTER','EDITORIAL_GREETING','EVENT_PROMO','SPLIT_LAYOUT'] as const)for(const placement of ['left','right','center'] as const){
    const input={...spec,layout:{...spec.layout,archetype:layout,heroPlacement:placement}};
    const once=compileOfferTemplate(draft(),input,'ai','ai'),twice=compileOfferTemplate(once,input,'ai','ai');
    expect(twice).toEqual(once);for(const ratio of DESIGN_ASPECT_RATIOS)expect(templateErrors(templateAtRatio(twice,ratio))).toEqual([]);
  }
});

it('legacy styling replaces owned Diwali ornaments while preserving copy, assets and custom reset',()=>{
  const template=applyCuratedOffer(draft(),'diwali-mega-sale');
  const styled=applyOfferTheme(template,'dhanteras','style');
  expect(styled.offerTemplate).toBeUndefined();expect(templateErrors(styled)).toEqual([]);
  expect(styled.elements.filter(e=>e.themeRole?.startsWith('decoration-'))).toHaveLength(0);
  expect(styled.elements.find(e=>e.themeRole==='headline')?.defaultContent).toEqual(template.elements.find(e=>e.themeRole==='headline')?.defaultContent);
  expect(applyOfferTheme(styled,'dhanteras','style')).toBe(styled);
  const custom=clearOfferTheme(template,'9:16');expect(custom.offerTemplate).toBeUndefined();expect(custom.themeId).toBeUndefined();expect(custom.elements).toHaveLength(template.elements.length);
});
