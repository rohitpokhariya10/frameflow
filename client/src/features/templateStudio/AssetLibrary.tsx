/** The studio's media library (Generator AssetLibrary): upload by type, filter, preview, and make exact product cutouts. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Images, Scissors, Upload } from 'lucide-react';
import type { StudioAsset, StudioMoney } from '@frameflow/shared';
import { newIdempotencyKey, studioApi, uploadAsset } from './api';
import { Alert, Badge, Empty, Field, JobSteps, PageHeading, StepCard, useJob } from './ui';

export const ASSET_ROLES = [
  { value: 'subject', label: 'Product photo' },
  { value: 'cutout', label: 'Transparent cutout' },
  { value: 'reference', label: 'Template reference' },
  { value: 'logo', label: 'Logo' },
] as const;
const ACCEPT: Record<string, string> = { subject: 'image/png,image/jpeg,image/webp', reference: 'image/png,image/jpeg,image/webp', cutout: 'image/png,image/webp', logo: 'image/png,image/jpeg,image/webp,image/svg+xml' };

export interface CutoutOffer { available: boolean; price: StudioMoney; priceSource: string }

/** Explicit, paid: an exact cutout of an opaque product photo with FrameFlow's SAM-3 masks. */
export function MakeCutout({ asset, offer, onMade }: { asset: StudioAsset; offer: CutoutOffer | null; onMade: (cutout: StudioAsset) => void }) {
  const [confirming, setConfirming] = useState(false), [jobId, setJobId] = useState<string>(), [error, setError] = useState('');
  const key = useRef<string | null>(null);
  const { job } = useJob(jobId, done => {
    if (done.state !== 'complete') { setError(done.error?.message ?? 'The cutout failed.'); return; }
    const id = (done.result as { cutoutAssetId?: string }).cutoutAssetId;
    if (id) void studioApi.get<{ assets: StudioAsset[] }>('/assets?role=cutout').then(r => { const made = r.assets.find(a => a.id === id); if (made) onMade(made); });
  });
  if (asset.hasAlpha || asset.role !== 'subject') return null;
  if (!offer?.available) return <small className="ts-muted">Exact cutouts need FAL_KEY with SAM-3 on the server, or upload a transparent PNG.</small>;
  if (job && !job.terminal) return <JobSteps job={job} />;
  return <div className="ts-cutout">
    {!confirming ? <button type="button" className="ws-btn" onClick={() => setConfirming(true)}><Scissors size={14} aria-hidden="true" /> Make exact cutout</button>
      : <div className="ts-confirm" role="group" aria-label="Confirm cutout">
        <p>One SAM-3 mask request through fal (FrameFlow's segmenter). Listed price {offer.price.inr} ({offer.price.usd}), recorded as an unconfirmed estimate. The cutout keeps this photo's own pixels.</p>
        <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" onClick={async () => {
          setError(''); key.current ??= newIdempotencyKey();
          try { setJobId((await studioApi.post<{ job: { id: string } }>(`/assets/${asset.id}/cutout`, { idempotencyKey: key.current, label: asset.label ?? 'Product' })).job.id); setConfirming(false); }
          catch (e) { setError(e instanceof Error ? e.message : 'Could not start the cutout.'); key.current = null; }
        }}>Make cutout (paid)</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button></div>
      </div>}
    {error && <Alert>{error}</Alert>}
  </div>;
}

export function AssetLibrary({ cutoutOffer }: { cutoutOffer: CutoutOffer | null }) {
  const [assets, setAssets] = useState<StudioAsset[] | null>(null), [filter, setFilter] = useState('all');
  const [role, setRole] = useState('subject'), [label, setLabel] = useState('');
  const [uploading, setUploading] = useState(false), [results, setResults] = useState<{ name: string; ok: boolean; message: string }[]>([]), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fetchAssets = useCallback(() => studioApi.get<{ assets: StudioAsset[] }>(`/assets${filter === 'all' ? '' : `?role=${filter}`}`).then(r => r.assets), [filter]);
  const load = useCallback(async () => {
    try { setAssets(await fetchAssets()); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load assets.'); }
  }, [fetchAssets]);
  useEffect(() => {
    let alive = true;
    void fetchAssets().then(list => { if (alive) { setAssets(list); setError(''); } }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [fetchAssets]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const out: typeof results = [];
    // One at a time: bounded server memory and a clear result per file.
    for (const file of Array.from(files)) {
      try { const r = await uploadAsset<{ deduplicated: boolean }>(file, role, label.trim() || undefined); out.push({ name: file.name, ok: true, message: r.deduplicated ? 'Already in the library' : 'Uploaded' }); }
      catch (e) { out.push({ name: file.name, ok: false, message: e instanceof Error ? e.message : 'Upload failed.' }); }
    }
    setResults(out); setUploading(false);
    if (input.current) input.current.value = '';
    await load();
  };
  const roleLabel = (r: string) => ASSET_ROLES.find(x => x.value === r)?.label ?? r;
  return <div className="ts-page">
    <PageHeading kicker="TEMPLATE STUDIO" title="Assets">Reference posters, product photos, transparent cutouts and logos, stored on this server.</PageHeading>
    <StepCard title="Upload" hint="PNG, JPEG or WebP up to 25 MB and 40 megapixels. SVG is accepted for logos and converted to PNG. Cutouts must have a transparent background.">
      <div className="ts-upload-row">
        <Field label="Type" htmlFor="ts-asset-role"><select id="ts-asset-role" value={role} onChange={e => setRole(e.target.value)}>{ASSET_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
        <Field label="Label (optional)" htmlFor="ts-asset-label"><input id="ts-asset-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Chimney X1, front" /></Field>
        <input ref={input} type="file" multiple accept={ACCEPT[role]} className="ts-sr" aria-label="Choose files to upload" onChange={e => void upload(e.target.files)} />
        <button type="button" className="ws-btn ws-btn-primary" disabled={uploading} onClick={() => input.current?.click()}><Upload size={15} aria-hidden="true" />{uploading ? 'Uploading…' : 'Choose files'}</button>
      </div>
      {results.length > 0 && <ul className="ts-results">{results.map((r, i) => <li key={i} className={r.ok ? 'is-ok' : 'is-error'}>{r.name}: {r.message}</li>)}</ul>}
    </StepCard>
    <StepCard title={`Library${assets ? ` (${assets.length})` : ''}`} aside={<label className="ts-inline-select">Show<select aria-label="Filter assets by type" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All types</option>{ASSET_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>}>
      {error && <Alert>{error}</Alert>}
      {assets === null ? <p className="ts-muted" role="status">Loading…</p> : assets.length === 0 ? <Empty icon={<Images size={28} aria-hidden="true" />} title="No assets yet">Upload reference posters, product photos and logos above.</Empty>
        : <ul className="ts-asset-grid">{assets.map(a => <li key={a.id} className="ts-asset">
          <a href={a.urls.normalised} target="_blank" rel="noreferrer" className="ts-asset-thumb"><img src={a.urls.thumb} alt={a.label ?? a.sourceFilename ?? 'asset'} loading="lazy" className={a.hasAlpha ? 'is-transparent' : undefined} /></a>
          <div className="ts-asset-info"><strong>{a.label ?? a.sourceFilename ?? a.id}</strong><span>{roleLabel(a.role)} · {a.width}×{a.height}</span>{a.hasAlpha && <Badge tone="accent">transparent</Badge>}
            <MakeCutout asset={a} offer={cutoutOffer} onMade={() => void load()} /></div>
        </li>)}</ul>}
    </StepCard>
  </div>;
}
