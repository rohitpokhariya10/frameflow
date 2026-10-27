/**
 * The live preview of a creative: the master's saved artwork, then every plate, picture and word as its own Konva node at
 * its saved coordinates (source pixels, scaled to fit). Words are drawn exactly as the editor draws them: same font files,
 * same Konva text, top computed from the saved baseline with the drawn font's metrics. Select a node to edit it in the
 * panel; drag it to move it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva/lib/ReactKonvaCore';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import type { Group as KonvaGroup } from 'konva/lib/Group';
import 'konva/lib/shapes/Image';
import 'konva/lib/shapes/Rect';
import 'konva/lib/shapes/Text';
import 'konva/lib/shapes/Transformer';
import { centreRotationToOrigin, imageFit, type CreativeInstance, type MasterSnapshot } from '@frameflow/shared';
import { masterFileUrl } from './api';
import { baselineOffset, konvaFamily, measureAdvance } from './creativeText';

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) { p = new Promise((resolve, reject) => { const img = new window.Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(`Could not load ${url}`)); img.src = url; }); images.set(url, p); p.catch(() => images.delete(url)); }
  return p;
}
function useImages(urls: string[]) {
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  const key = urls.join('|');
  useEffect(() => {
    let live = true;
    for (const url of key.split('|').filter(Boolean)) void loadImage(url).then(img => { if (live) setLoaded(prev => prev[url] === img ? prev : { ...prev, [url]: img }); }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  return loaded;
}

export type Selected = { kind: 'text' | 'image' | 'shape' | 'object'; id: string } | null;
/** A Product with Text creative's object (a character, product or decoration): its own picture at its box, below every text. */
export type CanvasObject = { id: string; url: string; box: { x: number; y: number; width: number; height: number; rotation?: number }; z: number; label: string; opacity?: number; locked?: boolean };
export function CreativeCanvas({ snapshot, creative, fontsRevision, width, selected, onSelect, onMove, onResize, objects, absoluteZOrder, backgroundZ, canvasFill }: {
  snapshot: MasterSnapshot; creative: CreativeInstance; fontsRevision: number; width: number;
  selected: Selected; onSelect: (s: Selected) => void; onMove: (s: NonNullable<Selected>, dx: number, dy: number) => void;
  /** Optional: corner handles on the selected object, resizing it proportionally (its new box, source pixels). */
  onResize?: (s: NonNullable<Selected>, box: { x: number; y: number; width: number; height: number }) => void;
  objects?: CanvasObject[]; absoluteZOrder?: boolean; backgroundZ?: number; canvasFill?: { color: string; transparent: boolean };
}) {
  const id = snapshot.masterId, s = width / creative.canvas.width, height = creative.canvas.height * s;
  const art = useMemo(() => (creative.backgroundColor ? [] : snapshot.layers.length ? snapshot.layers.map(l => ({ key: l.id, url: masterFileUrl(id, l.file), x: l.x, y: l.y, w: l.width, h: l.height, z: l.zIndex })) : [{ key: 'background', url: masterFileUrl(id, snapshot.background.file), x: 0, y: 0, w: snapshot.canvas.width, h: snapshot.canvas.height, z: 0 }]),
    [creative.backgroundColor, snapshot, id]);
  const pictureUrls = creative.images.map(i => masterFileUrl(id, i.asset.file));
  const loaded = useImages([...art.map(a => a.url), ...pictureUrls, ...(objects ?? []).map(o => o.url)]);
  const stage = useRef<import('konva/lib/Stage').Stage>(null), groups = useRef(new Map<string, KonvaGroup>()), handles = useRef<KonvaTransformer>(null);
  const selectedObject = selected?.kind === 'object' ? (objects ?? []).find(o => o.id === selected.id && !o.locked && !o.box.rotation) : undefined;
  useEffect(() => {
    const t = handles.current; if (!t) return;
    const node = selectedObject ? groups.current.get(selectedObject.id) : undefined;
    t.nodes(node ? [node] : []); t.getLayer()?.batchDraw();
  });
  // Every element, back to front by its z (plates, logos and words share one order).
  const nodes = useMemo(() => {
    void fontsRevision;
    const lift = absoluteZOrder ? 0 : Math.max(-1, ...(objects ?? []).map(o => o.z)) + 1;
    return [
      ...art.map(a => ({ kind: 'art' as const, id: a.key, z: (backgroundZ ?? -100000) + a.z, a })),
      ...(objects ?? []).map(o => ({ kind: 'object' as const, id: o.id, z: o.z, o })),
      ...creative.shapes.filter(sh => !sh.hidden).map(sh => ({ kind: 'shape' as const, id: sh.id, z: sh.z + lift, sh })),
      ...creative.images.filter(i => !i.hidden).map(i => ({ kind: 'image' as const, id: i.id, z: i.z + lift, i })),
      ...creative.texts.filter(t => !t.hidden && t.text).map(t => {
        const offset = baselineOffset(t.style, t.style.fontSize, 1), angle = t.rotation * Math.PI / 180;
        return { kind: 'text' as const, id: t.id, z: t.z + lift, t, left: t.x + offset * Math.sin(angle), top: t.baselineY - offset * Math.cos(angle) };
      }),
    ].sort((a, b) => a.z - b.z);
  }, [creative, fontsRevision, objects, absoluteZOrder, art, backgroundZ]);
  const isSel = (kind: string, nid: string) => selected?.kind === kind && selected.id === nid;
  const dragEnd = (sel: NonNullable<Selected>) => (e: { target: { x(): number; y(): number; position(p: { x: number; y: number }): void } }, ox: number, oy: number) => {
    const dx = e.target.x() - ox, dy = e.target.y() - oy;
    e.target.position({ x: ox, y: oy });
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) onMove(sel, dx, dy);
  };
  return <div className="ot-poster" data-testid="creative-preview" style={{ maxWidth: width }}>
    <Stage ref={stage} width={width} height={height} style={{ borderRadius: 6, boxShadow: '0 2px 10px rgba(20,30,25,.12)', background: '#fff' }} onMouseDown={e => { if (e.target === e.target.getStage()) onSelect(null); }}>
      <Layer>
        <Group scaleX={s} scaleY={s}>
          {creative.backgroundColor && <Rect width={creative.canvas.width} height={creative.canvas.height} fill={creative.backgroundColor} listening={false} />}
          {canvasFill && !canvasFill.transparent && <Rect width={creative.canvas.width} height={creative.canvas.height} fill={canvasFill.color} listening={false} />}
          {nodes.map(n => {
            if (n.kind === 'art') {
              const a = n.a;
              return loaded[a.url] ? <KonvaImage key={`art-${a.key}`} image={loaded[a.url]} x={a.x} y={a.y} width={a.w} height={a.h} listening={false} /> : null;
            }
            if (n.kind === 'object') {
              const o = n.o, origin = centreRotationToOrigin({ ...o.box, rotation: o.box.rotation ?? 0 });
              return <Group key={o.id} ref={node => { if (node) groups.current.set(o.id, node); else groups.current.delete(o.id); }} x={origin.x} y={origin.y} rotation={o.box.rotation ?? 0} opacity={o.opacity ?? 1} draggable={!o.locked} onMouseDown={() => onSelect({ kind: 'object', id: o.id })} onTouchStart={() => onSelect({ kind: 'object', id: o.id })} onDragEnd={e => dragEnd({ kind: 'object', id: o.id })(e, origin.x, origin.y)}
                onTransformEnd={e => { const node = e.target, k = node.scaleX(); node.scaleX(1); node.scaleY(1); onResize?.({ kind: 'object', id: o.id }, { x: node.x(), y: node.y(), width: o.box.width * k, height: o.box.height * k }); }}>
                {loaded[o.url] ? <KonvaImage image={loaded[o.url]} width={o.box.width} height={o.box.height} /> : <Rect width={o.box.width} height={o.box.height} fill="rgba(0,0,0,0)" />}
                {isSel('object', o.id) && <Rect width={o.box.width} height={o.box.height} stroke="#ca8a04" strokeWidth={3 / s} dash={[8 / s, 6 / s]} listening={false} />}
              </Group>;
            }
            if (n.kind === 'shape') {
              const b = n.sh.box, o = centreRotationToOrigin(b);
              return <Group key={n.id} x={o.x} y={o.y} rotation={b.rotation} draggable onMouseDown={() => onSelect({ kind: 'shape', id: n.id })} onDragEnd={e => dragEnd({ kind: 'shape', id: n.id })(e, o.x, o.y)}>
                <Rect width={b.width} height={b.height} cornerRadius={Math.min(n.sh.radius, b.width / 2, b.height / 2)} fill={n.sh.fill} {...(n.sh.stroke ? { stroke: n.sh.stroke.color, strokeWidth: n.sh.stroke.width } : {})} />
                {isSel('shape', n.id) && <Rect width={b.width} height={b.height} stroke="#ca8a04" strokeWidth={3 / s} dash={[8 / s, 6 / s]} listening={false} />}
              </Group>;
            }
            if (n.kind === 'image') {
              const b = n.i.box, o = centreRotationToOrigin(b), img = loaded[masterFileUrl(id, n.i.asset.file)];
              const fit = img ? imageFit({ width: img.naturalWidth, height: img.naturalHeight }, { width: b.width, height: b.height }, 'contain', 0.5, 0.5) : undefined;
              return <Group key={n.id} x={o.x} y={o.y} rotation={b.rotation} draggable={!n.i.locked} onMouseDown={() => onSelect({ kind: 'image', id: n.id })} onDragEnd={e => dragEnd({ kind: 'image', id: n.id })(e, o.x, o.y)}>
                <Rect width={b.width} height={b.height} fill="rgba(0,0,0,0)" />
                {img && fit && <KonvaImage image={img} {...fit.dest} crop={fit.crop} />}
                {isSel('image', n.id) && <Rect width={b.width} height={b.height} stroke="#ca8a04" strokeWidth={3 / s} dash={[8 / s, 6 / s]} listening={false} />}
              </Group>;
            }
            const t = n.t;
            return <Group key={`${n.id}-${fontsRevision}`} x={n.left} y={n.top} rotation={t.rotation} draggable={!t.locked} onMouseDown={() => onSelect({ kind: 'text', id: n.id })} onDragEnd={e => dragEnd({ kind: 'text', id: n.id })(e, n.left, n.top)}>
              <Text name="creative-text" text={t.text} fontFamily={konvaFamily(t.style.fontFamily)} fontStyle={`${t.style.fontStyle === 'italic' ? 'italic ' : ''}${t.style.fontWeight}`} fontSize={t.style.fontSize}
                fill={t.style.color} opacity={t.style.opacity} letterSpacing={t.style.letterSpacing} lineHeight={1} wrap="none" />
              {isSel('text', n.id) && <Rect y={0} width={Math.max(4, measureAdvance(t.text, t.style))} height={t.style.fontSize} stroke="#ca8a04" strokeWidth={3 / s} dash={[8 / s, 6 / s]} listening={false} />}
            </Group>;
          })}
        </Group>
        {onResize && <Transformer ref={handles} keepRatio rotateEnabled={false} flipEnabled={false} enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']} anchorSize={12} borderStroke="#ca8a04" anchorStroke="#ca8a04"
          boundBoxFunc={(old, next) => (next.width < 12 || next.height < 12 ? old : next)} />}
      </Layer>
    </Stage>
  </div>;
}
