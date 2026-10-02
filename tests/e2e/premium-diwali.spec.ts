import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { Stage } from 'konva/lib/Stage';
import type { Group } from 'konva/lib/Group';
import { PREMIUM_DIWALI_TEMPLATES } from '../../shared/src/designTemplates/premiumDefinitions.js';
const libraryKey='frameflow:design-templates:v1';
const layer=(page:Page,name:string)=>page.locator('.tpl-layers button').filter({has:page.getByText(name,{exact:true})}).first();
const library=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),libraryKey);
const ratio=async(page:Page,value:string)=>page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:value,exact:true}).click();
const ready=async(page:Page)=>{
  await expect(page.locator('.tpl-main')).not.toHaveAttribute('data-fonts-state','loading',{timeout:20000});
  if(process.env.THEME_VISUAL_FONTS)await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  await expect.poll(()=>page.evaluate(()=>{
    const frame=document.querySelector('[data-testid="template-canvas"]')!;
    const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()));
    return !!stage&&stage.find('.template-image').length>2&&stage.find('.template-image-placeholder').every(n=>n.getParent()?.id()==='offer-logo');
  })).toBe(true);
};
async function setup(page:Page){
  const calls:string[]=[];await page.route('**/api/**',route=>{calls.push(route.request().url());return route.abort();});
  if(!process.env.THEME_VISUAL_FONTS)await page.route('https://fonts.googleapis.com/**',route=>route.abort());
  await page.goto('/');await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();return calls;
}
async function imageInput(page:Page,name:string,w:number,h:number,fit:'contain'|'cover'='contain'){
  const png=await page.evaluate(({w,h})=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d')!;x.fillStyle='#CEAF74';x.beginPath();x.roundRect(w*.1,h*.1,w*.8,h*.8,Math.min(w,h)*.1);x.fill();x.fillStyle='#3D214A';x.font=`bold ${Math.min(w,h)*.2}px sans-serif`;x.fillText('NOVA',w*.13,h*.55);return c.toDataURL().split(',')[1];},{w,h});
  await layer(page,name).click();await page.locator('.tpl-panel input[type=file]').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.getByRole('combobox',{name:'Fit',exact:true})).toHaveValue(fit);
  await expect.poll(()=>page.evaluate(({name,w,h,fit})=>{
    const frame=document.querySelector('[data-testid="template-canvas"]')!;
    const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
    const role=name==='YOUR LOGO'?'logo':name==='YOUR HERO'?'hero-image':name==='Festive environment'?'decoration-scene':'product';
    const group=stage.findOne<Group>(`#offer-${role}`),image=group?.findOne('.template-image');
    const bitmap=image?.getAttr('image') as HTMLImageElement|undefined;
    if(!image||!group||bitmap?.naturalWidth!==w||bitmap.naturalHeight!==h)return false;
    const boxW=group.offsetX()*2,boxH=group.offsetY()*2,crop=image.getAttr('crop') as {x:number;y:number;width:number;height:number}|undefined;
    if(fit==='contain')return Math.abs(image.width()/image.height()-w/h)<.001&&image.width()<=boxW+.01&&image.height()<=boxH+.01&&(!crop||crop.width===w&&crop.height===h);
    return Math.abs(image.width()-boxW)<.01&&Math.abs(image.height()-boxH)<.01&&!!crop&&Math.abs(crop.width/crop.height-boxW/boxH)<.001&&crop.x>=0&&crop.y>=0&&crop.x+crop.width<=w+.01&&crop.y+crop.height<=h+.01&&(crop.width<w||crop.height<h);
  },{name,w,h,fit})).toBe(true);
}
for(const definition of PREMIUM_DIWALI_TEMPLATES)test(`${definition.id}: visual ratios, editing, save reuse and editor`,async({page},info)=>{
  test.setTimeout(150000);const calls=await setup(page);
  await page.getByRole('button',{name:`Use ${definition.name} template`,exact:true}).click();await ready(page);
  for(const value of ['1:1','4:5','3:4','9:16','16:9']){
    await ratio(page,value);await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
    await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${definition.id}-${value.replace(':','x')}.png`)});
    // Save a full-resolution canvas render for the gallery/visual review. No UI chrome or placeholders for text.
    const data=await page.evaluate(()=>{
      const frame=document.querySelector('[data-testid="template-canvas"]')!;
      const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
      return stage.toDataURL({pixelRatio:1/stage.scaleX()});
    });
    await info.attach(`${definition.id}-${value.replace(':','x')}-canvas`,{body:Buffer.from(data.split(',')[1],'base64'),contentType:'image/png'});
    await writeFile(info.outputPath(`${definition.id}-${value.replace(':','x')}-render.png`),Buffer.from(data.split(',')[1],'base64'));
  }
  await ratio(page,'1:1');
  const geometry=()=>page.evaluate(()=>{const frame=document.querySelector('[data-testid="template-canvas"]')!;const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;return stage.find('.template-element').map(n=>({id:n.id(),x:n.x(),y:n.y(),w:n.offsetX(),h:n.offsetY()}));});
  const before=await geometry();for(let round=0;round<2;round++)for(const value of ['9:16','16:9','4:5','3:4','1:1'])await ratio(page,value);expect(await geometry()).toEqual(before);
  const target=definition.spec.slots.heroImage?'YOUR HERO':definition.spec.slots.product?'YOUR PRODUCT':'Festive environment';
  await imageInput(page,target,220,440,definition.id==='premium-lantern'?'cover':'contain');await imageInput(page,'YOUR LOGO',900,140);
  await layer(page,'Headline').click();await page.getByRole('textbox',{name:'Text',exact:true}).fill('दीवाली की खुशियाँ');
  await page.getByRole('button',{name:'Choose font',exact:true}).click();await page.getByRole('searchbox',{name:'Search fonts'}).fill('Hind');await page.getByRole('listitem',{name:'Use font Hind',exact:true}).click();await ready(page);
  await page.getByRole('textbox',{name:'Colour hex',exact:true}).fill('#FFFFFF');
  if(definition.id==='premium-event')for(const [name,text] of [['Date','SATURDAY · 24 OCTOBER'],['Time','7 PM ONWARDS'],['Dress code','FESTIVE ATTIRE'],['Location','नई दिल्ली · मुख्य बाजार']]){await layer(page,name).click();await page.getByRole('textbox',{name:'Text',exact:true}).fill(text);}
  if(definition.id==='premium-ecommerce'){await layer(page,'Offer').click();await page.getByRole('textbox',{name:'Text',exact:true}).fill('UP TO 40% OFF');}
  await layer(page,'Atmosphere · light & grain').click();await page.getByRole('button',{name:'Remove element',exact:true}).click();
  const history=page.getByRole('group',{name:'Template history'});await history.getByRole('button',{name:/Undo/}).click();await expect(layer(page,'Atmosphere · light & grain')).toHaveCount(1);
  await ratio(page,'9:16');await ready(page);
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${definition.id}-edited.png`)});
  await page.getByRole('button',{name:'Save Template',exact:true}).click();const saved=(await library(page)).templates[0];
  expect(saved.offerTemplate.definitionId).toBe(definition.id);expect(saved.canvas.masterAspectRatio).toBe('9:16');
  expect(saved.elements.find((e:{themeRole:string})=>e.themeRole==='headline').style.fontFamily).toBe('Hind');
  await page.reload();await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();await page.getByRole('button',{name:'Use Template',exact:true}).click();await ready(page);
  await page.locator('fieldset').filter({has:page.locator('legend',{hasText:/^Headline/})}).locator('textarea').fill('Our Diwali story');
  for(const name of [target,'YOUR LOGO']){
    const field=page.locator('fieldset').filter({has:page.locator('legend',{hasText:name})});
    const bytes=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=360;c.height=180;const x=c.getContext('2d')!;x.fillStyle='#FFD080';x.fillRect(10,10,340,160);return c.toDataURL().split(',')[1];});
    await field.locator('input[type=file]').setInputFiles({name:'creative.png',mimeType:'image/png',buffer:Buffer.from(bytes,'base64')});
    await expect.poll(()=>renderedState(page).then(nodes=>nodes.find(n=>n.id===`offer-${name==='YOUR LOGO'?'logo':name==='YOUR HERO'?'hero-image':name==='Festive environment'?'decoration-scene':'product'}`)?.images[0]?.src)).toMatch(/^blob:/);
  }
  if(definition.spec.content.offerValue)await page.locator('fieldset').filter({has:page.locator('legend',{hasText:/^Offer(?:\s|$)/})}).first().locator('textarea').fill('40%');
  await page.getByRole('button',{name:'Save Creative',exact:true}).click();expect((await library(page)).templates[0]).toEqual(saved);
  await page.getByRole('button',{name:'Open in editor',exact:true}).click();await expect(page.getByRole('dialog',{name:/Use Template/})).not.toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('frameflow:project:v1')!).variants.some((v:{template?:unknown})=>!!v.template))).toBe(true);
  const project=await page.evaluate(()=>JSON.parse(localStorage.getItem('frameflow:project:v1')!));
  const imported=project.variants.find((v:{template?:unknown})=>v.template);
  expect(imported.layers.filter((l:{name:string})=>l.name==='Atmosphere · light & grain')).toHaveLength(1);
  expect(imported.elements.some((e:{text:string})=>e.text==='Our Diwali story')).toBe(true);
  expect(calls).toEqual([]);
});
test('premium application is atomic, AI has one explicit request and Apply',async({page})=>{
  test.setTimeout(90000);await setup(page);await page.getByRole('button',{name:'Use Diwali Mega Sale template',exact:true}).click();
  await page.locator('.premium-gallery summary').click();await page.getByRole('button',{name:'Use Premium Product Gift Campaign template',exact:true}).click();await page.getByRole('button',{name:'Replace canvas',exact:true}).click();await ready(page);
  const history=page.getByRole('group',{name:'Template history'});await history.getByRole('button',{name:/Undo/}).click();await expect(page.getByLabel('Template name')).toHaveValue('Diwali Mega Sale');await history.getByRole('button',{name:/Redo/}).click();await expect(page.getByLabel('Template name')).toHaveValue('Premium Product Gift Campaign');
  let requests=0;await page.route('**/api/themes/plan',route=>{requests++;return route.fulfill({json:{spec:PREMIUM_DIWALI_TEMPLATES[4].spec}});});
  await page.locator('.ai-theme-panel summary').click();await page.getByRole('textbox',{name:'Describe your Diwali creative'}).fill('A premium Diwali invitation');await page.getByRole('button',{name:'Generate Editable Theme',exact:true}).click();await expect(page.getByRole('group',{name:'AI theme draft'})).toBeVisible();expect(requests).toBe(1);await expect(page.getByLabel('Template name')).toHaveValue('Premium Product Gift Campaign');await page.getByRole('button',{name:'Apply generated theme',exact:true}).click();await ready(page);await expect(page.getByLabel('Template name')).toHaveValue('Premium Diwali Event Invite');
  await history.getByRole('button',{name:/Undo/}).click();await expect(page.getByLabel('Template name')).toHaveValue('Premium Product Gift Campaign');await history.getByRole('button',{name:/Redo/}).click();await expect(page.getByLabel('Template name')).toHaveValue('Premium Diwali Event Invite');expect(requests).toBe(1);
});

