import type { Rgba } from '../pixels.js';
import type { PixelBox } from '../../../textRecognition/measure.js';
/** Product-only ink measurement. Long rules in a badge are artwork, not letter height. */
export function productInkBounds(source: Rgba, box: PixelBox, color: string): PixelBox {
  const x0=Math.max(0,Math.floor(box.x)), y0=Math.max(0,Math.floor(box.y)), x1=Math.min(source.width,Math.ceil(box.x+box.width)), y1=Math.min(source.height,Math.ceil(box.y+box.height));
  const c=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)), W=x1-x0,H=y1-y0,m=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) { const i=((y+y0)*source.width+x+x0)*4; if(Math.max(...c.map((v,k)=>Math.abs(source.data[i+k]-v)))<65)m[y*W+x]=1; }
  if(W>20)for(let y=0;y<H;y++) { let count=0;for(let x=0;x<W;x++)count+=m[y*W+x];if(count>W*0.85)m.fill(0,y*W,(y+1)*W); }
  let left=W,right=-1,top=H,bottom=-1;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(m[y*W+x]) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return right>=left&&bottom>=top?{x:x0+left,y:y0+top,width:right-left+1,height:bottom-top+1}:box;
}
