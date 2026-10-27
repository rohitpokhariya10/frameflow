/** Local reference audit only. Handmade detections never stand in for model output. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { detectProduct } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { prepareProduct } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { parseProductScene } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { decodeRgba, sha256 } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { loadGaneshHandmade } from './privateHandmade.js';
// Needs the client's private reference files (kept out of the repository).
const handmade = await loadGaneshHandmade();
if (!handmade) throw new Error('The visual audit needs the private reference files (Ganesh-Chaturthi.png and tests/fixtures/ganeshHandmade.fixture.ts).');
const { ganeshWordManifest } = handmade;
const out = process.argv[2] ?? 'test-results/product-v3/after';
mkdirSync(out,{recursive:true});
const save = (f: string,v: object) => writeFileSync(join(out,f),JSON.stringify(v,null,2));
const original = readFileSync('Ganesh-Chaturthi.png'), sheet = await decodeRgba(original), b = findSheetCreatives(sheet).boxes[0];
const png = await sharp(original).extract({left:b.x,top:b.y,width:b.width,height:b.height}).png().toBuffer(), source = await decodeRgba(png);
writeFileSync(join(out,'original.png'),png);
const detected = await detectProduct({ source, png, template: {id:'pt-000000000001',source:{file:'original.png',inputFile:'original.png',sha256:sha256(png),mime:'image/png',width:source.width,height:source.height,bytes:png.length,orientationNormalized:false,origin:{kind:'upload'}}},
  recognizer:{engine:{name:'offline-disabled',version:'1',model:'none',modes:[]},recognize:async()=>{throw new Error('OCR forbidden in this visual manifest fixture');}},
  analyzer:{model:'offline-handmade-visual-audit',analyze:async()=>parseProductScene(ganeshWordManifest(source),source)},
  store:(f,p)=>writeFileSync(join(out,f),p),save,at:'2026-10-22T12:00:00Z' });
for(const o of detected.objects) o.review={status:'accepted',by:'user'};
save('detection.json',detected);
const r=await prepareProduct({source,analysis:detected.analysis,objects:detected.objects,paidApproved:false,save});
for(const [f,data] of Object.entries({clean:r.clean,background:r.base,reconstructed:r.recombined,'recombined-clean':r.recombinedClean,'word-logo-overlays':r.overlays,'removal-mask':r.overlayMask})) writeFileSync(join(out,`${f}.png`),data);
save('quality.json',r.quality);
const evidence=[];
for(const cut of r.cutouts){
 const object=detected.objects.find(o=>o.id===cut.id)!, file=`cutout-${object.kind}-${object.id}.png`;
 writeFileSync(join(out,file),cut.png);
 for(const mode of ['hidden','moved'] as const){
  const layers=r.cutouts.filter(c=> mode==='hidden'?c.id!==cut.id:true).map(c=>({input:c.png,left:c.placement.x+(mode==='moved'&&c.id===cut.id?Math.min(35,source.width-c.placement.x-c.placement.width):0),top:c.placement.y}));
  layers.push({input:r.overlays,left:0,top:0});
  writeFileSync(join(out,`${mode}-${object.id}.png`),await sharp(r.base).composite(layers).png().toBuffer());
 }
 evidence.push({id:object.id,label:object.label,kind:object.kind,file,box:object.box,placement:cut.placement,coverage:cut.coverage,note:cut.note});
}
save('objects.json',evidence);
console.log(JSON.stringify({out,objects:evidence.length,quality:r.quality.clean,fixture:'handmade; no model or OCR calls'}));
