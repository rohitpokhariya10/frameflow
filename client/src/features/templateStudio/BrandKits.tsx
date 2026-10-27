/**
 * Brand kits (Generator BrandKitList/BrandKitDetail): approved logos, palette, fonts and logo rules. Logo placement is
 * enforced exactly by the compositor; palette and look are guidance for the AI. Nothing here calls a paid provider.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileJson, Palette, Plus, Trash2, Upload } from 'lucide-react';
import type { StudioAsset, StudioBrandColour, StudioBrandKit } from '@frameflow/shared';
import { StudioRequestError, studioApi, uploadAsset } from './api';
import { Alert, Badge, Empty, Field, PageHeading, StepCard } from './ui';

const CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
const corner = (c: string) => c.replace('_', '-');

/** A minimal, valid brand-rules/1 document from a few inputs (everything else can be refined later or imported). */
export function newBrandRules(input: { colours: { name: string; hex: string }[]; corners: string[]; logoColours: string[]; displayFont: string; textFont: string; look: string }) {
  return {
    schema: 'brand-rules/1',
    palette: { core: input.colours.map(c => ({ name: c.name.trim(), hex: c.hex.toLowerCase(), confirmed: true })), accent: [], extended: [], neutrals: [], rules: [] },
    logo: {
      allowedCorners: input.corners, allowedColours: input.logoColours,
      clearSpace: { unitDefinition: 'X = 14% of the logo width (default)', multiple: 1, unitRatioOfLogoHeight: null, unitRatioOfLogoWidth: 0.14, provenance: 'inferred', confirmed: false },
      partnerLockup: { gapUnits: 2, separator: '×', equalVisualWeight: true }, subBrandLockup: null,
      minWidth: { digitalPx: 100, printMm: null }, prohibited: ['shadow', 'tilt', 'stretch', 'squeeze', 'outline'], requireCleanBackground: true,
    },
    typography: { display: { family: input.displayFont, usage: 'Headlines and offers' }, text: { family: input.textFont, usage: 'Body text and footers' }, notes: [] },
    aesthetic: { summary: input.look.trim() || 'Clean, legible retail advertising.', principles: [], keywords: [], latitude: 'Follow the template; brand colours guide backgrounds and accents.' },
    openQuestions: [],
  };
}

