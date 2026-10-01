import { expect, test, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
const KEY='frameflow:design-templates:v1';
const ratios=['1:1','4:5','3:4','9:16','16:9'];
const layer=(page:Page,name:string)=>page.locator('.tpl-layers button').filter({hasText:new RegExp(`^${name}`)}).first();
const stored=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),KEY);
const textState=(page:Page)=>page.evaluate(()=>{
  const el=document.querySelector('[data-testid="template-canvas"]')!;
  const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>el.contains(s.container()))!;
  return stage.find<Text>('.template-text').map(n=>({text:n.text(),font:n.fontFamily(),size:n.fontSize(),lines:n.textArr.map(l=>l.text)}));
});
async function setup(page:Page) {
  const paid:string[]=[],fontRequests:string[]=[];
  await page.route(url=>url.pathname.startsWith('/api/'),route=>{paid.push(route.request().url());return route.abort();});
  // Deterministic offline face fixture. Optional visual run uses only Google's free CSS/font endpoints.
  if(!process.env.THEME_VISUAL_FONTS)await page.route('https://fonts.googleapis.com/**',async route=>{
    fontRequests.push(route.request().url());
    const value=new URL(route.request().url()).searchParams.get('family')!,[family,axis]=value.split(':');
    const weight=axis.split('@')[1];
    const local=await page.evaluate(()=>[...document.styleSheets].filter(s=>s.href?.includes('/assets/')).flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText);}catch{return [];}}).find(r=>r.includes('font-family: Inter')&&r.includes('font-weight: 400'))?.match(/url\("?([^")]+)/)?.[1]);
    if(!local)return route.abort();
    return route.fulfill({contentType:'text/css',body:`@font-face { font-family: '${family}'; font-weight:${weight}; src:url('${new URL(local,page.url()).href}'); font-display:swap; }`});
  });
  await page.goto('/');
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();
  return {paid,fontRequests};
}
for(const [theme,font] of [['Diwali','Yatra One'],['Dhanteras','Cinzel'],['Holi','Baloo 2']])test(`${theme}: editable themed ratios, fonts, persistence and editor`,async({page},info)=>{
  test.setTimeout(100_000);
  const {paid,fontRequests}=await setup(page);
  await page.getByLabel('Template name').fill(`${theme} campaign`);
  await page.getByRole('button',{name:`Apply ${theme} theme`,exact:true}).click();
  await expect(page.locator('.tpl-layers li')).not.toHaveCount(0);
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready',{timeout:20000});
  // Wait for the selected families to finish, including remeasurement after late font responses.
  await expect.poll(async()=> (await textState(page)).some(t=>t.font.includes(font))).toBe(true);
  for(const ratio of ratios){
    await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
    await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
    await page.getByTestId('template-canvas').click({trial:true});
    if(['1:1','4:5','9:16','16:9'].includes(ratio)){
      // Wait on fonts explicitly for visual artifacts; no generation request is made.
      await page.evaluate(async()=>{await document.fonts.ready;});
      await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${theme}-${ratio.replace(':','x')}.png`)});
      await page.screenshot({path:info.outputPath(`${theme}-${ratio.replace(':','x')}-workspace.png`)});
    }
  }
  await layer(page,'Headline').click();
  await page.locator('.tpl-panel textarea').fill(theme==='Holi'?'रंगों की खुशियाँ\nFestive savings':'Celebrate every day\nSave more');
  await page.getByRole('button',{name:'Choose font',exact:true}).click();
  const before=fontRequests.length;
  await page.getByRole('searchbox',{name:'Search fonts'}).fill('  HIND  ');
  await expect(page.getByRole('list',{name:'Font search results'}).getByRole('listitem',{name:'Use font Hind',exact:true})).toBeVisible();
  expect(fontRequests.length).toBe(before);
  await page.getByRole('listitem',{name:'Use font Hind',exact:true}).click();
  await expect.poll(async()=> (await textState(page)).some(t=>t.font.includes('Hind'))).toBe(true);
  // Very long copy must remain editable and block handoff, never silently produce a clipped primary offer.
  await layer(page,'Offer').click();
  await page.locator('.tpl-panel textarea').fill('FLAT ₹1,500 CASHBACK ON SELECTED PRODUCTS');
  await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:'9:16',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  // Transparent product and a wide logo are stored as local assets and retain their aspect.
  const picture=async(w:number,h:number)=>page.evaluate(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d')!;x.fillStyle='#bca9ef';x.fillRect(40,20,100,240);x.fillStyle='#443655';x.fillRect(50,30,25,40);if(w>h){x.clearRect(0,0,w,h);x.fillStyle='#BCA9EF';x.font='bold 64px Arial';x.fillText('NOVA OFFERS',12,67);}return c.toDataURL().split(',')[1];},[w,h]);
  const png=await picture(180,300);
  for(const name of ['PRODUCT / HERO IMAGE','YOUR LOGO']){
    await layer(page,name).click();
    await page.locator('.tpl-panel input[type=file]').first().setInputFiles({name:'product.png',mimeType:'image/png',buffer:Buffer.from(name==='YOUR LOGO'?await picture(600,90):png,'base64')});
    await expect(page.getByRole('button',{name:'Replace image',exact:true})).toBeVisible();
  }
  // After replacing the picture, every ratio still contains the whole original product.
  for (const ratio of ratios) {
    await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
    const images=await page.evaluate(()=>{
      const frame=document.querySelector('[data-testid="template-canvas"]')!;
      const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
      return stage.find('.template-image').map(n=>n.width()/n.height());
    });
    expect(images).toHaveLength(2);expect(images[0]).toBeCloseTo(.6);expect(images[1]).toBeCloseTo(600/90);
    await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  }
  const geometry=()=>page.evaluate(()=>{
    const frame=document.querySelector('[data-testid="template-canvas"]')!;
    const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
    return stage.find('.template-element').map(n=>[n.id(),n.x(),n.y(),n.offsetX(),n.offsetY(),n.rotation()]);
  });
  const first=new Map<string,unknown>();
  for(let pass=0;pass<2;pass++)for(const ratio of ['1:1','9:16','16:9','4:5','3:4','1:1']){
    await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
    if(first.has(ratio))expect(await geometry()).toEqual(first.get(ratio));else first.set(ratio,await geometry());
  }
  await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:'9:16',exact:true}).click();
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${theme}-with-product.png`)});
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  const saved=(await stored(page)).templates[0];
  expect(saved.themeId).toBe(theme.toLowerCase());
  expect(saved.canvas.masterAspectRatio).toBe('9:16');
  expect(saved.elements.find((e:{themeRole:string})=>e.themeRole==='headline').style.fontFamily).toBe('Hind');
  await page.reload();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();
  expect((await stored(page)).templates[0]).toEqual(saved);
  await page.locator('.tpl-card').getByRole('button',{name:'Use Template',exact:true}).click();
  await expect(page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:'9:16',exact:true})).toHaveAttribute('aria-pressed','true');
  const headline=page.locator('fieldset.tpl-fields').filter({has:page.locator('legend',{hasText:'Headline'})});
  await headline.locator('textarea').fill('खास बचत\nSpecial savings');
  for(const [name,copy] of [['Offer','FLAT ₹1,500 CASHBACK'],['CTA','Explore today →']])await page.locator('fieldset.tpl-fields').filter({has:page.locator('legend',{hasText:new RegExp(`^${name}`)})}).locator('textarea').fill(copy);
  for(const name of ['PRODUCT / HERO IMAGE','YOUR LOGO']){
    const fields=page.locator('fieldset.tpl-fields').filter({has:page.locator('legend',{hasText:name})});
    await fields.locator('input[type=file]').setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await expect(fields.getByRole('button',{name:'Replace image',exact:true})).toBeVisible();
  }
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  await page.getByTestId('template-canvas').screenshot({path:info.outputPath(`${theme}-hindi-creative.png`)});
  await page.getByRole('button',{name:'Save Creative',exact:true}).click();
  await page.getByRole('button',{name:'Open in editor',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('canvas-dimensions')).toHaveText(/1080 × 1920/);
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  const variant=await page.evaluate(()=>JSON.parse(localStorage.getItem('frameflow:project:v1')!).variants.find((v:{template?:unknown})=>v.template));
  expect(variant.template.themeId).toBe(theme.toLowerCase());
  expect(variant.elements.find((e:{id:string})=>e.id==='theme-headline')).toMatchObject({fontFamily:'Hind',text:'खास बचत\nSpecial savings'});
  expect(variant.layers.length).toBeGreaterThan(5);
  await page.reload();
  await expect(page.getByTestId('canvas-dimensions')).toHaveText(/1080 × 1920/);
  expect(paid).toEqual([]);
});

