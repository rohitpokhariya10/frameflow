import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Package, Paintbrush, RotateCcw, Sparkles, User, X } from 'lucide-react';
import { autoResolve, editStrategy, holderOf, isForeground, needsResolver, type ObjectEdit, type SceneBox, type SceneDescription, type SceneDraft, type ScenePropertyKey } from '@frameflow/shared';

/**
 * Feature 2's simple customization: one optional field per thing in THIS image (from its saved analysis), grouped as a
 * person thinks of them, each with a thumbnail cropped from the reference image in the browser (no request). A typed
 * field becomes the draft edit of its objects; everything else (brands, related products, staging) is decided by the AI
 * when Generate Creative is clicked.
 */
export interface CustomizeField {
  id: string; group: 'products' | 'people' | 'scene'; title: string; detail: string; objectIds: string[];
  box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>; action: 'replace' | 'modify'; property?: ScenePropertyKey; placeholder: string; brand?: boolean;
}
const union = (boxes: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>[]) => {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
const words = (t: string) => t ? t[0].toUpperCase() + t.slice(1) : t;
/** The fields this image offers: its products (left to right), its people, then the scene. Logos and text are handled automatically. */
export function customizeFields(scene: SceneDescription): CustomizeField[] {
  const live = scene.objects.filter(o => !o.ignored);
  const worn = new Set(scene.relations.filter(r => r.relation === 'wears').map(r => r.target));
  const partOf = (id: string) => scene.relations.some(r => (r.relation === 'part_of' || r.relation === 'attached_to') && r.source === id && live.some(o => o.id === r.target && (o.kind === 'product' || o.kind === 'object')) && !holderOf(scene, id));
  const advertised = new Set([...scene.mainCandidates, ...((scene as SceneDescription & { advertised?: string[] }).advertised ?? [])]);
  const isProduct = (o: SceneDescription['objects'][number]) => isForeground(o) && !worn.has(o.id) && !partOf(o.id) && (o.kind === 'product' || (o.kind === 'object' && (o.importance === 'main' || advertised.has(o.id) || !!holderOf(scene, o.id))));
  const products = live.filter(isProduct).sort((a, b) => a.box.x - b.box.x);
  const people = live.filter(o => o.kind === 'person' || o.kind === 'character' || o.kind === 'animal').sort((a, b) => a.box.x - b.box.x);
  const out: CustomizeField[] = products.map((o, i) => ({ id: `product:${o.id}`, group: 'products', title: products.length > 1 ? `Product ${i + 1}` : 'Product', detail: words([o.identity?.brand, o.category].filter(Boolean).join(' ')),
    objectIds: [o.id], box: o.box, action: 'replace', placeholder: 'What should appear here?', brand: true }));
  people.forEach((o, i) => {
    out.push({ id: `person:${o.id}`, group: 'people', title: people.length > 1 ? `Person ${i + 1}` : o.kind === 'animal' ? 'Animal' : 'Person', detail: words(o.category), objectIds: [o.id], box: o.box, action: 'replace', placeholder: 'Show someone else (optional)' });
    const clothes = live.filter(w => worn.has(w.id) && scene.relations.some(r => r.relation === 'wears' && r.source === o.id && r.target === w.id));
    if (o.kind !== 'animal') out.push({ id: `clothing:${o.id}`, group: 'people', title: people.length > 1 ? `Person ${i + 1} · clothing` : 'Clothing', detail: clothes.length ? words(clothes.map(c => c.category).join(', ')) : 'What they wear',
      objectIds: [o.id], box: o.box, action: 'modify', property: 'clothing', placeholder: 'e.g. a white linen shirt (optional)' });
  });
  const background = live.find(o => o.kind === 'scenery' && o.importance === 'background');
  if (background) out.push({ id: 'scene:background', group: 'scene', title: 'Background', detail: words(background.category), objectIds: [background.id], box: background.box, action: 'modify', placeholder: 'Change the background (optional)' });
  const groupOf = (title: string, id: string, items: typeof live, placeholder: string) => { if (items.length) out.push({ id, group: 'scene', title, detail: words([...new Set(items.map(o => o.category))].slice(0, 3).join(', ')), objectIds: items.map(o => o.id), box: union(items.map(o => o.box)), action: 'modify', placeholder }); };
  groupOf('Display stands', 'scene:stands', live.filter(o => o.kind === 'furniture' || (o.kind === 'scenery' && o.importance !== 'background')), 'Change the stands or surfaces (optional)');
  groupOf('Props', 'scene:props', live.filter(o => o.kind === 'object' && !isProduct(o) && !worn.has(o.id) && !partOf(o.id)), 'Change the props (optional)');
  groupOf('Decorations', 'scene:decorations', live.filter(o => o.kind === 'decoration'), 'Change the decorations (optional)');
  return out;
}
/** A field's current text and brand, read from the draft. */
export const fieldValue = (draft: SceneDraft, f: CustomizeField) => { const e = draft.edits[f.objectIds[0]]; return e && e.action === f.action && (f.property ? e.property === f.property : !e.property) ? { value: e.value ?? '', brand: e.brand ?? '' } : { value: '', brand: '' }; };
/** The draft with a field set (or cleared): its objects get the field's edit; an empty field leaves them to the AI. */
export function withField(draft: SceneDraft, f: CustomizeField, value: string, brand: string): SceneDraft {
  const edits = { ...draft.edits };
  for (const id of f.objectIds) {
    const own = edits[id] && edits[id].action === f.action && (f.property ? edits[id].property === f.property : !edits[id].property);
    if (value.trim() || brand.trim()) edits[id] = { action: f.action, ...(value.trim() ? { value } : {}), ...(f.property ? { property: f.property } : {}), ...(f.brand && brand.trim() ? { brand } : {}) } as ObjectEdit;
    else if (own) delete edits[id]; // another field's change of the same object stays
  }
  return { ...draft, edits };
}

/** Square thumbnails of regions of one image, drawn in the browser (contain-fit, a little padding, a light ground). */
function useCrops(url: string, boxes: { id: string; box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'> }[]) {
  const key = JSON.stringify(boxes.map(b => [b.id, b.box.x, b.box.y, b.box.w, b.box.h]));
  const [crops, setCrops] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!url) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      const out: Record<string, string> = {}, size = 128;
      for (const { id, box } of JSON.parse(key).map(([id, x, y, w, h]: [string, number, number, number, number]) => ({ id, box: { x, y, w, h } }))) {
        const pad = 0.06, x = Math.max(0, box.x - box.w * pad), y = Math.max(0, box.y - box.h * pad), w = Math.min(1 - x, box.w * (1 + 2 * pad)), h = Math.min(1 - y, box.h * (1 + 2 * pad));
        const sw = w * image.naturalWidth, sh = h * image.naturalHeight;
        if (sw < 1 || sh < 1) continue;
        const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
        const g = canvas.getContext('2d');
        if (!g) continue;
        g.fillStyle = '#f3f3ef'; g.fillRect(0, 0, size, size);
        const scale = Math.min(size / sw, size / sh), dw = sw * scale, dh = sh * scale;
        g.drawImage(image, x * image.naturalWidth, y * image.naturalHeight, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
        try { out[id] = canvas.toDataURL('image/png'); } catch { /* a cross-origin image cannot be read: the card shows its icon */ }
      }
      setCrops(out);
    };
    image.src = url;
    return () => { live = false; };
  }, [url, key]);
  return crops;
}