test('contain products/logos and cover scenes preserve image geometry',async({page})=>{
  test.setTimeout(90000);const calls=await setup(page);
  await page.getByRole('button',{name:'Use Lantern Night Celebration template',exact:true}).click();await ready(page);
  for(const [w,h] of [[180,700],[1000,160],[360,360]])await imageInput(page,'YOUR HERO',w,h,'cover');
  for(const [w,h] of [[900,120],[180,600],[400,400]])await imageInput(page,'YOUR LOGO',w,h);
  await page.locator('.premium-gallery summary').click();await page.getByRole('button',{name:'Use Premium Product Gift Campaign template',exact:true}).click();await page.getByRole('button',{name:'Replace canvas',exact:true}).click();await ready(page);
  for(const [w,h] of [[180,700],[1000,160],[360,360]])await imageInput(page,'YOUR PRODUCT',w,h);
  expect(calls).toEqual([]);
});

// This snapshot reads actual rendered state; editing still goes through visible controls.
const renderedState=(page:Page)=>page.evaluate(()=>{
  const frame=document.querySelector('[data-testid="template-canvas"]')!;
  const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
  return stage.find<Group>('.template-element').map(n=>({id:n.id(),x:n.x(),y:n.y(),w:n.offsetX(),h:n.offsetY(),texts:n.find('.template-text').map(t=>({text:t.getAttr('text'),font:t.getAttr('fontFamily'),color:t.getAttr('fill')})),images:n.find('.template-image').map(i=>({src:(i.getAttr('image') as HTMLImageElement).src,w:i.width(),h:i.height()}))}));
});
test('premium empty offers, text, fonts, images and ratio geometry restore through history',async({page})=>{
  test.setTimeout(90000);const calls=await setup(page);
  await page.getByRole('button',{name:'Use Premium Product Gift Campaign template',exact:true}).click();await ready(page);
  const states=[await renderedState(page)];
  await layer(page,'Offer').click();const text=page.getByRole('textbox',{name:'Text',exact:true});
  await expect(text).toHaveValue('');await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  await text.fill('20%');await text.blur();states.push(await renderedState(page));
  expect(states.at(-1)!.find(n=>n.id==='offer-offer-value')?.texts[0]?.text).toBe('20%');
  await page.getByRole('button',{name:'Choose font',exact:true}).click();await page.getByRole('searchbox',{name:'Search fonts'}).fill('Hind');await page.getByRole('listitem',{name:'Use font Hind',exact:true}).click();await ready(page);states.push(await renderedState(page));
  await imageInput(page,'YOUR PRODUCT',240,480);states.push(await renderedState(page));
  const history=page.getByRole('group',{name:'Template history'}),undo=history.getByRole('button',{name:/Undo/}),redo=history.getByRole('button',{name:/Redo/});
  for(let i=states.length-2;i>=0;i--){await undo.click();await ready(page);await expect.poll(()=>renderedState(page)).toEqual(states[i]);}
  for(const state of states.slice(1)){await redo.click();await ready(page);await expect.poll(()=>renderedState(page)).toEqual(state);}
  await ratio(page,'16:9');const wide=await renderedState(page);await layer(page,'YOUR PRODUCT').click();
  const x=page.locator('.tpl-panel label.tpl-field').filter({has:page.locator('span',{hasText:/^X$/})}).getByRole('spinbutton');await x.fill('35');await x.blur();expect(await renderedState(page)).not.toEqual(wide);
  await undo.click();await expect.poll(()=>renderedState(page)).toEqual(wide);await redo.click();
  await page.getByRole('button',{name:'Save Template',exact:true}).click();const saved=(await library(page)).templates[0];
  expect(saved.elements.find((e:{id:string})=>e.id==='offer-offer-value').defaultContent.text).toBe('20%');
  await page.reload();await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();await page.getByRole('button',{name:'Edit Template',exact:true}).click();await ready(page);await layer(page,'Offer').click();await expect(page.getByRole('textbox',{name:'Text',exact:true})).toHaveValue('20%');expect((await library(page)).templates[0]).toEqual(saved);expect(calls).toEqual([]);
});