test('safe theme switching, custom content, failure fallback and no font search downloads',async({page})=>{
  await setup(page);
  await page.getByRole('button',{name:'+ Heading',exact:true}).click();
  await page.locator('.tpl-panel textarea').fill('Keep my copy');
  await page.getByRole('button',{name:'Apply Diwali theme',exact:true}).click();
  await page.getByRole('button',{name:'Cancel theme change',exact:true}).click();
  await expect(page.locator('.tpl-layers li')).toHaveCount(1);
  await page.getByRole('button',{name:'Apply Diwali theme',exact:true}).click();
  await page.getByRole('button',{name:'Apply styling only',exact:true}).click();
  await layer(page,'Heading').click();await expect(page.locator('.tpl-panel textarea')).toHaveValue('Keep my copy');
  for(const name of ['Dhanteras','Holi','Diwali','Dhanteras','Holi']){
    await page.getByRole('button',{name:`Apply ${name} theme`,exact:true}).click();
    await page.getByRole('button',{name:'Apply styling only',exact:true}).click();
    expect(await page.locator('.tpl-layers li').count()).toBeLessThan(32);
  }
  await page.getByRole('button',{name:'Custom / No Theme',exact:true}).click();
  const count=await page.locator('.tpl-layers li').count();
  await page.getByRole('button',{name:'Apply Holi theme',exact:true}).click();
  await page.getByRole('button',{name:'Replace with Holi starter',exact:true}).click();
  expect(await page.locator('.tpl-layers li').count()).toBeGreaterThan(count);
  await layer(page,'Headline').click();
  await page.route('https://fonts.googleapis.com/**',route=>route.abort());
  await page.getByRole('button',{name:'Choose font',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search fonts'}).fill('Mukta');
  await page.getByRole('listitem',{name:'Use font Mukta',exact:true}).click();
  await expect(page.getByText('Some fonts could not load.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await textState(page)).some(t=>t.font.includes('Mukta'))).toBe(true);
});

test('long and short copy, Hindi, CTA wrapping, tall logo and rapid font changes',async({page})=>{
  test.setTimeout(60_000);
  await setup(page);
  await page.getByRole('button',{name:'Apply Holi theme',exact:true}).click();
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  for (const [role,copy] of [['Headline','इस त्योहार खास बचत — Festive savings'],['Offer','FLAT ₹1,500 CASHBACK ON SELECTED PRODUCTS'],['CTA','Shop now\nखरीदें']]) {
    await layer(page,role).click();await page.locator('.tpl-panel textarea').fill(copy);
  }
  for (const ratio of ratios) {
    await page.getByRole('group',{name:'Aspect preview'}).getByRole('button',{name:ratio,exact:true}).click();
    await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
    expect((await textState(page)).every(t=>!t.lines.some(l=>l.endsWith('…')))).toBe(true);
  }
  await layer(page,'Headline').click();await page.locator('.tpl-panel textarea').fill('A');
  await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeEnabled();
  await page.locator('.tpl-panel textarea').fill('Very long offer '.repeat(80));
  await expect(page.getByRole('button',{name:'Save Template',exact:true})).toBeDisabled();
  await expect(page.getByText(/Headline.*needs shorter text/)).toBeVisible();
  await page.locator('.tpl-panel textarea').fill('My campaign');
  // A slower old font must not overwrite a newer selection on completion.
  await page.route('https://fonts.googleapis.com/**family=Fredoka*',async route=>{await new Promise(r=>setTimeout(r,300));await route.abort();});
  for (const font of ['Fredoka','Hind']) {
    await page.getByRole('button',{name:'Choose font',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search fonts'}).fill(font);
    await page.getByRole('listitem',{name:`Use font ${font}`,exact:true}).click();
  }
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  await expect(page.getByRole('button',{name:'Choose font',exact:true})).toContainText('Hind');
  // Square and very wide products preserve aspect just like the tall transparent product above.
  await layer(page,'PRODUCT / HERO IMAGE').click();
  for(const [width,height] of [[300,300],[900,100]]){
    const data=await page.evaluate(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c.toDataURL().split(',')[1];},[width,height]);
    await page.locator('.tpl-panel input[type=file]').setInputFiles({name:'shape.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
    await expect.poll(async()=>page.evaluate(()=>{
      const frame=document.querySelector('[data-testid="template-canvas"]')!;
      const stage=(window as unknown as {Konva:{stages:Stage[]}}).Konva.stages.find(s=>frame.contains(s.container()))!;
      const n=stage.find('.template-image')[0];return n?n.width()/n.height():0;
    })).toBeCloseTo(width/height);
  }
  await layer(page,'YOUR LOGO').click();
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=80;c.height=600;return c.toDataURL().split(',')[1];});
  await page.locator('.tpl-panel input[type=file]').setInputFiles({name:'tall-logo.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  const saved=(await stored(page)).templates[0];
  expect(saved.elements.find((e:{themeRole:string})=>e.themeRole==='logo-slot').behavior.fit).toBe('contain');
});

test('a stalled font times out, removes its stylesheet, and preserves the saved choice on reload',async({page})=>{
  test.setTimeout(40_000);
  const {paid}=await setup(page);
  await page.getByRole('button',{name:'Apply Diwali theme',exact:true}).click();
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  // Leave this CSS request pending: browserFace must enforce its own deadline.
  const stalled='https://fonts.googleapis.com/**family=Mukta*';
  await page.route(stalled,()=>{});
  await layer(page,'Headline').click();
  await page.getByRole('button',{name:'Choose font',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search fonts'}).fill('Mukta');
  await page.getByRole('listitem',{name:'Use font Mukta',exact:true}).click();
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','failed',{timeout:12_000});
  await expect(page.locator('link[data-frameflow-font="Mukta"]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Choose font',exact:true})).toContainText('Mukta');
  await page.getByRole('button',{name:'Save Template',exact:true}).click();
  await page.reload();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();
  await page.locator('.tpl-card').getByRole('button',{name:'Edit Template',exact:true}).click();
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','failed',{timeout:12_000});
  await layer(page,'Headline').click();
  await expect(page.getByRole('button',{name:'Choose font',exact:true})).toContainText('Mukta');
  expect((await stored(page)).templates[0].elements.find((e:{themeRole:string})=>e.themeRole==='headline').style.fontFamily).toBe('Mukta');
  await page.unroute(stalled);
  await page.reload();
  await page.locator('.decomp-launch',{hasText:'Create Own Template'}).click();
  await page.locator('.tpl-card').getByRole('button',{name:'Edit Template',exact:true}).click();
  await expect(page.locator('.tpl-main')).toHaveAttribute('data-fonts-state','ready');
  await expect.poll(async()=>page.evaluate(()=>document.fonts.check('400 24px "Mukta"'))).toBe(true);
  expect((await textState(page)).some(t=>t.font.includes('Mukta'))).toBe(true);
  expect(paid).toEqual([]);
});
