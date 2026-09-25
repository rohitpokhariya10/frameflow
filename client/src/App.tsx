import { EditorShell } from './features/editor/EditorShell';
import { useState } from 'react';
import { DecompositionPanel } from './features/decomposition/DecompositionPanel';
import { useAppSelector } from './store';
import { NewDesignDialog } from './features/editor/NewDesignDialog';
import type { bootstrapEditor } from './lib/persistence/bootstrap';

export type ProjectSession = Pick<ReturnType<typeof bootstrapEditor>, 'newDesign' | 'cleanupArtwork'>;
export default function App({ session }: { session: ProjectSession }) {
  const projectId = useAppSelector((state) => state.editor.document.id);
  const [confirming, setConfirming] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  return <><button className="decomp-launch" onClick={() => setDecomposing(true)}>Decompose image</button>{decomposing && <DecompositionPanel onClose={() => setDecomposing(false)} />}<EditorShell key={projectId} onNewDesign={() => setConfirming(true)} />
    {confirming && <NewDesignDialog session={session} onClose={() => {
      setConfirming(false);
      document.getElementById('new-design-action')?.focus();
    }} />}</>;
}
