import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { sha256 } from './phases/source.js';
import { extractVisibleLayers } from './phases/extract.js';
import { decodeRgba } from './image/extract.js';
import { decodeMask, mapMaskToNative, cropMask, encodeMask, overlapMasks } from './image/masks.js';
import type { ImageTransform } from './image/coordinates.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'artifacts/decomposition/offline-demo');
const summary = JSON.parse(await readFile(resolve(root, '05-refined/summary.json'), 'utf8')) as { verificationMode: string; objects: {id:string;label:string;maskArtifactId:string;alphaArtifactId:string;maskSha256:string;alphaSha256:string;coordinateSpace:string;transform:ImageTransform;warnings:string[]}[] };
const metadata = JSON.parse(await readFile(resolve(root, 'metadata.json'), 'utf8')) as {source:{workingMasterSha256:string};artifacts:{artifactId:string;relativePath:string;sha256:string}[]};
if (summary.verificationMode !== 'mock') throw new Error('This command accepts only the existing explicitly mock demo.');
const master = await readFile(resolve(root, '01-original/working-master.png'));
if (sha256(master) !== metadata.source.workingMasterSha256) throw new Error('Working master hash mismatch');
const source = await decodeRgba(master);
async function maskFile(id:string, hash:string, coordinateSpace:string, transform:ImageTransform, binary:boolean) {
  const ref = metadata.artifacts.find(a=>a.artifactId===id);
  if (!ref || !/^05-refined\/[a-zA-Z0-9_.-]+\.png$/.test(ref.relativePath)) throw new Error('Invalid refinement artifact');
  const bytes=await readFile(resolve(root,ref.relativePath));
  if(sha256(bytes)!==hash || ref.sha256!==hash)throw new Error('Refinement hash mismatch');
  const decoded=await decodeMask(bytes,{encoding:'luminance',binary});
  if(coordinateSpace==='working-master-pixels') {
    if(decoded.width!==source.width||decoded.height!==source.height)throw new Error('Native mask size mismatch');
    return decoded; // Phase 5 already unpadded/mapped this mask. Never apply its crop twice.
  }
  if(coordinateSpace!=='model-pixels')throw new Error('Unknown mask coordinate space');
  return mapMaskToNative(decoded,transform,binary?'binary':'alpha');
}
const objects=[];
for(const item of summary.objects){
  if(!['person','board'].includes(item.label))throw new Error('Unexpected offline fixture target');
  objects.push({...item,ownership:await maskFile(item.maskArtifactId,item.maskSha256,item.coordinateSpace,item.transform,true),alpha:await maskFile(item.alphaArtifactId,item.alphaSha256,item.coordinateSpace,item.transform,false)});
}
const person=objects.find(o=>o.label==='person')!,board=objects.find(o=>o.label==='board')!;
if(!person||!board||overlapMasks(board.alpha,person.ownership).intersection)throw new Error('Board overlaps person ownership');
const result=await extractVisibleLayers(master,objects.map(o=>({id:o.id,label:o.label,mask:o.alpha})));
const out=resolve(root,'06-extracted');await mkdir(out,{recursive:true});
const records=[];let opaquePixelsChecked=0;
for(const layer of [...result.layers,...(result.residual?[result.residual]:[])]){
  const name=layer.id==='residual'?'residual':objects.find(o=>o.id===layer.id)!.label;
  const original=objects.find(o=>o.id===layer.id);
  const raw=await decodeRgba(layer.rgba);
  for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++){
    const i=(y*raw.width+x)*4, s=((y+layer.bbox.y)*source.width+x+layer.bbox.x)*4;
    if(raw.data[i+3]===255){opaquePixelsChecked++;if(!raw.data.subarray(i,i+3).equals(source.data.subarray(s,s+3)))throw new Error('Opaque source RGB fidelity failed');}
  }
  await writeFile(resolve(out,`${name}.png`),layer.rgba);
  await writeFile(resolve(out,`${name}-alpha.png`),layer.alpha);
  if(original)await writeFile(resolve(out,`${name}-visible.png`),await encodeMask(cropMask(original.ownership,layer.bbox)));
  for(const [surface,color] of [['white','#ffffff'],['dark','#18202c']]) await writeFile(resolve(out,`${name}-on-${surface}.png`),await sharp(layer.rgba).flatten({background:color}).png().toBuffer());
  records.push({objectId:layer.id,label:name,nativeCanvas:{width:source.width,height:source.height},bbox:layer.bbox,png:{width:raw.width,height:raw.height,path:`${name}.png`,sha256:sha256(layer.rgba)},alphaMode:'straight',workingMasterSha256:sha256(master),rgbProvenance:'original working-master RGB; no provider RGB',refinement:original?{maskArtifactId:original.maskArtifactId,alphaArtifactId:original.alphaArtifactId,transform:original.transform,inputCoordinateSpace:original.coordinateSpace,warnings:original.warnings}:null});
}
await writeFile(resolve(out,'metadata.json'),JSON.stringify({phase:6,providerMode:'mock',liveVerified:false,review:'User-requested diagnostic extraction; phase-5 soft-edge review remains pending',opaquePixelsChecked,opaqueRgbMismatches:0,boardPersonOverlap:0,coverage:result.coverage,objects:records},null,2));
const section=`<section id="phase6"><h2>06 · Original RGB extraction (MOCK segmentation)</h2><p>PNG files have real straight alpha. Soft edges retain source background color and remain subject to visual review. All ${opaquePixelsChecked} opaque pixels matched the working master.</p>${['person','board'].map(name=>`<h3>${name}</h3><div class="row">${[`${name}.png`,`${name}-alpha.png`,`${name}-on-white.png`,`${name}-on-dark.png`].map(file=>`<figure><a href="06-extracted/${file}"><img src="06-extracted/${file}" alt="${file}"></a><figcaption>${file}</figcaption></figure>`).join('')}</div>`).join('')}<a href="06-extracted/metadata.json">Placement, fidelity and provenance</a></section>`;
let html=await readFile(resolve(root,'index.html'),'utf8');html=html.replace(/<section id="phase6">[\s\S]*?<\/section>/,'').replace('</main>',section+'</main>');await writeFile(resolve(root,'index.html'),html);
console.info(JSON.stringify({phase:6,providerMode:'mock',output:out,opaquePixelsChecked,opaqueRgbMismatches:0,boardPersonOverlap:0},null,2));