const GROUPS: { id: CustomizeField['group']; title: string; icon: typeof Package }[] = [
  { id: 'products', title: 'Products', icon: Package }, { id: 'people', title: 'People', icon: User }, { id: 'scene', title: 'Scene & style', icon: Paintbrush }];

export function CustomizePanel({ scene, draft, onDraft, referenceUrl, locked }: { scene: SceneDescription; draft: SceneDraft; onDraft: (next: SceneDraft) => void; referenceUrl: string; locked: boolean }) {
  const fields = useMemo(() => customizeFields(scene), [scene]);
  const crops = useCrops(referenceUrl, fields.map(f => ({ id: f.id, box: f.box })));
  const filled = fields.filter(f => { const v = fieldValue(draft, f); return !!(v.value.trim() || v.brand.trim()); }).length;
  const clearAll = () => { let next = draft; for (const f of fields) next = withField(next, f, '', ''); onDraft(next); };
  if (!fields.length) return <p className="tw-muted">No editable objects were found in this image. Generate Creative still makes a fresh version of it.</p>;
  return <div className="cz-panel">
    <div className="cz-toolbar"><p className="tw-muted">Every field is optional. Leave one empty to keep it, or let AI adapt it to your changes.</p>
      {filled > 0 && <button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={clearAll}><RotateCcw size={14} aria-hidden="true" /> Clear all</button>}</div>
    {GROUPS.map(group => {
      const own = fields.filter(f => f.group === group.id);
      if (!own.length) return null;
      const Icon = group.icon;
      return <section key={group.id} className="cz-group" aria-label={group.title}><h4><Icon size={15} aria-hidden="true" /> {group.title}</h4>
        <div className="cz-grid">{own.map(f => {
          const { value, brand } = fieldValue(draft, f), set = (v: string, b: string) => onDraft(withField(draft, f, v, b)), inputId = `cz-${f.id.replace(/[^a-z0-9_-]/gi, '-')}`;
          return <div key={f.id} className={`cz-card${value || brand ? ' is-changed' : ''}`}>
            <div className="cz-thumb" aria-hidden="true">{crops[f.id] ? <img src={crops[f.id]} alt="" /> : <Icon size={22} />}</div>
            <div className="cz-body">
              <label htmlFor={inputId} className="cz-title">{f.title}<small>{f.detail}</small></label>
              <div className="cz-input"><input id={inputId} maxLength={120} value={value} placeholder={f.placeholder} disabled={locked} onChange={e => set(e.target.value, brand)} />
                {(value || brand) && <button type="button" className="cz-clear" aria-label={`Clear ${f.title}`} disabled={locked} onClick={() => set('', '')}><X size={13} /></button>}</div>
              {f.brand && value.trim() && <input className="cz-brand" aria-label={`${f.title} brand (optional)`} maxLength={60} value={brand} placeholder="Brand (optional)" disabled={locked} onChange={e => set(value, e.target.value)} />}
            </div>
          </div>;
        })}</div></section>;
    })}
  </div>;
}

