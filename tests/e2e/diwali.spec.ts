import { expect, test, type Page } from '@playwright/test';
import type { Group } from 'konva/lib/Group';
import type { Stage } from 'konva/lib/Stage';
import { DIWALI_TEMPLATES } from '../../shared/src/designTemplates/offerTemplates.js';
const key='frameflow:design-templates:v1';
const layer=(page:Page,name:string)=>page.locator('.tpl-layers button').filter({has:page.getByText(name,{exact:true})}).first();
const library=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);
async function setup(page:Page) {
  const calls:string[]=[];
  await page.route('**/api/**',route=>{calls.push(route.request().url());return route.abort();});
  if(!process.env.THEME_VISUAL_FONTS)await page.route('https://fonts.googleapis.com/**',route=>route.abort());
  await page.goto('/');await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();return calls;
}
const ready=async(page:Page)=>{await expect(page.locator('.tpl-main')).not.toHaveAttribute('data-fonts-state','loading',{timeout:20000});};
for(const definition of DIWALI_TEMPLATES)test(`${definition.name}: five ratios, local save reuse and editable handoff`,async({page},info)=>{
  test.setTimeout(90000);const calls=await setup(page);
  await page.getByRole('button',{name:`Use ${definition.name} template`,exact:true}).click();await ready(page);
  for(const ratio of ['1:1','4:5','3:4','9:16','16:9']){
    await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
    await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
    await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${definition.id}-${ratio.replace(':','x')}.png`)});
  }
  for(const ratio of ['1:1','9:16','1:1','16:9','1:1'])await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
  // Transparent tall product and wide logo are user assets, not AI imagery.
  for(const [name,w,h] of [['YOUR PRODUCT',220,520],['YOUR LOGO',600,90]] as const){
    const png=await page.evaluate(({w,h})=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d')!;if(h>w){x.fillStyle='#CFB5EC';x.beginPath();x.roundRect(w*.15,10,w*.7,h-20,24);x.fill();x.fillStyle='#493751';x.fillRect(w*.24,30,w*.28,80);}else{x.fillStyle='#C6A169';x.font='bold 50px sans-serif';x.fillText('NOVA',25,65);}return c.toDataURL().split(',')[1];},{w,h});
    await layer(page,name).click();await page.locator('.tpl-panel input[type=file]').setInputFiles({name:'asset.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  }
  await layer(page,'Headline').click();
  await page.getByRole('textbox',{name:'Text',exact:true}).fill('Celebrate the season');
  if(definition.id==='diwali-mega-sale'){
    await page.getByRole('button',{name:'Choose font',exact:true}).click();await page.getByRole('searchbox',{name:'Search fonts'}).fill('Hind');await page.getByRole('listitem',{name:'Use font Hind',exact:true}).click();await ready(page);
  }
  const geometry=()=>page.evaluate(()=>{
    const frame=document.querySelector('[data-testid="template-canvas"]')!;
    const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
    return stage.find('.template-element').map(n=>({id:n.id(),x:n.x(),y:n.y(),offsetX:n.offsetX(),offsetY:n.offsetY(),rotation:n.rotation()}));
  });
  const before=await geometry();
  for(let round=0;round<2;round++)for(const ratio of ['9:16','16:9','4:5','3:4','1:1'])await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
  expect(await geometry()).toEqual(before);
  await expect(page.getByText('Font Family',{exact:true})).toBeVisible();
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${definition.id}-product-logo.png`)});
  await page.screenshot({path:info.outputPath(`${definition.id}-workspace.png`)});
  await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:'9:16',exact:true}).click();
  await page.getByRole('button',{name:'Save Template',exact:true}).click();const saved=(await library(page)).templates[0];
  expect(saved.offerTemplate.definitionId).toBe(definition.id);expect(saved.canvas.masterAspectRatio).toBe('9:16');
  await page.reload();await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();
  await page.getByRole('button',{name:'Use Template',exact:true}).click();await ready(page);
  const field=page.locator('fieldset').filter({has:page.locator('legend',{hasText:/^Headline/})});
  await field.locator('textarea').fill('Festive savings');
  await page.getByRole('button',{name:'Save Creative',exact:true}).click();
  expect((await library(page)).templates[0]).toEqual(saved);
  await page.getByRole('button',{name:'Open in editor',exact:true}).click();
  await expect(page.getByRole('dialog',{name:/Use Template/})).not.toBeVisible();
  await expect.poll(async()=>page.evaluate(()=>JSON.parse(localStorage.getItem('frameflow:project:v1')!).variants.some((v:{template?:unknown})=>!!v.template))).toBe(true);
  expect(calls).toEqual([]);
});
test('AI drafts, one request per click, failure/manual retry, independent persisted themes',async({page},info)=>{
  test.setTimeout(90000);const calls=await setup(page);let requests=0;let fail=true;
  await page.route('**/api/themes/plan',async route=>{requests++;const spec=structuredClone(DIWALI_TEMPLATES[requests===3?1:0].spec);spec.templateName=requests===3?'AI Premium Diwali':'AI Sale Diwali';return route.fulfill({status:fail?502:200,contentType:'application/json',body:JSON.stringify(fail?{error:{message:'Mock planner failure'}}:{spec})});});
  await page.getByRole('button',{name:'Use Diwali Mega Sale template',exact:true}).click();
  await page.locator('.ai-theme-panel summary').click();
  await page.getByRole('textbox',{name:'Describe your Diwali creative'}).fill('Premium Diwali offer');expect(requests).toBe(0);
  const generate=page.getByRole('button',{name:'Generate Editable Theme',exact:true});await generate.click();await expect(page.getByRole('alert')).toContainText('Mock planner failure');expect(requests).toBe(1);
  expect(await page.getByRole('textbox',{name:'Describe your Diwali creative'}).inputValue()).toBe('Premium Diwali offer');
  fail=false;await generate.click();await expect(page.getByRole('group',{name:'AI theme draft'})).toBeVisible();expect(requests).toBe(2);
  await expect(page.getByLabel('Template name')).toHaveValue('Diwali Mega Sale');
  await page.getByRole('button',{name:'Apply generated theme',exact:true}).click();await ready(page);
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath('ai-sale.png')});
  await layer(page,'Headline').click();await page.getByRole('textbox',{name:'Text',exact:true}).fill('Our Diwali campaign');
  await page.getByRole('button',{name:'Choose font',exact:true}).click();await page.getByRole('searchbox',{name:'Search fonts'}).fill('Hind');await page.getByRole('listitem',{name:'Use font Hind',exact:true}).click();await ready(page);
  await page.getByRole('textbox',{name:'Colour hex',exact:true}).fill('#FFFFFF');
  await page.getByRole('button',{name:'+ Circle',exact:true}).click();await page.getByRole('button',{name:'Remove element',exact:true}).click();
  await layer(page,'diya ornament').click();await page.getByRole('button',{name:'Remove element',exact:true}).click();
  await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:'4:5',exact:true}).click();
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  await page.getByRole('navigation',{name:'Templates'}).getByRole('button',{name:'Create Own Template',exact:true}).click();await page.locator('.ai-theme-panel summary').click();
  await page.getByRole('textbox',{name:'Describe your Diwali creative'}).fill('Premium gold Diwali');await generate.click();await page.getByRole('button',{name:'Apply generated theme',exact:true}).click();await ready(page);
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath('ai-premium.png')});
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  const stored=await library(page);expect(stored.templates).toHaveLength(2);expect(stored.templates.map((t:{offerTemplate:{source:string}})=>t.offerTemplate.source)).toEqual(['ai','ai']);
  await page.reload();await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();await page.getByRole('button',{name:'Use Template',exact:true}).first().click();await ready(page);
  for(const ratio of ['4:5','3:4','9:16','16:9','1:1'])await page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:ratio,exact:true}).click();
  const cta=page.locator('fieldset').filter({has:page.locator('legend',{hasText:/^CTA/})});await cta.locator('textarea').fill('VIEW CAMPAIGN');
  await page.getByRole('button',{name:'Save Creative',exact:true}).click();expect((await library(page)).templates).toEqual(stored.templates);
  await page.getByRole('button',{name:'Open in editor',exact:true}).click();await expect(page.getByRole('dialog',{name:/Use Template/})).not.toBeVisible();
  expect(requests).toBe(3);expect(calls).toEqual([]);
});
test('safe replacement and Hindi long offers keep native editing',async({page},info)=>{
  test.setTimeout(60000);await setup(page);await page.getByRole('button',{name:'Use Diwali Mega Sale template',exact:true}).click();await ready(page);
  await page.locator('.diwali-gallery summary').click();await page.getByRole('button',{name:'Use Luxury Gold Diwali template',exact:true}).click();
  await expect(page.getByLabel('Template name')).toHaveValue('Diwali Mega Sale');await page.getByRole('button',{name:'Cancel replacement'}).click();
  await layer(page,'Offer').click();
  for(const copy of ['UP TO 50% OFF','SPECIAL FESTIVE CASHBACK ON SELECTED ELECTRONICS','FLAT ₹1,500 CASHBACK','EXTRA 20% OFF ON SELECTED PRODUCTS','इस दिवाली पाएं 40% तक की बचत']){
    await page.locator('.tpl-panel textarea').fill(copy);await ready(page);await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  }
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath('hindi-long-offer.png')});
});

