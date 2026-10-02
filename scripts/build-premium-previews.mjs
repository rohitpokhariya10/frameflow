/** Build production gallery thumbnails from reviewed, real Konva renders (never source posters).
 * Run the premium visual browser tests first, then:
 * node scripts/build-premium-previews.mjs test-results/premium-final
 */
import { readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
const input=process.argv[2];
if(!input)throw new Error('Provide the reviewed Playwright output directory.');
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]))).flat();}
const images=await files(resolve(input));
const output=resolve('client/public/assets/diwali-premium/previews');
const ids=['jewellery','ecommerce','greeting','lantern','event','gift'];
const sources=ids.map(id=>{
 const matches=images.filter(file=>file.endsWith(`/premium-${id}-1x1-render.png`));
 if(matches.length!==1)throw new Error(`Expected one reviewed square render for ${id}, received ${matches.length}. Use one browser project.`);
 return matches[0];
});
await mkdir(output,{recursive:true});
for(let i=0;i<ids.length;i++)await sharp(sources[i]).resize(420,420).webp({quality:84}).toFile(join(output,`premium-${ids[i]}.webp`));
console.info('Created six thumbnails from actual editable-canvas renders.');
