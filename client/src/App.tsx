import { EditorShell } from './features/editor/EditorShell';
import { useState } from 'react';
import { DecompositionPanel } from './features/decomposition/DecompositionPanel';
import { LayerizeExperimentPanel } from './features/decomposition/LayerizeExperimentPanel';
import { TemplateStudio } from './features/templates/TemplateStudio';
import { useAppSelector } from './store';
import { NewDesignDialog } from './features/editor/NewDesignDialog';
import type { bootstrapEditor } from './lib/persistence/bootstrap';

export type ProjectSession = Pick<ReturnType<typeof bootstrapEditor>, 'newDesign' | 'cleanupArtwork'>;
export default function App({ session }: { session: ProjectSession }) {
  const projectId = useAppSelector((state) => state.editor.document.id);
  const [confirming, setConfirming] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [experimenting, setExperimenting] = useState(false);
  // Reusable design templates: local only, independent of the two AI test panels beside it.
  const [templating, setTemplating] = useState(false);
  return <><button className="decomp-launch" onClick={() => setDecomposing(true)}>Image to layers</button>{decomposing && <DecompositionPanel onClose={() => setDecomposing(false)} />}
    <button className="decomp-launch" style={{ right: 160 }} onClick={() => setExperimenting(true)}>OpenAI + Seedream test</button>{experimenting && <LayerizeExperimentPanel onClose={() => setExperimenting(false)} />}
    <button className="decomp-launch" style={{ right: 388 }} onClick={() => setTemplating(true)}>Create Own Template</button>{templating && <TemplateStudio onClose={() => setTemplating(false)} />}
    <EditorShell key={projectId} onNewDesign={() => setConfirming(true)} />
    {confirming && <NewDesignDialog session={session} onClose={() => {
      setConfirming(false);
      document.getElementById('new-design-action')?.focus();
    }} />}</>;
}