test('event copy and image extremes remain contained, with explicit overflow feedback',async({page},info)=>{
  test.setTimeout(90000);await setup(page);await page.getByRole('button',{name:'Use Event / Store Promo template',exact:true}).click();await ready(page);
  for(const [role,copies] of [['Date / time',['01 NOV 2026','SATURDAY, 01 NOVEMBER 2026','5 PM ONWARDS']],['Location',['123, VERY LONG MARKET ROAD, NEW DELHI','Phoenix Mall, Lower Parel','नई दिल्ली\nमुख्य बाजार']]] as const){
    await layer(page,role).click();
    for(const copy of copies){await page.getByRole('textbox',{name:'Text',exact:true}).fill(copy);await ready(page);for(const ratio of ['1:1','4:5','3:4','9:16','16:9']){await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();}}
    await page.getByRole('textbox',{name:'Text',exact:true}).fill('Long event information '.repeat(100));await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeDisabled();await expect(page.locator('.ws-warn').filter({hasText:'needs shorter text'})).toBeVisible();
    await page.getByRole('textbox',{name:'Text',exact:true}).fill(copies[0]);
  }
  for(const [role,w,h] of [['YOUR PRODUCT',900,180],['YOUR PRODUCT',400,400],['YOUR PRODUCT',12,12],['YOUR LOGO',60,400],['YOUR LOGO',1200,80]] as const){
    const png=await page.evaluate(({w,h})=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d')!;x.fillStyle='#FFD090';x.fillRect(w*.1,h*.1,w*.8,h*.8);return c.toDataURL().split(',')[1];},{w,h});
    await layer(page,role).click();await page.locator('.tpl-panel input[type=file]').setInputFiles({name:'shape.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await expect(page.getByRole('combobox',{name:'Fit',exact:true})).toHaveValue('contain');
    await expect.poll(()=>page.evaluate(({role,w,h})=>{
      const frame=document.querySelector('[data-testid="template-canvas"]')!;
      const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
      const picture=stage.findOne<Group>(`#offer-${role==='YOUR PRODUCT'?'product':'logo'}`)?.findOne('.template-image');
      const image=picture?.getAttr('image') as HTMLImageElement|undefined;
      return image?.naturalWidth===w&&image?.naturalHeight===h&&Math.abs(picture!.width()/picture!.height()-w/h)<.001;
    },{role,w,h})).toBe(true);
  }
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath('event-date-location-images.png')});
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  const original=(await library(page)).templates[0];expect(original.elements.filter((e:{type:string;behavior:{fit:string}})=>e.type==='image').every((e:{behavior:{fit:string}})=>e.behavior.fit==='contain')).toBe(true);
});