test('premium critical long copy requires correction and Hindi event details remain usable',async({page})=>{
  test.setTimeout(90000);const calls=await setup(page);
  for(const [template,roles] of [['Premium Jewellery Festive Offer',['Headline','Offer wording','Second offer wording','CTA']],['Premium Diwali Event Invite',['Headline','Date','Time','Location','Dress code']]] as const){
    if(template==='Premium Diwali Event Invite')await page.locator('.premium-gallery summary').click();
    await page.getByRole('button',{name:`Use ${template} template`,exact:true}).click();
    if(template==='Premium Diwali Event Invite')await page.getByRole('button',{name:'Replace canvas',exact:true}).click();
    await ready(page);
    for(const role of roles){
      await layer(page,role).click();const input=page.getByRole('textbox',{name:'Text',exact:true}),original=await input.inputValue();
      await input.fill('Important festive campaign information '.repeat(110));
      await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeDisabled();await expect(page.locator('.ws-warn').filter({hasText:'needs shorter text'})).toBeVisible();
      await input.fill(original);await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
    }
  }
  for(const [role,copy] of [['Date','SATURDAY, 24 OCTOBER 2026'],['Location','नई दिल्ली · मुख्य बाजार']]){await layer(page,role).click();await page.getByRole('textbox',{name:'Text',exact:true}).fill(copy);await ready(page);for(const r of ['1:1','4:5','3:4','9:16','16:9']){await ratio(page,r);await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();}}
  expect(calls).toEqual([]);
});

test('premium gallery displays six local canvas-rendered previews without planner calls',async({page},info)=>{
  const calls=await setup(page);const previews=page.locator('.premium-gallery img');await expect(previews).toHaveCount(6);
  for(const preview of await previews.all()){
    await preview.scrollIntoViewIfNeeded();await expect(preview).toHaveJSProperty('naturalWidth',420);await expect(preview).toHaveAttribute('loading','lazy');
  }
  await page.locator('.premium-gallery summary').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('premium-gallery.png')});expect(calls).toEqual([]);
});