/**
 * "Your changes": what the user typed, the AI's intent in one sentence, the main changes it will make on its own, and
 * the paid requests one click makes. Planned locally with the same rules the server uses (autoResolve), so it costs
 * nothing; it never claims a result before one exists.
 */
export function ChangesSummary({ scene, draft, slots, fields, planningCached, cutout, busy, disabled, onGenerate, onOriginal }: {
  scene: SceneDescription; draft: SceneDraft; slots?: Record<string, string>; fields: CustomizeField[]; planningCached: boolean; cutout?: string;
  busy: boolean; disabled: boolean; onGenerate: () => void; onOriginal: () => void;
}) {
  let auto: ReturnType<typeof autoResolve> | undefined;
  try { auto = autoResolve(scene, draft, { slots: slots ?? {} }); } catch { auto = undefined; }
  const typed = fields.map(f => ({ f, v: fieldValue(draft, f) })).filter(x => x.v.value.trim() || x.v.brand.trim());
  const label = (id: string) => scene.objects.find(o => o.id === id)?.label.replace(/ · .*$/, '') ?? id;
  const ai: string[] = [];
  for (const e of auto?.plan.entries.filter(x => x.source === 'inferred' && x.operation !== 'keep' && x.property !== 'brand') ?? []) {
    const o = scene.objects.find(x => x.id === e.targetId);
    const line = e.targetType === 'mark' ? 'Remove the old brand logos' : e.targetType === 'overlay' ? 'Remove old text about the replaced product'
      : !o ? '' : e.operation === 'remove' ? `Remove ${label(o.id).toLowerCase()}` : e.operation === 'replace' ? `Replace ${label(o.id).toLowerCase()} too` : e.operation === 'adjust' ? 'Adjust the hand to hold the new product naturally'
      : o.kind === 'scenery' && o.importance === 'background' ? 'Restyle the background to suit it' : `Adapt ${label(o.id).toLowerCase()}`;
    if (line && !ai.includes(line)) ai.push(line);
  }
  const strategy = auto ? editStrategy(scene, auto.plan) : undefined, changed = typed.length > 0;
  const planning = changed && needsResolver(scene, draft) && !planningCached ? 1 : 0;
  const masks = strategy?.kind === 'background' || strategy?.kind === 'layered' ? cutout === 'birefnet' ? 1 : strategy.protectIds.length : 0;
  const cost = [strategy?.kind === 'layered' ? '2 image requests (the new background, then each changed product in its own place)' : '1 image request', ...(planning ? ['1 AI planning call (to plan related changes)'] : []), ...(masks ? [`${masks} product cutout${masks === 1 ? '' : 's'} (to keep your products exact)`] : [])];
  return <section className="cz-summary" aria-label="Your changes" aria-live="polite"><h3>Your changes</h3>
    {changed ? <ul>{typed.map(({ f, v }) => <li key={f.id}><b>{f.title}</b>: {[v.brand.trim() && !v.value.toLowerCase().includes(v.brand.trim().toLowerCase()) ? v.brand.trim() : '', v.value.trim()].filter(Boolean).join(' ')}</li>)}</ul> : null}
    <p>{auto?.intent.summary ?? 'AI will update related details when you generate.'}</p>
    {ai.length > 0 && <details><summary>AI will also update {ai.length} related detail{ai.length === 1 ? '' : 's'}</summary><ul>{ai.slice(0, 8).map(x => <li key={x}>{x}</li>)}</ul></details>}
    <div className="cz-actions"><button type="button" className="ws-btn ws-btn-primary" disabled={disabled} onClick={onGenerate}>{busy ? <LoaderCircle size={16} className="ws-spin" aria-hidden="true" /> : <Sparkles size={16} />} Generate Creative</button>
      <button type="button" className="ws-btn ws-btn-quiet" disabled={disabled} onClick={onOriginal} title="Review your original image as it is: no image request">Use original · free</button></div>
    <p className="cz-cost">Generate Creative uses {cost.join(' + ')}. Nothing is charged until you click.</p>
  </section>;
}
