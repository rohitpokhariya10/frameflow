import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { CreativeInstance, MasterAiBatch, MasterAiEstimate } from '@frameflow/shared';
import type { MasterView } from '../../client/src/features/masterTemplates/api';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout:30000 });
test.describe.configure({timeout:240000});
const API='/api/layerize-experiment/master-templates';
async function open(page:Page) {
  await page.route(url=>/^https?:$/.test(url.protocol)&&url.hostname!=='127.0.0.1',r=>r.abort());
  await page.goto('/');
  await page.getByRole('button',{name:'OpenAI + Seedream test'}).click();
  const panel=page.getByRole('dialog',{name:'OpenAI + Seedream test'});
  await panel.getByRole('tab',{name:'Offer Templates',exact:true}).click();
  return panel;
}
async function prepare(request:APIRequestContext,name:string) {
  const source=await (await request.get('/__test__/master-poster.png')).body();
  const created=await request.post(API,{multipart:{name,image:{name:'poster.png',mimeType:'image/png',buffer:source}}});
  expect(created.ok()).toBe(true);
  let v=await created.json() as MasterView;const id=v.template.id;
  await expect.poll(async()=>{v=await (await request.get(`${API}/${id}`)).json();return v.stage;},{timeout:120000}).not.toBe('scanning');
  for(const action of ['review/approve-all','prepare','background/approve','publish']){
    const r=await request.post(`${API}/${id}/${action}`,{data:{expectedRevision:v.template.revision,includeUncertain:true,acknowledgeEstimate:true}});
    expect(r.ok(),await r.text()).toBe(true);v=await r.json();
  }
  return {id,v};
}
for(const count of [3,4,5] as const) test(`${count} mocked AI creatives: generate, edit, reload, Konva save and exact-size export`,async({page,request},info)=>{
  const name=`AI ${count} ${info.project.name} ${Date.now()}`,{id,v:before}=await prepare(request,name);
  const original=JSON.stringify(before.template);
  const panel=await open(page),card=panel.getByRole('article',{name:`Template ${name}`,exact:true});
  await expect(card.getByRole('button',{name:'Reuse Template',exact:true})).toBeVisible();
  // The existing manual path creates an ordinary creative; AI must not change it later.
  await card.getByRole('button',{name:'Reuse Template',exact:true}).click();
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  const manual=(await (await request.get(`${API}/${id}/creatives`)).json()).creatives[0];
  const manualBefore=await (await request.get(`${API}/${id}/creatives/${manual.id}`)).json();
  await panel.getByRole('button',{name:'Templates',exact:true}).click();
  await panel.getByRole('article',{name:`Template ${name}`,exact:true}).getByRole('button',{name:'Generate AI Variations',exact:true}).click();
  await panel.getByLabel('Number of variations').selectOption(String(count));
  // 3: the template's own size (the default); 4 and 5: standard formats.
  const formatId=count===3?'master':count===4?'story-9-16':'landscape-16-9',size=count===3?[before.template.source.width,before.template.source.height]:count===4?[1080,1920]:[1920,1080];
  await expect(panel.getByLabel('Aspect ratio')).toHaveValue('master');
  await panel.getByLabel('Aspect ratio').selectOption(formatId);
  await panel.getByLabel('Creative direction').fill('Distinct hierarchy and colours');
  if(count===3){await page.setViewportSize({width:390,height:844});expect(await panel.locator('.ws-body').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);}
  const estimation=page.waitForResponse(r=>r.url().endsWith(`/master-creatives/${id}/estimate`));
  await panel.getByRole('button',{name:'Check generation cost'}).click();
  const est=await (await estimation).json() as MasterAiEstimate;expect(est.configured&&est.withinCap).toBe(true);expect(est.provider).toBe('offline-mock');
  await expect(panel.getByText(/Test mode: this server uses FrameFlow’s built-in test designer, not real AI/)).toBeVisible();
  await expect(panel.getByRole('button',{name:`Generate ${count} editable creatives`})).toBeEnabled();
  await panel.screenshot({path:info.outputPath('ai-setup.png')});
  const queued=page.waitForResponse(r=>r.url().endsWith(`/master-creatives/${id}`)&&r.request().method()==='POST');
  await panel.getByRole('button',{name:`Generate ${count} editable creatives`}).click();
  const batch=await (await queued).json() as MasterAiBatch;
  const batchCard=panel.getByRole('region',{name:`AI batch ${batch.job.id}`});
  await expect(batchCard.getByRole('article')).toHaveCount(count,{timeout:120000});
  await expect(batchCard).toContainText('Saved to this template');
  await expect(batchCard.getByRole('heading',{name:new RegExp(`^${count} of ${count} creatives ready`)})).toBeVisible();
  await expect(batchCard).toContainText('no charge (test mode)');
  expect(await panel.locator('.ws-body').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  await batchCard.screenshot({path:info.outputPath('ai-results.png')});
  for(let i=0;i<count;i++){
    const tile=batchCard.getByRole('article').nth(i);
    await tile.scrollIntoViewIfNeeded();
    await tile.screenshot({path:info.outputPath(`ai-option-${i+1}.png`)});
  }
  const result=(await (await request.get(`/api/template-studio/master-creatives/${id}`)).json()).batches.find((b:MasterAiBatch)=>b.job.id===batch.job.id) as MasterAiBatch;
  expect(result.creatives).toHaveLength(count);
  const cid=result.creatives[0].id;
  let creative=await (await request.get(`${API}/${id}/creatives/${cid}`)).json() as CreativeInstance;
  expect([creative.canvas.width,creative.canvas.height]).toEqual(size);expect(creative.generation!.provider).toBe('offline-mock');
  const designCalls=async()=>(await (await request.get('/__test__/studio-calls')).json() as {schemaName?:string;masterId?:string}[]).filter(c=>c.schemaName==='editable_offer_style_variations'&&c.masterId===id).length;
  expect(await designCalls()).toBe(1);
  const recipe=await (await request.get(`/api/layerize-experiment/protected-templates/${id}/files/${creative.generation!.recipeFile}`)).json();
  expect(recipe.version).toBe(4);expect(recipe.provider).toBe('offline-mock');
  // A style variation keeps the master's structure: at its own size every logo at its saved box, the artwork whole and locked.
  if(formatId==='master'){
    const snap=await (await request.get(`${API}/${id}/revisions/1`)).json() as {logoSlots:{id:string;box:{x:number;y:number;width:number;height:number}}[]};
    for(const slot of snap.logoSlots) { const im=creative.images.find(i=>i.slotId===slot.id); if(im) expect([im.box.x,im.box.y,im.box.width,im.box.height]).toEqual([slot.box.x,slot.box.y,slot.box.width,slot.box.height]); }
    const art=creative.images.find(i=>i.artwork)!;expect(art.locked).toBe(true);expect([art.box.x,art.box.y,art.box.width,art.box.height]).toEqual([0,0,size[0],size[1]]);
  }expect(recipe.input.options.count).toBe(count);expect(recipe.plan.variations).toHaveLength(count);expect(recipe.usage).toHaveLength(1);
  expect(recipe.input.request.system).toContain('editable');
  const option=batchCard.getByRole('article',{name:`AI creative ${result.creatives[0].name}`,exact:true});
  await option.getByRole('button',{name:'Preview',exact:true}).click();
  // The preview shows the template beside the variation.
  const dialog=page.getByRole('dialog',{name:'AI creative preview'});
  await expect(dialog.getByRole('img',{name:'Your template'})).toBeVisible();
  await expect(dialog.getByRole('img',{name:`${result.creatives[0].name} at full size`})).toBeVisible();
  await page.getByRole('button',{name:'Close preview'}).click();
  await option.getByRole('button',{name:'Open creative',exact:true}).click();
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  await page.setViewportSize({width:1440,height:900});
  const word=creative.texts[0],wordName=`Changed${count}`;
  await panel.getByLabel(`Word “${word.text}”`,{exact:true}).first().fill(wordName);
  await expect(panel.getByTestId('creative-save-state')).toHaveText(/Saved · revision 2/);
  const logoImage=creative.images.find(i=>!i.artwork)!,logoIndex=creative.images.indexOf(logoImage),label=logoImage.label;
  await panel.getByLabel(`Replace ${label}`,{exact:true}).setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:await (await request.get('/__test__/master-logo.png')).body()});
  await expect(panel.getByText(`${label} · replaced`,{exact:false})).toBeVisible();
  await expect(panel.getByTestId('creative-save-state')).toHaveText(/Saved · revision 3/);
  const logo=panel.getByTestId('logo-slot').filter({has:page.getByRole('img',{name:label,exact:true})});
  await logo.getByRole('button').first().click();
  await logo.getByText('Position and size (source pixels)',{exact:true}).click();
  const movedX=Math.round(logoImage.box.x)+9,resizedW=Math.round(logoImage.box.width)-4;
  await logo.getByLabel('X',{exact:true}).fill(String(movedX));
  await logo.getByLabel('W',{exact:true}).fill(String(resizedW));
  await expect.poll(async()=>{const c=await (await request.get(`${API}/${id}/creatives/${cid}`)).json();return [c.images[logoIndex].box.x,c.images[logoIndex].box.width];}).toEqual([movedX,resizedW]);
  await panel.getByRole('button',{name:'Open in Editor'}).click();
  await expect(page.getByRole('button',{name:'Save creative'})).toBeVisible();
  await page.getByRole('tab',{name:'Text',exact:true}).click();
  await page.getByRole('button',{name:new RegExp(wordName)}).first().click();
  await page.getByLabel('Font family',{exact:true}).selectOption('Lora');
  await page.getByRole('button',{name:'Save creative'}).click();
  await expect(page.getByText(/Saved to creative · revision/)).toBeVisible();
  creative=await (await request.get(`${API}/${id}/creatives/${cid}`)).json();
  expect(creative.texts.find(t=>t.text===wordName)!.style.fontFamily).toBe('Lora');
  expect(creative.images[logoIndex].asset.kind).toBe('creative');expect(creative.images[logoIndex].asset.file).toMatch(/^cra-/);
  expect([creative.images[logoIndex].box.x,creative.images[logoIndex].box.width]).toEqual([movedX,resizedW]);
  // Editing text, fonts and logos, saving and exporting made no AI request.
  expect(await designCalls()).toBe(1);
  await page.screenshot({path:info.outputPath('ai-editor.png')});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export PNG',exact:true}).click();
  const file=await (await download).path();expect(await sharp(file!).metadata().then(m=>[m.width,m.height])).toEqual(size);
  await page.reload();const reopened=await open(page);
  const savedCard=reopened.getByRole('article',{name:`Template ${name}`,exact:true});
  await savedCard.getByRole('button',{name:'Creatives',exact:true}).click();
  await savedCard.getByRole('button',{name:new RegExp(creative.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();
  await expect(reopened.getByLabel(`Word “${wordName}”`,{exact:true})).toBeVisible();
  const after=await (await request.get(`${API}/${id}/creatives/${cid}`)).json() as CreativeInstance;
  expect(after.texts).toEqual(creative.texts);expect(after.images).toEqual(creative.images);expect(after.generation).toEqual(creative.generation);
  const masterAfter=await (await request.get(`${API}/${id}`)).json();
  expect(JSON.stringify(masterAfter.template)).toBe(original);expect(masterAfter.activity).toEqual(before.activity);
  expect(await (await request.get(`${API}/${id}/creatives/${manual.id}`)).json()).toEqual(manualBefore);
  const jobs=(await (await request.get(`/api/template-studio/master-creatives/${id}`)).json()).batches;
  expect(jobs).toHaveLength(1);expect(jobs[0].job.cost).toEqual(result.job.cost);
});
