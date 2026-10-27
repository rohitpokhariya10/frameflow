/**
 * Step 7 of a protected template: style variations. New artwork for the same creative, with the template's own words and
 * logos placed on it by FrameFlow. The administrator chooses how many, a style per variation (the four defaults, any other
 * preset, or their own direction), whether each one is AI artwork or a free local restyle, and the typography; sees what
 * it could cost; confirms the paid requests explicitly; then compares the results side by side with the original, adjusts
 * one, saves it and opens it in the editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Layers3, LoaderCircle, Sparkles, XCircle } from 'lucide-react';
import {
  CUSTOM_PRESET_ID, DEFAULT_PRESET_IDS, PROVENANCE_DETAILS, PROVENANCE_LABELS, VARIATION_LIMITS, WORD_ROLE_LABELS,
  type CustomTypography, type ProtectedTemplateView, type StudioImageQuality, type StyleVariationRequest, type StyleVariationView, type TypographyMode, type VariationEstimate, type VariationSlotRequest, type VariationSource,
} from '@frameflow/shared';
import { Alert, Badge, Money, fmtDate } from '../templateStudio/ui';
import { newIdempotencyKey } from '../templateStudio/api';
import { FontPicker } from '../fonts/FontPicker';
import { protectedFileUrl } from './api';
import { terminalVariation, variationsApi, type LayoutChange, type Readiness, type VariationMeta } from './variationsApi';
import { VariationPreview } from './VariationPreview';

export type OpenVariation = (template: ProtectedTemplateView, variation: StyleVariationView) => Promise<void>;
const SOURCE_LABELS: Record<VariationSource, string> = { ai: 'AI artwork (paid)', restyle: 'Local restyle (free, no AI)', reuse: 'Reuse the base (free, no AI)' };
const STATUS_LABELS: Record<StyleVariationView['status'], string> = { queued: 'Waiting its turn', generating: 'Generating…', checking: 'Checking…', ready: 'Ready', needs_review: 'Needs review', failed: 'Failed', cancelled: 'Cancelled' };
const statusTone = (s: StyleVariationView['status']) => s === 'ready' ? 'ok' : s === 'needs_review' ? 'warn' : s === 'failed' || s === 'cancelled' ? 'danger' : 'accent';
const defaultSlots = (count: number): VariationSlotRequest[] => Array.from({ length: count }, (_, i) => ({ presetId: DEFAULT_PRESET_IDS[i % DEFAULT_PRESET_IDS.length], source: 'ai' as const }));

export function StyleVariations({ template: t, onOpen }: { template: ProtectedTemplateView; onOpen: OpenVariation }) {
  const [meta, setMeta] = useState<VariationMeta>(), [readiness, setReadiness] = useState<Readiness>(), [variations, setVariations] = useState<StyleVariationView[]>([]);
  const [slots, setSlots] = useState<VariationSlotRequest[]>(defaultSlots(VARIATION_LIMITS.defaultCount)), [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<TypographyMode>('match'), [custom, setCustom] = useState<CustomTypography>({ headline: 'Poppins', body: 'Inter', headlineWeight: 700, bodyWeight: 600 });
  const [quality, setQuality] = useState<StudioImageQuality>('medium'), [estimate, setEstimate] = useState<VariationEstimate>(), [estimateError, setEstimateError] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [compare, setCompare] = useState<string | null>(null);
  // One key per confirmed request: a double click or a retried POST returns the same variations instead of paying twice.
  const key = useRef<string | null>(null);
  const request: StyleVariationRequest = useMemo(() => ({ slots, typographyMode: mode, quality, ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}), ...(mode === 'custom' ? { customTypography: custom } : {}) }), [slots, mode, quality, instructions, custom]);
  const signature = JSON.stringify(request);
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setConfirmed(false); key.current = null; };

  useEffect(() => {
    let alive = true;
    void variationsApi.meta().then(m => { if (alive) { setMeta(m); setQuality(q => m.qualities.includes(q) ? q : m.quality); } }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const refresh = useCallback(async () => { const r = await variationsApi.list(t.id); setReadiness(r.readiness); setVariations(r.variations); }, [t.id]);
  useEffect(() => { let alive = true; void variationsApi.list(t.id).then(r => { if (alive) { setReadiness(r.readiness); setVariations(r.variations); } }).catch((e: Error) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [t.id, t.revision]);
  const active = variations.some(v => !terminalVariation(v));
  useEffect(() => { if (!active) return; const timer = setInterval(() => { void refresh().catch(() => undefined); }, 1200); return () => clearInterval(timer); }, [active, refresh]);
  useEffect(() => {
    if (!readiness?.ready) return;
    let alive = true;
    const timer = setTimeout(() => { void variationsApi.estimate(t.id, JSON.parse(signature) as StyleVariationRequest).then(e => { if (alive) { setEstimate(e); setEstimateError(''); } }).catch((e: Error) => { if (alive) { setEstimate(undefined); setEstimateError(e.message); } }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [t.id, signature, readiness?.ready]);

  const act = async (work: () => Promise<void>, done?: string) => { setBusy(true); setError(''); setNotice(''); try { await work(); if (done) setNotice(done); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } };
  const generate = () => act(async () => {
    if (!estimate) throw new Error('Wait for the estimate.');
    key.current ??= newIdempotencyKey();
    const result = await variationsApi.create(t.id, { idempotencyKey: key.current, request, ...(estimate.paidRequests ? { confirm: { paid: confirmed, estimateMicroUsd: estimate.confirmMicroUsd } } : {}) });
    key.current = null; setConfirmed(false);
    await refresh();
    setCompare(result.variations[0]?.id ?? null);
  }, 'Variations requested. Each AI request is sent once; nothing is retried by itself.');
  const update = (v: StyleVariationView) => setVariations(list => list.map(x => x.id === v.id ? v : x));
  const presets = meta?.presets ?? [], count = slots.length;
  const setCount = (n: number) => edit(setSlots)(n > slots.length ? [...slots, ...defaultSlots(n).slice(slots.length)] : slots.slice(0, n));
  const setSlot = (i: number, patch: Partial<VariationSlotRequest>) => edit(setSlots)(slots.map((s, j) => j === i ? { ...s, ...patch } : s));
  const compared = variations.find(v => v.id === compare);

  if (readiness && !readiness.ready) return <p className="ts-muted" data-testid="variations-not-ready">{readiness.reason}</p>;
  if (!meta || !readiness) return <p className="ts-muted" role="status">Loading style variations…</p>;
  const paid = estimate?.paidRequests ?? 0;
  return <div className="sv-variations">
    {error && <Alert>{error}</Alert>}
    {notice && <Alert tone="ok">{notice}</Alert>}
    <p className="ts-hint">The image model sees only the approved text-free base and a guide of grey and white boxes, never the words, logos or partner names. FrameFlow places the template's own words as editable text and its logos as image slots. Typography and logo changes never ask for new artwork.</p>
    <section className="sv-form" aria-label="New variations">
      <div className="sv-fields">
        <div className="ts-field"><label htmlFor="sv-count">How many variations</label><input id="sv-count" type="number" min={1} max={VARIATION_LIMITS.maxCount} value={count}
          onChange={e => setCount(Math.max(1, Math.min(VARIATION_LIMITS.maxCount, Math.round(Number(e.target.value) || 1))))} /></div>
        <div className="ts-field"><label htmlFor="sv-quality">Image quality</label><select id="sv-quality" value={quality} onChange={e => edit(setQuality)(e.target.value as StudioImageQuality)}>
          {meta.qualities.map(q => <option key={q} value={q}>{q}</option>)}</select></div>
      </div>
      <ol className="sv-slots" aria-label="Variations to make">{slots.map((s, i) => <li key={i}>
        <span className="sv-slot-n">{i + 1}</span>
        <select aria-label={`Style for variation ${i + 1}`} value={s.presetId} onChange={e => setSlot(i, { presetId: e.target.value })}>
          {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value={CUSTOM_PRESET_ID}>Custom direction…</option></select>
        <select aria-label={`Artwork for variation ${i + 1}`} value={s.source} onChange={e => setSlot(i, { source: e.target.value as VariationSource })}>
          {(Object.keys(SOURCE_LABELS) as VariationSource[]).map(k => <option key={k} value={k}>{SOURCE_LABELS[k]}</option>)}</select>
        {s.presetId === CUSTOM_PRESET_ID ? <textarea aria-label={`Custom direction for variation ${i + 1}`} rows={2} maxLength={VARIATION_LIMITS.maxCustomInstructions} value={s.customDirection ?? ''} placeholder="Visual style only, e.g. warm watercolour textures with soft paper grain" onChange={e => setSlot(i, { customDirection: e.target.value })} />
          : <small>{presets.find(p => p.id === s.presetId)?.summary}</small>}
      </li>)}</ol>
      <div className="ts-field"><label htmlFor="sv-instructions">Extra direction for every AI variation (optional, visual style only)</label>
        <textarea id="sv-instructions" rows={2} maxLength={VARIATION_LIMITS.maxCustomInstructions} value={instructions} placeholder="e.g. keep the warm festive light; more space around the offer" onChange={e => edit(setInstructions)(e.target.value)} /></div>
      <fieldset className="sv-typography"><legend>Typography</legend>
        {(Object.keys(meta.typographyModes) as TypographyMode[]).map(m => <label key={m} className="ts-check"><input type="radio" name="sv-typography" checked={mode === m} onChange={() => edit(setMode)(m)} />
          <span><strong>{meta.typographyModes[m].label}</strong> · {meta.typographyModes[m].detail}</span></label>)}
        {mode === 'custom' && <div className="sv-fields">
          <div className="ts-field"><span className="control-label">Headline font</span><FontPicker value={custom.headline} onChange={headline => edit(setCustom)({ ...custom, headline })} /></div>
          <div className="ts-field"><span className="control-label">Body font</span><FontPicker value={custom.body} onChange={body => edit(setCustom)({ ...custom, body })} /></div>
          <div className="ts-field"><label htmlFor="sv-custom-colour">Text colour (optional)</label><input id="sv-custom-colour" type="color" value={custom.color ?? '#03595a'} onChange={e => edit(setCustom)({ ...custom, color: e.target.value })} /></div>
        </div>}
      </fieldset>
      <section className="sv-estimate" aria-label="Cost estimate" aria-live="polite">
        {estimateError ? <Alert tone="warn">{estimateError}</Alert> : !estimate ? <p className="ts-muted">Estimating…</p> : <>
          <table className="pt-metrics"><caption>Before anything is sent · {estimate.model}, {estimate.quality}, {estimate.providerSize} · rate card {estimate.rateCardVersion}</caption>
            <thead><tr><th>Stage</th><th>Model</th><th>Count</th><th>Up to</th><th>Note</th></tr></thead>
            <tbody>{estimate.lines.map((l, i) => <tr key={i}><td>{l.stage}</td><td>{l.model}</td><td>{l.count}</td><td><Money value={l.cost} /></td><td>{l.note}</td></tr>)}</tbody></table>
          <p><strong>Total: up to <Money value={estimate.total} /></strong> for {paid} paid image request{paid === 1 ? '' : 's'} · today's Studio budget left <Money value={estimate.daily.remaining} /> · per variation limit <Money value={estimate.perVariationCap} /></p>
          {estimate.blockedReason && <Alert>{estimate.blockedReason}</Alert>}
          <p className="ts-hint">{estimate.note}</p>
        </>}
      </section>
      <div className="ts-confirm" role="group" aria-label="Confirm the variations">
        {paid > 0 && estimate && <label className="ts-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>I confirm {paid} paid image request{paid === 1 ? '' : 's'} to {estimate.model}, up to {estimate.total.inr} ({estimate.total.usd}). Each is sent once; a refusal or failure is not retried and not replaced by a copy.</span></label>}
        <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !estimate || !!estimate.blockedReason || (paid > 0 && !confirmed)} onClick={() => void generate()}>
          <Sparkles size={15} aria-hidden="true" />{paid ? `Generate ${count} variation${count === 1 ? '' : 's'} (${paid} paid)` : `Make ${count} variation${count === 1 ? '' : 's'} (free, local)`}</button>
      </div>
    </section>

    {variations.length > 0 && <section aria-label="Variations" className="sv-results">
      <h4>Compare with the original</h4>
      <div className="sv-grid">
        <article className="sv-card sv-original" aria-label="Original">
          <figure className="sv-preview" style={{ aspectRatio: `${t.source.width} / ${t.source.height}` }}><img className="sv-artwork" src={protectedFileUrl(t.id, t.source.inputFile)} alt="The original creative" /></figure>
          <header><strong>Original</strong><Badge>Source creative</Badge></header>
        </article>
        {variations.map(v => <VariationCard key={v.id} template={t} variation={v} busy={busy} compared={v.id === compare} onCompare={() => setCompare(v.id === compare ? null : v.id)}
          act={act} onChange={update} onOpen={() => onOpen(t, v)} onDuplicated={async () => { await refresh(); }} />)}
      </div>
      {compared && <CompareView key={compared.id} template={t} variation={compared} busy={busy} act={act} onChange={update} />}
    </section>}
  </div>;
}

function VariationCard({ template: t, variation: v, busy, compared, onCompare, act, onChange, onOpen, onDuplicated }: {
  template: ProtectedTemplateView; variation: StyleVariationView; busy: boolean; compared: boolean; onCompare: () => void;
  act: (work: () => Promise<void>, done?: string) => Promise<void>; onChange: (v: StyleVariationView) => void; onOpen: () => Promise<void>; onDuplicated: () => Promise<void>;
}) {
  const done = v.status === 'ready' || v.status === 'needs_review', errors = v.validation.issues.filter(i => i.severity === 'error'), warnings = v.validation.issues.filter(i => i.severity === 'warning');
  const label = `Variation ${v.index + 1}: ${v.preset.name}`;
  return <article className={`sv-card${compared ? ' is-compared' : ''}`} aria-label={label}>
    {done ? <VariationPreview template={t} variation={v} label={`${label} preview`} />
      : <div className="sv-preview sv-pending" style={{ aspectRatio: `${v.layout.canvas.width} / ${v.layout.canvas.height}` }}>{v.status === 'failed' || v.status === 'cancelled' ? <XCircle size={22} aria-hidden="true" /> : <LoaderCircle size={22} className="ws-spin" aria-hidden="true" />}</div>}
    <header><strong>{v.preset.name}</strong><Badge tone={statusTone(v.status)}>{STATUS_LABELS[v.status]}</Badge></header>
    <p className="sv-provenance" title={PROVENANCE_DETAILS[v.provenance]}><Badge tone={v.provenance === 'ai_generated' ? 'accent' : 'neutral'}>{PROVENANCE_LABELS[v.provenance]}</Badge>
      {v.artwork?.cachedFrom && <Badge>Reused identical artwork</Badge>}{v.review.status !== 'unreviewed' && <Badge tone={v.review.status === 'rejected' ? 'danger' : 'ok'}>{v.review.status}</Badge>}</p>
    {v.error && <Alert>{v.error.code}: {v.error.message}{v.error.requestId ? ` (request ${v.error.requestId})` : ''} Nothing was put in its place.</Alert>}
    {done && <ul className="sv-checks" aria-label={`Checks of ${label}`}>
      <li className={v.validation.checks.collisions === 'pass' ? 'is-pass' : v.validation.checks.collisions === 'fail' ? 'is-fail' : 'is-warn'}>{v.validation.collisionFree ? 'No overlapping layout boxes (every pair checked)' : `${v.validation.issues.filter(i => i.code === 'COLLISION').length} overlap(s)`}</li>
      <li className={v.validation.checks.artworkText === 'fail' ? 'is-fail' : v.validation.checks.artworkText === 'pass' ? 'is-pass' : 'is-warn'}>{v.artworkCheck?.status === 'clean' ? 'No drawn text found in the artwork (local check)' : v.artworkCheck?.status === 'text_found' ? `Text found in the artwork: ${v.artworkCheck.words.map(w => `“${w.text}”`).join(', ')}` : v.artworkCheck?.note ?? 'Artwork not checked'}</li>
      <li className={v.validation.checks.contrast === 'pass' ? 'is-pass' : v.validation.checks.contrast === 'not_checked' ? 'is-warn' : 'is-warn'}>Contrast: {v.validation.checks.contrast === 'pass' ? 'every word readable' : v.validation.checks.contrast === 'not_checked' ? 'not checked' : `${v.validation.issues.filter(i => i.code === 'LOW_CONTRAST').length} word(s) low`}</li>
      {errors.length + warnings.length > 0 && <li className={errors.length ? 'is-fail' : 'is-warn'}>{errors.length} error(s), {warnings.length} warning(s)<ul>{[...errors, ...warnings].slice(0, 5).map((i, k) => <li key={k}>{i.message}</li>)}</ul></li>}
    </ul>}
    <p className="ts-hint">{v.cost.actual ? <>Cost <Money value={v.cost.actual} />{v.cost.unknown ? ' (usage not reported: estimate kept)' : ''}</> : <>Estimate <Money value={v.cost.estimate} /></>} · {v.artwork?.model ?? (v.source === 'ai' ? 'AI' : 'local')} · {fmtDate(v.createdAt)}</p>
    {done && <div className="sv-actions">
      <select aria-label={`Typography for ${label}`} value={v.layout.typographyMode} disabled={busy} onChange={e => void act(async () => onChange(await variationsApi.layout(v.id, { typographyMode: e.target.value as TypographyMode })), 'Typography changed. No new artwork, no AI call.')}>
        <option value="match">Match original</option><option value="suggested">Suggested for the style</option>{v.customTypography && <option value="custom">Custom</option>}</select>
      <button type="button" className="ws-btn" aria-pressed={compared} onClick={onCompare}><Layers3 size={14} aria-hidden="true" />{compared ? 'Close comparison' : 'Compare and adjust'}</button>
      <button type="button" className="ws-btn" disabled={busy} aria-pressed={v.review.status === 'selected' || v.review.status === 'saved'} onClick={() => void act(async () => onChange(await variationsApi.review(v.id, 'select')))}><CheckCircle2 size={14} aria-hidden="true" />Select</button>
      <button type="button" className="ws-btn" disabled={busy} aria-pressed={v.review.status === 'rejected'} onClick={() => void act(async () => onChange(await variationsApi.review(v.id, 'reject')))}><XCircle size={14} aria-hidden="true" />Reject</button>
      <button type="button" className="ws-btn ws-btn-primary" disabled={busy || errors.length > 0} title={errors.length ? 'Fix the errors first' : undefined} onClick={() => void act(async () => onChange(await variationsApi.review(v.id, 'save')), 'Variation saved.')}>Save variation</button>
      <button type="button" className="ws-btn" disabled={busy} onClick={() => void act(onOpen)}><ExternalLink size={14} aria-hidden="true" />Open in editor</button>
      <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void act(async () => { await variationsApi.duplicate(v.id); await onDuplicated(); }, 'Copied (same artwork, no new call).')}><Copy size={14} aria-hidden="true" />Duplicate</button>
    </div>}
  </article>;
}

/** The selected variation beside the original, larger, with its words and logos to adjust (in variant coordinates only). */
function CompareView({ template: t, variation: v, busy, act, onChange }: { template: ProtectedTemplateView; variation: StyleVariationView; busy: boolean; act: (work: () => Promise<void>, done?: string) => Promise<void>; onChange: (v: StyleVariationView) => void }) {
  const original = new Map((t.textAnalysis?.words ?? []).map(w => [w.id, w]));
  const [texts, setTexts] = useState<Record<string, string>>({}), [hidden, setHidden] = useState<Record<string, boolean>>({}), [confirm, setConfirm] = useState<Record<string, boolean>>({});
  const changes: LayoutChange = {
    words: v.layout.words.filter(w => (texts[w.wordId] !== undefined && texts[w.wordId] !== w.text) || (hidden[w.wordId] !== undefined && hidden[w.wordId] !== w.hidden))
      .map(w => ({ wordId: w.wordId, ...(texts[w.wordId] !== undefined && texts[w.wordId] !== w.text ? { text: texts[w.wordId] } : {}), ...(hidden[w.wordId] !== undefined && hidden[w.wordId] !== w.hidden ? { hidden: hidden[w.wordId] } : {}) })),
    confirmProtectedEdits: Object.keys(confirm).filter(k => confirm[k]),
  };
  const pending = (changes.words?.length ?? 0) > 0 || (changes.confirmProtectedEdits?.length ?? 0) > 0;
  return <section className="sv-compare" aria-label={`Compare ${v.preset.name} with the original`}>
    <div className="sv-compare-pair">
      <figure className="sv-preview" style={{ aspectRatio: `${t.source.width} / ${t.source.height}` }}><img className="sv-artwork" src={protectedFileUrl(t.id, t.source.inputFile)} alt="The original creative" /><figcaption>Original</figcaption></figure>
      <VariationPreview template={t} variation={v} label={`${v.preset.name}, larger`} />
    </div>
    <h5>Words in this variation</h5>
    <ul className="sv-adjust" aria-label="Words in this variation">{v.layout.words.map(w => {
      const o = original.get(w.wordId), value = texts[w.wordId] ?? w.text, changed = o && value !== o.text;
      return <li key={w.wordId}>
        <input aria-label={`Text of ${o?.text ?? w.text}`} value={value} maxLength={80} onChange={e => setTexts({ ...texts, [w.wordId]: e.target.value })} />
        <small>{w.style.fontFamily} {w.style.fontWeight}{w.style.fontStyle === 'italic' ? ' italic' : ''} · {Math.round(w.style.fontSize)} px</small>
        {w.protected && <Badge tone="accent">{WORD_ROLE_LABELS[w.role]} · protected</Badge>}
        <label className="ts-check"><input type="checkbox" checked={hidden[w.wordId] ?? w.hidden} onChange={e => setHidden({ ...hidden, [w.wordId]: e.target.checked })} /><span>Hide</span></label>
        {w.protected && changed && <label className="ts-check"><input type="checkbox" checked={!!confirm[w.wordId]} onChange={e => setConfirm({ ...confirm, [w.wordId]: e.target.checked })} /><span>I confirm changing protected {WORD_ROLE_LABELS[w.role].toLowerCase()} “{o!.text}”</span></label>}
      </li>;
    })}</ul>
    <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || !pending} onClick={() => void act(async () => { onChange(await variationsApi.layout(v.id, changes)); setTexts({}); setHidden({}); setConfirm({}); }, 'Layout changed. No new artwork, no AI call.')}>Apply changes</button>
      <span className="ts-hint">Changes this variation only; the template's original words and boxes stay as they are.</span></div>
    <details><summary>History ({v.review.history.length})</summary><ol>{[...v.review.history].reverse().map((e, i) => <li key={i}><time>{fmtDate(e.at)}</time> {e.action}{e.detail ? `: ${e.detail}` : ''}</li>)}</ol></details>
  </section>;
}
