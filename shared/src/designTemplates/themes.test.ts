import { describe, expect, it } from 'vitest';
import { OFFER_THEMES, THEME_SAFE_AREAS, applyOfferTheme, applyThemePairing, clearOfferTheme } from './themes.js';
import { DESIGN_ASPECT_RATIOS, templateErrors } from './schema.js';
import { addElement, createTemplateDraft, createTemplateElement, removeElement, updateElement } from './editing.js';
import { elementAtRatio, setRatioLayout } from './responsive.js';
import { applyCreative, createCreative, setCreativeOverride } from './creative.js';
import { duplicateDesignTemplate, emptyLibrary, parseLibrary, saveDesignTemplate, serializeLibrary } from './library.js';
import { catalogFont, searchFonts, FONT_CATALOG, fontWeightFor, fontStack } from '../fonts/catalog.js';
const now='2026-10-01T00:00:00Z';
const blank=()=>createTemplateDraft('test',now,'Offer');

describe('local offer themes',()=>{
  for(const theme of OFFER_THEMES) for(const ratio of DESIGN_ASPECT_RATIOS) it(`${theme.name}: valid, editable, safe ${ratio} composition`,()=>{
    const template=applyOfferTheme(blank(),theme.id,'replace');
    expect(templateErrors(template)).toEqual([]);
    expect(new Set(template.elements.map(e=>e.id)).size).toBe(template.elements.length);
    expect(template.elements.length).toBeLessThanOrEqual(50);
    const safe=THEME_SAFE_AREAS[ratio];
    for(const role of ['logo-slot','headline','offer-value','cta','terms','hero-image-slot']){
      const source=template.elements.find(e=>e.themeRole===role)!;
      const e=elementAtRatio(source,ratio),b=e.layout;
      expect(b.x).toBeGreaterThanOrEqual(safe.x);expect(b.y).toBeGreaterThanOrEqual(safe.y);
      expect(b.x+b.width).toBeLessThanOrEqual(safe.x+safe.width+1e-9);expect(b.y+b.height).toBeLessThanOrEqual(safe.y+safe.height+1e-9);
      expect(Object.values(e.editableProperties)).toContain(true);
      expect(e.defaultContent).toEqual(source.defaultContent);
      if(e.type==='image')expect(e.behavior.fit).toBe('contain');
    }
    for(const family of [...theme.recommendations.headings,...theme.recommendations.body])expect(catalogFont(family)).toBeDefined();
  });
  it('styling preserves edited copy, assets, custom elements, IDs, and geometry without accumulating decorations',()=>{
    let t=applyOfferTheme(blank(),'diwali','replace');
    t=updateElement(t,'theme-headline',e=>e.type==='text'?{...e,defaultContent:{text:'₹1,500 की बचत — 40% OFF'}}:e);
    t=updateElement(t,'theme-hero-image-slot',e=>e.type==='image'?{...e,defaultContent:{assetId:'my-product'}}:e);
    t=addElement(t,createTemplateElement('heading','custom',99));
    const custom=t.elements.find(e=>e.id==='custom')!;
    const originalHeadline=t.elements.find(e=>e.id==='theme-headline')!;
    for(const id of ['dhanteras','holi','diwali','dhanteras','holi','diwali']){
      t=applyOfferTheme(t,id,'style');
      expect(templateErrors(t)).toEqual([]);
      expect(new Set(t.elements.map(e=>e.id)).size).toBe(t.elements.length);
      expect(t.elements.find(e=>e.id==='theme-headline')?.defaultContent).toEqual(originalHeadline.defaultContent);
      expect(t.elements.find(e=>e.id==='theme-headline')?.ratioLayouts).toEqual(originalHeadline.ratioLayouts);
      expect(t.elements.find(e=>e.id==='theme-hero-image-slot')?.defaultContent).toEqual({assetId:'my-product'});
      expect(t.elements.find(e=>e.id==='custom')).toMatchObject({style:custom.style,defaultContent:custom.defaultContent,layout:custom.layout});
    }
    expect(t.elements.length).toBe(applyOfferTheme(blank(),'diwali','replace').elements.length+1);
    const removed=removeElement(t,'test-diwali-decoration-0');
    expect(applyOfferTheme(removed,'diwali','style')).toBe(removed);
    const paired=applyThemePairing(t);
    expect(paired.elements.find(e=>e.id==='custom')).toEqual(t.elements.find(e=>e.id==='custom'));
    const reset=clearOfferTheme(t,'9:16');
    expect(reset.themeId).toBeUndefined();expect(reset.elements).toHaveLength(t.elements.length);
    expect(reset.elements.find(e=>e.id==='theme-headline')?.layout).toEqual(elementAtRatio(originalHeadline,'9:16').layout);
    expect(reset.elements.every(e=>!e.themeRole&&!e.ratioLayouts)).toBe(true);
  });
  it('ratio edits remain isolated; creative content is shared and editor handoff materializes the selected layout',()=>{
    let t=applyOfferTheme(blank(),'holi','replace');
    const previous=t.elements.find(e=>e.id==='theme-headline')!;
    t=setRatioLayout(t,previous.id,'9:16',{x:.1});
    const changed=t.elements.find(e=>e.id===previous.id)!;
    expect(elementAtRatio(changed,'1:1').layout).toEqual(previous.layout);
    expect(elementAtRatio(changed,'9:16').layout.x).toBe(.1);
    for(const aspectRatio of DESIGN_ASPECT_RATIOS){
      let c=createCreative(t,{id:'creative',name:'Offer',now,aspectRatio});
      c=setCreativeOverride(c,t,previous.id,{text:'एक खास Offer ₹500'},now);
      const result=applyCreative(t,c).elements.find(e=>e.id===previous.id)!;
      expect(result.layout).toEqual(elementAtRatio(changed,aspectRatio).layout);
      expect(result.ratioLayouts).toBeUndefined();expect(result.defaultContent).toEqual({text:'एक खास Offer ₹500'});
    }
  });
  it('persists and duplicates themes/fonts; accepts old custom templates without new metadata',()=>{
    const t=applyOfferTheme(blank(),'dhanteras','replace');
    const saved=saveDesignTemplate(emptyLibrary(),t,now);
    const loaded=parseLibrary(serializeLibrary(saved.library));
    expect(loaded.templates[0]).toEqual(saved.template);
    const copy=duplicateDesignTemplate(loaded,t.id,'copy',now).template;
    expect(copy.elements).toEqual(t.elements);expect(copy.themeId).toBe('dhanteras');
    expect(templateErrors(blank())).toEqual([]);
    const legacy=JSON.parse(serializeLibrary(saved.library));
    delete legacy.templates[0].themeId;
    const legacyText=legacy.templates[0].elements.find((e:{type:string})=>e.type==='text');delete legacyText.style.fontFamily;
    expect(parseLibrary(JSON.stringify(legacy)).templates[0].elements.find(e=>e.id===legacyText.id)).toMatchObject({style:{fontFamily:'Inter'}});
    const custom=clearOfferTheme(t,'1:1');
    expect(saveDesignTemplate(loaded,custom,now).outcome).toBe('new-version');
    expect(loaded.templates[0].themeId).toBe('dhanteras');
  });
});
describe('catalog',()=>{
  it.each(['Baloo','baloo','BALOO','  Baloo  '])('searches %s without loading font files',query=>expect(searchFonts(query).map(f=>f.family)).toContain('Baloo 2'));
  it('contains all versioned families, partial matches, truthful script metadata and fallback choices',()=>{
    expect(FONT_CATALOG.length).toBeGreaterThan(1900);expect(searchFonts('a').length).toBeGreaterThan(300);
    expect(searchFonts('not-a-real-font-family-xyz')).toEqual([]);
    expect(catalogFont('Noto Sans Devanagari')?.devanagari).toBe(true);
    expect(catalogFont('Cinzel')?.devanagari).toBe(false);
    expect(fontWeightFor('Yatra One',700)).toBe(400);
    expect(fontStack('Cinzel')).toContain('Noto Sans Devanagari');
  });
});
