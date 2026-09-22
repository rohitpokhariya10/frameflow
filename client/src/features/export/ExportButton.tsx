import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { selectActiveVariant, useAppSelector } from '../../store';
import { downloadPng, exportFilename, exportPng } from './exportPng';

export function ExportButton() {
  const variant = useAppSelector(selectActiveVariant);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    // Redux's immutable value is the active design at the instant of the click.
    try { downloadPng(await exportPng(variant), exportFilename(variant.canvas)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not export the PNG. Please retry.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="export-control">
    <button className="button export-button" disabled={busy} aria-busy={busy} title="Download the active version at its full canvas size" onClick={() => { void start(); }}>
      <Download size={15} />{busy ? 'Exporting…' : 'Export PNG'}
    </button>
    {error && <div className="export-error" role="alert"><span>{error}</span><button aria-label="Dismiss export error" onClick={() => setError('')}>Dismiss</button></div>}
  </div>;
}