export function BrandKits() {
  const [kits, setKits] = useState<StudioBrandKit[] | null>(null), [open, setOpen] = useState<string>(), [creating, setCreating] = useState(false);
  const [error, setError] = useState(''), [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { try { setKits((await studioApi.get<{ kits: StudioBrandKit[] }>('/brand-kits')).kits); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load brand kits.'); } }, []);
  useEffect(() => {
    let alive = true;
    void studioApi.get<{ kits: StudioBrandKit[] }>('/brand-kits').then(r => { if (alive) setKits(r.kits); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const importFile = async (f?: File) => {
    if (!f) return;
    setError(''); setIssues([]);
    try { const body = JSON.parse(await f.text()); const { kit } = await studioApi.post<{ kit: StudioBrandKit }>('/brand-kits', body); await load(); setOpen(kit.id); }
    catch (e) { if (e instanceof SyntaxError) setError('That file is not valid JSON.'); else if (e instanceof StudioRequestError) { setError(e.message); setIssues(e.issues); } else setError('Import failed.'); }
    finally { if (file.current) file.current.value = ''; }
  };
  const kit = kits?.find(k => k.id === open);
  if (kit) return <BrandKitDetail kit={kit} onBack={() => setOpen(undefined)} onChange={next => setKits(list => list?.map(k => (k.id === next.id ? next : k)) ?? null)} />;
  return <div className="ts-page">
    <PageHeading kicker="TEMPLATE STUDIO" title="Brand kits" actions={<div className="ws-row">
      <input ref={file} type="file" accept="application/json,.json" className="ts-sr" aria-label="Brand kit file" onChange={e => void importFile(e.target.files?.[0])} />
      <button type="button" className="ws-btn" onClick={() => file.current?.click()}><FileJson size={15} aria-hidden="true" /> Import kit file</button>
      <button type="button" className="ws-btn ws-btn-primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New brand kit</button></div>}>
      Approved logos, palette and fonts. The logo is placed exactly by the brand's rules; colours and look guide the AI.
    </PageHeading>
    {error && <Alert>{error}{issues.length > 0 && <ul className="ts-problems">{issues.slice(0, 10).map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}</Alert>}
    {creating && <NewKit onCancel={() => setCreating(false)} onCreated={async id => { setCreating(false); await load(); setOpen(id); }} />}
    {kits === null ? <p className="ts-muted" role="status">Loading…</p> : kits.length === 0 && !creating ? <Empty icon={<Palette size={28} aria-hidden="true" />} title="No brand kits yet" action={<button type="button" className="ws-btn ws-btn-primary" onClick={() => setCreating(true)}>Create a brand kit</button>}>Create one here or import a <code>.brand.json</code> file.</Empty>
      : <ul className="ts-kit-list">{kits.map(k => <li key={k.id}><button type="button" className="ts-kit-row" onClick={() => setOpen(k.id)}>
        <span className="ts-swatches">{[...k.rules.palette.core, ...k.rules.palette.accent].filter(c => c.hex).slice(0, 8).map(c => <span key={c.name} style={{ background: c.hex! }} />)}</span>
        <span className="ts-kit-name"><strong>{k.name}</strong><small>Revision {k.revision} · {k.logos.length} logo{k.logos.length === 1 ? '' : 's'} · {k.fonts.length} font file{k.fonts.length === 1 ? '' : 's'}</small></span>
        {k.warnings.length > 0 ? <Badge tone="warn">{k.warnings.length} need attention</Badge> : <Badge tone="ok">Complete</Badge>}
      </button></li>)}</ul>}
  </div>;
}

function NewKit({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState(''), [look, setLook] = useState('');
  const [colours, setColours] = useState([{ name: 'Primary', hex: '#14325c' }, { name: 'White', hex: '#ffffff' }]);
  const [corners, setCorners] = useState<string[]>(['top_left', 'top_right']), [logoColours, setLogoColours] = useState<string[]>(['Primary', 'White']);
  const [error, setError] = useState('');
  const valid = name.trim() && colours.every(c => c.name.trim() && /^#[0-9a-f]{6}$/i.test(c.hex)) && corners.length && logoColours.length;
  return <StepCard title="New brand kit" hint="The essentials. Logo files and fonts are added on the next screen.">
    <div className="ts-form-grid">
      <Field label="Brand name" htmlFor="ts-kit-name"><input id="ts-kit-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme Appliances" /></Field>
      <Field label="Look and feel (guidance for the AI)" htmlFor="ts-kit-look"><input id="ts-kit-look" value={look} onChange={e => setLook(e.target.value)} placeholder="e.g. Bright, premium, uncluttered" /></Field>
    </div>
    <fieldset className="ts-fieldset"><legend>Palette</legend>{colours.map((c, i) => <div key={i} className="ts-colour-row">
      <input type="color" aria-label={`${c.name || 'Colour'} value`} value={c.hex} onChange={e => setColours(list => list.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))} />
      <input aria-label="Colour name" value={c.name} onChange={e => { const prev = c.name; setColours(list => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); setLogoColours(l => l.map(n => (n === prev ? e.target.value : n))); }} />
      <code>{c.hex}</code>
      <label className="ts-check"><input type="checkbox" checked={logoColours.includes(c.name)} onChange={e => setLogoColours(l => (e.target.checked ? [...l, c.name] : l.filter(n => n !== c.name)))} /> Logo may use this colour</label>
      {colours.length > 1 && <button type="button" className="ws-icon-button" aria-label={`Remove ${c.name}`} onClick={() => { setColours(list => list.filter((_, j) => j !== i)); setLogoColours(l => l.filter(n => n !== c.name)); }}><Trash2 size={15} /></button>}
    </div>)}<button type="button" className="ws-btn ws-btn-quiet" onClick={() => setColours(list => [...list, { name: `Colour ${list.length + 1}`, hex: '#888888' }])}><Plus size={14} aria-hidden="true" /> Add colour</button></fieldset>
    <fieldset className="ts-fieldset"><legend>Logo corners allowed</legend><div className="ws-row">{CORNERS.map(c => <label key={c} className="ts-check"><input type="checkbox" checked={corners.includes(c)} onChange={e => setCorners(l => (e.target.checked ? [...l, c] : l.filter(x => x !== c)))} /> {corner(c)}</label>)}</div></fieldset>
    {error && <Alert>{error}</Alert>}
    <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={!valid} onClick={async () => {
      setError('');
      try { const { kit } = await studioApi.post<{ kit: StudioBrandKit }>('/brand-kits', { name: name.trim(), rules: newBrandRules({ colours, corners, logoColours, displayFont: 'Poppins', textFont: 'Poppins', look }) }); onCreated(kit.id); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not create the kit.'); }
    }}>Create brand kit</button><button type="button" className="ws-btn ws-btn-quiet" onClick={onCancel}>Cancel</button></div>
  </StepCard>;
}

function ColourList({ title, colours }: { title: string; colours: StudioBrandColour[] }) {
  if (!colours.length) return null;
  return <div className="ts-colour-group"><h4>{title}</h4><ul className="ts-palette">{colours.map(c => <li key={c.name}><span style={{ background: c.hex ?? 'transparent' }} className={c.hex ? undefined : 'is-missing'} aria-hidden="true" />{c.name} {c.hex ?? 'value missing'}{!c.confirmed && <Badge tone="warn">unconfirmed</Badge>}</li>)}</ul></div>;
}

function BrandKitDetail({ kit, onBack, onChange }: { kit: StudioBrandKit; onBack: () => void; onChange: (kit: StudioBrandKit) => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [logoKind, setLogoKind] = useState<'primary' | 'partner'>('primary'), [logoName, setLogoName] = useState(''), [logoColour, setLogoColour] = useState(kit.rules.logo.allowedColours[0] ?? '');
  const [fontRole, setFontRole] = useState<'display' | 'text'>('display'), [licence, setLicence] = useState(false);
  const logoFile = useRef<HTMLInputElement>(null), fontFile = useRef<HTMLInputElement>(null);
  const act = async (work: () => Promise<{ kit: StudioBrandKit }>) => { setBusy(true); setError(''); try { onChange((await work()).kit); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } };
  const addLogo = (f?: File) => f && void act(async () => {
    const { asset } = await uploadAsset<{ asset: StudioAsset }>(f, 'logo', logoName || f.name.replace(/\.[^.]+$/, ''));
    try { return await studioApi.post<{ kit: StudioBrandKit }>(`/brand-kits/${kit.id}/logos`, { assetId: asset.id, kind: logoKind, name: logoName.trim() || asset.label || 'Logo', colourName: logoKind === 'primary' ? logoColour : null }); }
    finally { if (logoFile.current) logoFile.current.value = ''; setLogoName(''); }
  });
  const addFont = (f?: File) => f && void act(async () => {
    const form = new FormData(); form.set('file', f); form.set('role', fontRole); form.set('licenceConfirmed', String(licence));
    try { return await studioApi.upload<{ kit: StudioBrandKit }>(`/brand-kits/${kit.id}/fonts`, form); } finally { if (fontFile.current) fontFile.current.value = ''; }
  });
  const r = kit.rules;
  return <div className="ts-page">
    <div className="ts-detail-head"><button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> All brand kits</button>
      <div className="ts-detail-title"><h2>{kit.name} {kit.warnings.length ? <Badge tone="warn">{kit.warnings.length} need attention</Badge> : <Badge tone="ok">Complete</Badge>}</h2><p>Revision {kit.revision}{kit.sourceNote ? ` · ${kit.sourceNote}` : ''}</p></div></div>
    {error && <Alert>{error}</Alert>}
    {kit.warnings.length > 0 && <StepCard title="Needs attention"><ul className="ts-problems">{kit.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul></StepCard>}
    <StepCard title="Logos" hint="Primary logos must be one of the approved colours; the compositor picks the one with the best contrast. Partner logos are for co-branding.">
      {kit.logos.length ? <ul className="ts-logo-list">{kit.logos.map(l => <li key={l.id}><img src={l.asset.urls.thumb} alt="" className="is-transparent" /><span><strong>{l.name}</strong><small>{l.kind}{l.colourName ? ` · ${l.colourName}` : ''}</small></span>
        <button type="button" className="ws-icon-button" aria-label={`Remove ${l.name}`} disabled={busy} onClick={() => void act(() => studioApi.del(`/brand-kits/${kit.id}/logos/${l.id}`))}><Trash2 size={15} /></button></li>)}</ul> : <p className="ts-muted">No logo files yet: posters with this kit get no logo until one is added.</p>}
      <div className="ts-upload-row">
        <Field label="Logo type" htmlFor="ts-logo-kind"><select id="ts-logo-kind" value={logoKind} onChange={e => setLogoKind(e.target.value as 'primary' | 'partner')}><option value="primary">Brand logo</option><option value="partner">Partner logo</option></select></Field>
        {logoKind === 'primary' && <Field label="Colour version" htmlFor="ts-logo-colour"><select id="ts-logo-colour" value={logoColour} onChange={e => setLogoColour(e.target.value)}>{r.logo.allowedColours.map(c => <option key={c} value={c}>{c}</option>)}</select></Field>}
        <Field label="Name" htmlFor="ts-logo-name"><input id="ts-logo-name" value={logoName} onChange={e => setLogoName(e.target.value)} placeholder={logoKind === 'primary' ? 'e.g. Brand logo, white' : 'e.g. Partner Bank'} /></Field>
        <input ref={logoFile} type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" className="ts-sr" aria-label="Logo file" onChange={e => addLogo(e.target.files?.[0])} />
        <button type="button" className="ws-btn" disabled={busy} onClick={() => logoFile.current?.click()}><Upload size={15} aria-hidden="true" /> Upload logo</button>
      </div>
    </StepCard>
    <div className="ts-two">
      <StepCard title="Palette"><ColourList title="Core" colours={r.palette.core} /><ColourList title="Accent" colours={r.palette.accent} /><ColourList title="Extended" colours={r.palette.extended} /><ColourList title="Neutrals" colours={r.palette.neutrals} />{r.palette.rules.length > 0 && <ul>{r.palette.rules.map((x, i) => <li key={i}>{x}</li>)}</ul>}</StepCard>
      <StepCard title="Logo rules">
        <dl className="ts-facts">
          <div><dt>Corners</dt><dd>{r.logo.allowedCorners.map(corner).join(', ')}</dd></div>
          <div><dt>Approved colours</dt><dd>{r.logo.allowedColours.join(', ')}</dd></div>
          <div><dt>Minimum width</dt><dd>{r.logo.minWidth.digitalPx}px</dd></div>
          <div><dt>Clean background</dt><dd>{r.logo.requireCleanBackground ? 'Required' : 'Not required'}</dd></div>
          <div><dt>Partner lock-up</dt><dd>{r.logo.partnerLockup ? `gap ${r.logo.partnerLockup.gapUnits}X${r.logo.partnerLockup.separator ? `, separator "${r.logo.partnerLockup.separator}"` : ''}` : 'None'}</dd></div>
          <div><dt>Look</dt><dd>{r.aesthetic.summary}</dd></div>
          <div><dt>Fonts</dt><dd>Headlines {r.typography.display.family}; body {r.typography.text.family}</dd></div>
        </dl>
      </StepCard>
    </div>
    <StepCard title="Brand fonts (optional)" hint="TTF or OTF. A font is used only after you confirm your licence covers generated artwork; otherwise the bundled open-licence fonts are used.">
      {kit.fonts.length > 0 && <ul className="ts-logo-list">{kit.fonts.map(f => <li key={f.id}><span><strong>{f.family} {f.weight}</strong><small>{f.role} · {f.format}{f.sourceFilename ? ` · ${f.sourceFilename}` : ''}</small></span>
        <label className="ts-check"><input type="checkbox" checked={f.licenceConfirmed} disabled={busy} onChange={e => void act(() => studioApi.patch(`/brand-kits/${kit.id}/fonts/${f.id}`, { licenceConfirmed: e.target.checked }))} /> Licence confirmed</label>
        <button type="button" className="ws-icon-button" aria-label={`Remove ${f.family}`} disabled={busy} onClick={() => void act(() => studioApi.del(`/brand-kits/${kit.id}/fonts/${f.id}`))}><Trash2 size={15} /></button></li>)}</ul>}
      <div className="ts-upload-row">
        <Field label="Use" htmlFor="ts-font-role"><select id="ts-font-role" value={fontRole} onChange={e => setFontRole(e.target.value as 'display' | 'text')}><option value="display">Headlines</option><option value="text">Body text</option></select></Field>
        <label className="ts-check"><input type="checkbox" checked={licence} onChange={e => setLicence(e.target.checked)} /> My licence allows use in generated artwork</label>
        <input ref={fontFile} type="file" accept=".ttf,.otf,font/ttf,font/otf" className="ts-sr" aria-label="Font file" onChange={e => addFont(e.target.files?.[0])} />
        <button type="button" className="ws-btn" disabled={busy} onClick={() => fontFile.current?.click()}><Upload size={15} aria-hidden="true" /> Upload font</button>
      </div>
    </StepCard>
    {r.openQuestions.length > 0 && <StepCard title="Open questions for the brand team"><ul>{r.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></StepCard>}
  </div>;
}
