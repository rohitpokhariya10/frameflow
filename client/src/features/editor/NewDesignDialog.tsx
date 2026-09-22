import { useEffect, useRef, useState } from 'react';
import type { ProjectSession } from '../../App';

export function NewDesignDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleanupOnly, setCleanupOnly] = useState(false);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal(); cancel.current?.focus();
    return () => node.close();
  }, []);
  function close() {
    if (running.current) return;
    dialog.current?.close(); onClose();
  }
  async function confirm() {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try {
      const cleaned = await (cleanupOnly ? session.cleanupArtwork() : session.newDesign());
      setCleanupOnly(true);
      if (cleaned) { dialog.current?.close(); onClose(); }
      else setError('Your new design is ready, but some old artwork could not be removed from this device. Retry cleanup.');
    } catch {
      setError('Could not save a new design. Your current project is unchanged. Check browser storage and try again.');
    } finally { running.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="new-design-dialog" aria-labelledby="new-design-title" aria-describedby="new-design-description"
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <h2 id="new-design-title">{cleanupOnly ? 'Finish artwork cleanup' : 'Start a new design?'}</h2>
    <p id="new-design-description">This will clear the current design, text, artwork, and saved versions from this device. This action cannot be undone.</p>
    {error && <p className="reset-error" role="alert">{error}</p>}
    <div className="reset-actions">
      <button ref={cancel} className="button" disabled={busy} onClick={close}>{cleanupOnly ? 'Close' : 'Cancel'}</button>
      <button className="button reset-confirm" disabled={busy} onClick={() => void confirm()}>{busy ? 'Starting fresh…' : cleanupOnly ? 'Retry cleanup' : 'Start new design'}</button>
    </div>
  </dialog>;
}
