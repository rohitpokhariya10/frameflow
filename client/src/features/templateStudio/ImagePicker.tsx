/**
 * Pick images of some roles from the studio library, or upload new ones (selected automatically). Selection order is
 * kept: the first product is the hero, the first reference decides the default style direction (Generator ImagePicker).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, Upload } from 'lucide-react';
import type { StudioAsset } from '@frameflow/shared';
import { studioApi, uploadAsset } from './api';
import { Alert } from './ui';

export function ImagePicker({ roles, uploadRole, max, selected, onChange, emptyText, label }: {
  roles: string[]; uploadRole: string; max: number; selected: StudioAsset[]; onChange: (assets: StudioAsset[]) => void; emptyText: string; label: string;
}) {
  const [library, setLibrary] = useState<StudioAsset[] | null>(null);
  const [uploading, setUploading] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const roleKey = roles.join(',');
  const fetchLibrary = useCallback(() => studioApi.get<{ assets: StudioAsset[] }>(`/assets?role=${roleKey}`).then(r => r.assets), [roleKey]);
  const load = useCallback(async () => {
    try { setLibrary(await fetchLibrary()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load images.'); }
  }, [fetchLibrary]);
  useEffect(() => {
    let alive = true;
    void fetchLibrary().then(list => { if (alive) setLibrary(list); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [fetchLibrary]);

  const toggle = (a: StudioAsset) => {
    if (selected.some(s => s.id === a.id)) onChange(selected.filter(s => s.id !== a.id));
    else if (selected.length < max) onChange([...selected, a]);
  };
  const upload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setUploading(true); setError('');
    const added: StudioAsset[] = [];
    try {
      for (const file of list) added.push((await uploadAsset<{ asset: StudioAsset }>(file, uploadRole)).asset);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setUploading(false); if (input.current) input.current.value = ''; }
    const next = [...selected];
    for (const a of added) if (!next.some(s => s.id === a.id) && next.length < max) next.push(a);
    onChange(next);
    await load();
  };

  return <div className="ts-picker">
    <div className={`ts-dropzone${dragging ? ' is-dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}>
      <Upload size={20} aria-hidden="true" />
      <div><span><strong>Drop images here or</strong> <button type="button" className="ws-link" disabled={uploading || selected.length >= max} onClick={() => input.current?.click()}>{uploading ? 'Uploading…' : 'browse'}</button></span>
        <small>PNG, JPEG or WebP up to 25 MB. {selected.length} of {max} selected.</small></div>
      <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp" className="ts-sr" aria-label={`Upload ${label}`} onChange={e => void upload(e.target.files)} />
    </div>
    {error && <Alert>{error}</Alert>}
    {library === null ? <p className="ts-muted" role="status">Loading images…</p>
      : library.length === 0 ? <p className="ts-muted"><ImagePlus size={15} aria-hidden="true" /> {emptyText}</p>
        : <ul className="ts-picker-grid" aria-label={`${label} library`}>
          {library.map(a => {
            const index = selected.findIndex(s => s.id === a.id), on = index >= 0;
            return <li key={a.id}>
              <button type="button" className={`ts-pick${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(a)} disabled={!on && selected.length >= max}
                title={a.label ?? a.sourceFilename ?? ''}>
                <img src={a.urls.thumb} alt="" loading="lazy" className={a.hasAlpha ? 'is-transparent' : undefined} />
                {on && <span className="ts-pick-order" aria-hidden="true">{index + 1}</span>}
                {on && <span className="ts-pick-check" aria-hidden="true"><Check size={13} /></span>}
                <span className="ts-pick-label">{a.label ?? a.sourceFilename ?? 'Image'}{a.hasAlpha ? ' · transparent' : ''}</span>
              </button>
            </li>;
          })}
        </ul>}
  </div>;
}
