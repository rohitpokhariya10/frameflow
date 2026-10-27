/**
 * Generate Image (Generator GenerateForm): template → products → exact campaign text → brand and logos → format →
 * occasion → generation mode, with the estimated cost before the click. Match Reference is the default.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Crosshair, Info, LayoutTemplate, Lock, Shuffle, Sparkles, Wand2 } from 'lucide-react';
import {
  DEFAULT_FIDELITY_MODE, DEFAULT_STUDIO_FORMAT, FIDELITY_MODES, STUDIO_COPY_FIELDS, STUDIO_COPY_LIMITS, STUDIO_CREATIVE_DIRECTIONS, STUDIO_FORMATS, STUDIO_MAX_PRODUCTS,
  STUDIO_OCCASION_GROUPS, type FidelityMode, type StudioAsset, type StudioBrandKit, type StudioCopyField, type StudioEstimate, type StudioImageQuality, type StudioTemplate, type StudioProductAction,
} from '@frameflow/shared';
import { newIdempotencyKey, studioApi } from './api';
import { EstimateTable } from './CostViews';
import { ImagePicker } from './ImagePicker';
import { MakeCutout, type CutoutOffer } from './AssetLibrary';
import { Alert, Badge, Empty, Field, Money, PageHeading, StepCard } from './ui';

interface ProductMeta { name: string; subjectType: string; isSku: boolean }
const CUSTOM_OCCASION = '__custom__';
const MODE_ICON = { match: Crosshair, adapt: Shuffle, explore: Wand2 } as const;

export function GenerateImage({ initialTemplateId, cutoutOffer, defaultQuality, onStarted, onCreateTemplate, onOpenBrandKits }: {
  initialTemplateId?: string; cutoutOffer: CutoutOffer | null; defaultQuality: StudioImageQuality;
  onStarted: (jobId: string) => void; onCreateTemplate: () => void; onOpenBrandKits: () => void;
}) {
  const [templates, setTemplates] = useState<StudioTemplate[] | null>(null), [kits, setKits] = useState<StudioBrandKit[]>([]);
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '');
  const [products, setProducts] = useState<StudioAsset[]>([]), [meta, setMeta] = useState<Record<string, ProductMeta>>({});
  const [copy, setCopy] = useState<Partial<Record<StudioCopyField, string>>>({});
  const [partners, setPartners] = useState<string[]>([]);
  const [formatId, setFormatId] = useState(DEFAULT_STUDIO_FORMAT), [quality, setQuality] = useState<StudioImageQuality>(defaultQuality);
  const [occasion, setOccasion] = useState(''), [customOccasion, setCustomOccasion] = useState('');
  const [mode, setMode] = useState<FidelityMode>(DEFAULT_FIDELITY_MODE), [directionId, setDirectionId] = useState(''), [direction, setDirection] = useState('');
  const [productChoices, setProductChoices] = useState<Record<string, string>>({});
  const [backgroundOnly, setBackgroundOnly] = useState(false);
  const [referenceText, setReferenceText] = useState<'auto' | 'keep' | 'remove'>('auto');
  const [exact, setExact] = useState(false);
  const [estimate, setEstimate] = useState<StudioEstimate | null>(null), [estimateError, setEstimateError] = useState(''), [showBreakdown, setShowBreakdown] = useState(true);
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false);
  const key = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([studioApi.get<{ templates: StudioTemplate[] }>('/templates'), studioApi.get<{ kits: StudioBrandKit[] }>('/brand-kits')]).then(([t, k]) => {
      if (!alive) return;
      const ready = t.templates.filter(x => x.status === 'ready');
      setTemplates(ready); setKits(k.kits);
      setTemplateId(current => ready.some(x => x.id === current) ? current : ready[0]?.id ?? '');
    }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const template = templates?.find(t => t.id === templateId) ?? null;
  const kit = kits.find(k => k.id === template?.brandKit?.id) ?? null;
  const partnerLogos = kit?.logos.filter(l => l.kind === 'partner') ?? [];
  const primaryLogos = kit?.logos.filter(l => l.kind === 'primary') ?? [];
  const format = STUDIO_FORMATS.find(f => f.id === formatId)!;

  const referenceScene = template?.profile?.data.referenceScenes?.find(s => s.referenceId === 'ref1');
  const productActions: StudioProductAction[] = (referenceScene?.products ?? []).map(p => {
    const choice = productChoices[`${templateId}:${p.id}`] ?? 'keep';
    return choice.startsWith('replace:') ? { productId: p.id, action: 'replace', replacementAssetId: choice.slice(8) } : { productId: p.id, action: choice as 'keep' | 'remove' };
  });
  const referenceChoices = { fidelityMode: mode, direction: direction.trim() || (mode === 'explore' && directionId ? STUDIO_CREATIVE_DIRECTIONS.find(d => d.id === directionId)?.text : null), occasion: (occasion === CUSTOM_OCCASION ? customOccasion : occasion).trim() || null, copy, productActions, backgroundOnly, ...(referenceText !== 'auto' ? { referenceText } : {}) };
  const choicesKey = JSON.stringify(referenceChoices);
  const productKey = products.map(p => `${p.id}:${meta[p.id]?.name ?? ''}:${meta[p.id]?.subjectType ?? ''}:${meta[p.id]?.isSku ?? false}`).join('|');
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void studioApi.post<StudioEstimate>('/costs/estimate', { ...referenceChoices, templateId: templateId || null, formatId, quality, products: products.map(p => ({ assetId: p.id, name: meta[p.id]?.name ?? '', subjectType: meta[p.id]?.subjectType || null, isSku: meta[p.id]?.isSku ?? false })) })
        .then(e => { if (active) { setEstimate(e); setEstimateError(''); } }).catch((e: Error) => { if (active) { setEstimate(null); setEstimateError(e.message); } });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
    // productKey stands for products and their metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productKey, formatId, quality, templateId, choicesKey]);

  const setProductList = (list: StudioAsset[]) => {
    setProducts(list);
    setMeta(m => { const next = { ...m }; for (const a of list) next[a.id] ??= { name: (a.label ?? a.sourceFilename?.replace(/\.[^.]+$/, '') ?? 'Product').replace(/ \(cutout\)$/, ''), subjectType: '', isSku: false }; return next; });
  };
  const swapProduct = (from: StudioAsset, to: StudioAsset) => {
    setProducts(list => list.map(p => (p.id === from.id ? to : p)));
    setMeta(m => ({ ...m, [to.id]: m[from.id] ?? { name: to.label ?? 'Product', subjectType: '', isSku: false } }));
  };
  const opaque = products.filter(p => !p.hasAlpha);
  const problems = [
    !template && 'Choose a template.',
    estimate?.blockedReason,
    estimate?.daily && !estimate.daily.fits && `This operation exceeds the remaining Studio daily budget (${estimate.daily.remaining.usd}).`,
    products.some(p => !meta[p.id]?.name.trim()) && 'Give every product a name.',
    exact && opaque.length > 0 && `Exact product pixels needs transparent cutouts: ${opaque.map(p => meta[p.id]?.name || 'product').join(', ')} ${opaque.length === 1 ? 'is' : 'are'} not transparent.`,
    estimate && !estimate.withinCap && `This could exceed the ${estimate.cap.inr} limit per poster: use fewer products or a lower quality.`,
  ].filter((p): p is string => Boolean(p));

  const submit = async () => {
    setAttempted(true);
    if (problems.length) return;
    setSubmitting(true); setError('');
    key.current ??= newIdempotencyKey();
    try {
      const res = await studioApi.post<{ jobId: string }>('/campaigns', {
        ...referenceChoices, idempotencyKey: key.current, templateId,
        subjects: products.map(p => ({ assetId: p.id, name: meta[p.id].name.trim(), subjectType: meta[p.id].subjectType.trim() || null, isSku: meta[p.id].isSku })),
        copy: Object.fromEntries(Object.entries(copy).filter(([, v]) => (v ?? '').trim())),
        partnerLogoIds: partners, formatId, quality, direction: direction.trim() || null,
        occasion: (occasion === CUSTOM_OCCASION ? customOccasion : occasion).trim() || null,
        fidelityMode: mode, creativeDirectionId: mode === 'explore' && directionId ? directionId : null, preserveProductPixels: exact,
      });
      key.current = null;
      onStarted(res.jobId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start generation.'); key.current = null; }
    finally { setSubmitting(false); }
  };

  if (templates && templates.length === 0) return <div className="ts-page"><PageHeading kicker="STEP 2 · TEMPLATE STUDIO" title="Generate image" />
    <Empty icon={<LayoutTemplate size={30} aria-hidden="true" />} title="You need a template first" action={<button type="button" className="ws-btn ws-btn-primary" onClick={onCreateTemplate}>Create a template</button>}>A template teaches FrameFlow the design to keep: backdrop, staging, palette, lighting and layout.</Empty></div>;

  return <div className="ts-page ts-generate">
    <PageHeading kicker="STEP 2 · TEMPLATE STUDIO" title="Generate image">New products in your template's design. Text and logos are added as exact, editable layers, never drawn by the AI.</PageHeading>
    {error && <Alert>{error}</Alert>}

    <StepCard step={1} title="Template" hint="The design family the new image belongs to.">
      {templates === null ? <p className="ts-muted" role="status">Loading templates…</p> : <div className="ts-template-pick" role="radiogroup" aria-label="Template">
        {templates.map(t => <label key={t.id} className={`ts-template-option${t.id === templateId ? ' is-on' : ''}`}>
          <input type="radio" name="ts-template" value={t.id} checked={t.id === templateId} onChange={() => setTemplateId(t.id)} />
          <span className="ts-template-option-art">{t.references.slice(0, 1).map(r => <img key={r.assetId} src={r.thumb} alt="" />)}</span>
          <span className="ts-template-option-text"><strong>{t.name}</strong><small>{t.profile?.data.summary}</small>{t.brandKit && <Badge tone="accent">{t.brandKit.name}</Badge>}</span>
        </label>)}
      </div>}
    </StepCard>

    <StepCard step={2} title={`Products (optional, up to ${STUDIO_MAX_PRODUCTS})`} hint="Leave uploads empty to keep the original products. The first reference owns the product arrangement; additional references supply style only.">
      {!referenceScene && <Alert tone="warn">This older template has no product inventory. Unchanged Match Reference reuse is available; analyse the template again to enable selective edits and new scenes.</Alert>}
      <label className="ts-check"><input type="checkbox" checked={backgroundOnly} onChange={e => setBackgroundOnly(e.target.checked)} /> Background only — explicitly remove all reference products</label>
      {!backgroundOnly && referenceScene?.products.map(p => <Field key={p.id} label={`${p.label} (${p.id})`} htmlFor={`ts-reference-${p.id}`} hint={p.identity}>
        <select id={`ts-reference-${p.id}`} value={productChoices[`${templateId}:${p.id}`] ?? 'keep'} onChange={e => setProductChoices(c => ({ ...c, [`${templateId}:${p.id}`]: e.target.value }))}>
          <option value="keep">Keep original product</option><option value="remove">Remove this product</option>
          {products.map(a => <option key={a.id} value={`replace:${a.id}`}>Replace with {meta[a.id]?.name || a.label || 'uploaded product'}</option>)}
        </select>
      </Field>)}
      <p className="ts-hint">Selective replacement uses transparent cutouts. Choose a replacement for each upload; all other slots stay unchanged. Protected products retain their original view and canvas proportions.</p>
      <ImagePicker roles={['subject', 'cutout']} uploadRole="subject" max={STUDIO_MAX_PRODUCTS} selected={products} onChange={setProductList} label="product photos" emptyText="No product photos yet. Upload some above." />
      {products.length > 0 && <ul className="ts-products">{products.map((p, i) => <li key={p.id}>
        <img src={p.urls.thumb} alt="" className={p.hasAlpha ? 'is-transparent' : undefined} />
        <div className="ts-product-fields">
          <Field label={`Product ${i + 1}${i === 0 ? ' (hero)' : ''} name`} htmlFor={`ts-pname-${p.id}`}><input id={`ts-pname-${p.id}`} aria-invalid={attempted && !meta[p.id]?.name.trim()} value={meta[p.id]?.name ?? ''} onChange={e => setMeta(m => ({ ...m, [p.id]: { ...m[p.id], name: e.target.value } }))} placeholder="Product name" /></Field>
          <Field label="Type" htmlFor={`ts-ptype-${p.id}`}><input id={`ts-ptype-${p.id}`} value={meta[p.id]?.subjectType ?? ''} onChange={e => setMeta(m => ({ ...m, [p.id]: { ...m[p.id], subjectType: e.target.value } }))} placeholder="e.g. chimney" /></Field>
          <label className="ts-check" title="A real product: the AI must not change its look"><input type="checkbox" checked={meta[p.id]?.isSku ?? false} onChange={e => setMeta(m => ({ ...m, [p.id]: { ...m[p.id], isSku: e.target.checked } }))} /> Real SKU</label>
          {p.hasAlpha ? <Badge tone="accent">transparent cutout</Badge> : exact && <MakeCutout asset={p} offer={cutoutOffer} onMade={cutout => swapProduct(p, cutout)} />}
        </div>
      </li>)}</ul>}
    </StepCard>

    <Field label="Existing reference text and logos" htmlFor="ts-reference-text">
      <select id="ts-reference-text" value={referenceText} onChange={e => setReferenceText(e.target.value as typeof referenceText)}>
        <option value="auto">Automatic: keep on unchanged Match; remove for new copy or scenes</option>
        <option value="keep">Keep original raster text and logos</option><option value="remove">Remove original raster text and logos</option>
      </select>
    </Field>
    <StepCard step={3} title="Campaign text (exactly as it should appear)" hint="Only filled fields are placed. Words are never rewritten, and no price, offer or date is ever invented; the image itself contains no text.">
      <div className="ts-form-grid">{STUDIO_COPY_FIELDS.map(f => <Field key={f.id} label={f.label} htmlFor={`ts-copy-${f.id}`} hint={copy[f.id] ? `${copy[f.id]!.length}/${STUDIO_COPY_LIMITS[f.id]}` : undefined}>
        {f.id === 'footer' || f.id === 'body'
          ? <textarea id={`ts-copy-${f.id}`} rows={2} maxLength={STUDIO_COPY_LIMITS[f.id]} value={copy[f.id] ?? ''} onChange={e => setCopy(c => ({ ...c, [f.id]: e.target.value }))} placeholder={f.placeholder} />
          : <input id={`ts-copy-${f.id}`} maxLength={STUDIO_COPY_LIMITS[f.id]} value={copy[f.id] ?? ''} onChange={e => setCopy(c => ({ ...c, [f.id]: e.target.value }))} placeholder={f.placeholder} />}
      </Field>)}</div>
    </StepCard>

    <StepCard step={4} title="Brand and logos" hint={kit ? `From the template's brand kit: ${kit.name}.` : 'This template has no brand kit, so no logo is placed.'} aside={<button type="button" className="ws-btn ws-btn-quiet" onClick={onOpenBrandKits}>Brand kits</button>}>
      {kit ? <>
        <p className="ts-muted">The approved {kit.name} logo is placed in an allowed corner ({kit.rules.logo.allowedCorners.map(c => c.replace('_', '-')).join(' or ')}), in the colour version with the best contrast. Logos are never generated by the AI.</p>
        <div className="ts-logo-row">{primaryLogos.map(l => <span key={l.id} className="ts-logo-chip"><img src={l.asset.urls.thumb} alt="" />{l.name}</span>)}{!primaryLogos.length && <Alert tone="warn">This kit has no logo files yet, so no logo will be placed.</Alert>}</div>
        {partnerLogos.length > 0 ? <fieldset className="ts-fieldset"><legend>Co-branding partners</legend>{partnerLogos.map(l => <label key={l.id} className="ts-check"><input type="checkbox" checked={partners.includes(l.id)} onChange={e => setPartners(p => (e.target.checked ? [...p, l.id] : p.filter(x => x !== l.id)))} /><img src={l.asset.urls.thumb} alt="" className="ts-logo-mini" />{l.name}</label>)}</fieldset>
          : <p className="ts-hint">To co-brand with a bank or partner, add its logo to the kit as a partner logo.</p>}
        <ul className="ts-swatches" aria-label="Brand palette">{[...kit.rules.palette.core, ...kit.rules.palette.accent].filter(c => c.hex).map(c => <li key={c.name} style={{ background: c.hex! }} title={`${c.name} ${c.hex}`} />)}</ul>
      </> : <p className="ts-muted">Choose a brand kit on the template's page (Templates → View style → Brand kit), or create one under Brand Kits.</p>}
    </StepCard>

    <StepCard step={5} title="Format" hint={`Generated at ${format.providerSize.replace('x', '×')} (image model), exported at ${format.width}×${format.height}.`}>
      <div className="ts-formats" role="radiogroup" aria-label="Format">{STUDIO_FORMATS.map(f => <label key={f.id} className={`ts-format${f.id === formatId ? ' is-on' : ''}`}>
        <input type="radio" name="ts-format" value={f.id} checked={f.id === formatId} onChange={() => setFormatId(f.id)} />
        <span className="ts-format-shape" style={{ width: (30 * f.width) / Math.max(f.width, f.height), height: (30 * f.height) / Math.max(f.width, f.height) }} aria-hidden="true" />
        <span><strong>{f.ratio}</strong><small>{f.label}</small><small>{f.width}×{f.height}</small></span>
      </label>)}</div>
    </StepCard>

    <StepCard step={6} title="Occasion (optional)" hint="Themes the scene (e.g. diyas and marigolds for Diwali) and replaces the template's own festival decorations. The template's design stays.">
      <div className="ts-form-grid">
        <Field label="Festival or occasion" htmlFor="ts-occasion"><select id="ts-occasion" value={occasion} onChange={e => setOccasion(e.target.value)}><option value="">None (no festival theme)</option>{STUDIO_OCCASION_GROUPS.map(g => <optgroup key={g.label} label={g.label}>{g.options.map(o => <option key={o} value={o}>{o}</option>)}</optgroup>)}<option value={CUSTOM_OCCASION}>Custom…</option></select></Field>
        {occasion === CUSTOM_OCCASION && <Field label="Custom occasion" htmlFor="ts-occasion-custom"><input id="ts-occasion-custom" maxLength={80} value={customOccasion} onChange={e => setCustomOccasion(e.target.value)} placeholder="e.g. Lohri" /></Field>}
      </div>
    </StepCard>

    <StepCard step={7} title="Generation mode" hint="How closely the new image follows the template. A failure never switches modes.">
      <div className="ts-modes" role="radiogroup" aria-label="Generation mode">{FIDELITY_MODES.map(m => {
        const Icon = MODE_ICON[m.id];
        return <label key={m.id} className={`ts-mode${m.id === mode ? ' is-on' : ''}`}>
          <input type="radio" name="ts-mode" value={m.id} checked={m.id === mode} onChange={() => setMode(m.id)} />
          <span className="ts-mode-icon"><Icon size={18} aria-hidden="true" /></span>
          <span><strong>{m.label}{m.id === 'match' && <Badge tone="ok">Default</Badge>}</strong><small>{m.summary}</small></span>
        </label>;
      })}</div>
      {mode === 'explore' && <Field label="Creative direction (FrameFlow directions, optional)" htmlFor="ts-direction-preset"><select id="ts-direction-preset" value={directionId} onChange={e => setDirectionId(e.target.value)}><option value="">Let the AI decide</option>{STUDIO_CREATIVE_DIRECTIONS.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>}
      <details className="ts-advanced"><summary><ChevronDown size={15} aria-hidden="true" /> Advanced</summary>
        <div className="ts-form-grid">
          <Field label="Art direction (optional)" htmlFor="ts-direction" hint={mode === 'match' ? 'In Match Reference the template\'s scene stays; use this for small notes only.' : 'Only if you want something specific; otherwise the AI decides.'}><textarea id="ts-direction" rows={2} value={direction} onChange={e => setDirection(e.target.value)} placeholder="e.g. warmer light on the products" /></Field>
          <Field label="Image quality" htmlFor="ts-quality"><select id="ts-quality" value={quality} onChange={e => setQuality(e.target.value as StudioImageQuality)}><option value="high">High (default, client quality)</option><option value="medium">Medium (cheaper)</option><option value="low">Low (draft, cheapest)</option></select></Field>
        </div>
        <label className="ts-check ts-exact"><input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} />
          <span><strong><Lock size={13} aria-hidden="true" /> Exact product pixels</strong><small>The image model always redraws products. With this on, FrameFlow's compositor places each product's own pixels from a transparent cutout where the layout puts it, and measures that they are unchanged. Opaque photos need a cutout first (Make exact cutout).</small></span></label>
      </details>
    </StepCard>

    <div className="ts-submit-bar ts-sticky">
      <div className="ts-estimate-summary">
        {estimate ? <><strong>Estimated cost: <Money value={estimate.total} prefix="up to " /></strong><small>{estimate.lines.filter(l => l.cached).length ? `${estimate.lines.filter(l => l.cached).length} stage(s) reuse cached work. ` : ''}Not a guaranteed price; the recorded cost appears with the result.</small>
          <button type="button" className="ws-link" aria-expanded={showBreakdown} onClick={() => setShowBreakdown(s => !s)}>{showBreakdown ? 'Hide' : 'Show'} breakdown</button></>
          : <small>{estimateError || 'Estimating…'}</small>}
      </div>
      <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={submitting || !estimate || Boolean(estimateError) || !templates || Boolean(estimate?.daily && !estimate.daily.fits) || Boolean(estimate?.blockedReason) || Boolean(estimate && !estimate.withinCap)} onClick={() => void submit()}><Sparkles size={16} aria-hidden="true" />{submitting ? 'Starting…' : 'Generate image'}</button>
    </div>
    {attempted && problems.length > 0 && <Alert tone="warn"><ul className="ts-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul></Alert>}
    {estimate && showBreakdown && <StepCard title="Cost breakdown before generating" hint={<><Info size={13} aria-hidden="true" /> Each line is an upper bound for one paid call. Cached stages make no new call.</>}><EstimateTable estimate={estimate} /></StepCard>}
  </div>;
}
