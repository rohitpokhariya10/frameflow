import { EditorShell } from './features/editor/EditorShell';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { DecompositionPanel } from './features/decomposition/DecompositionPanel';
import { LayerizeExperimentPanel } from './features/decomposition/LayerizeExperimentPanel';
import { TemplateStudio } from './features/templates/TemplateStudio';

import { useAppSelector } from './store';
import { NewDesignDialog } from './features/editor/NewDesignDialog';
import { LEGACY_IMAGE_TO_LAYERS } from './lib/featureFlags';
import type { bootstrapEditor } from './lib/persistence/bootstrap';
import { DesignsContext } from './features/editor/designs';

export type ProjectSession = Pick<ReturnType<typeof bootstrapEditor>, 'newDesign' | 'cleanupArtwork' | 'designs' | 'openDesign' | 'openNewDesign'>;
export default function App({ session }: { session: ProjectSession }) {
  const projectId = useAppSelector((state) => state.editor.document.id);
  const [confirming, setConfirming] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [experimenting, setExperimenting] = useState(false);
  // Create Offer Creative: the client journey (choose a template, upload products, generate, review, save), the same
  // panel without its developer tabs.
  const [creating, setCreating] = useState(false);
  // Reusable design templates: local only, independent of the two AI test panels beside it.
  const [templating, setTemplating] = useState(false);
  // Create Template from Image: the creative team's image-first flow, a dialog of its own, opened from the OpenAI +
  // Seedream test panel (the bottom row has no room for another launcher beside the zoom control on laptop screens).

  // The earlier generic "Image to layers" flow is shown only behind its flag (lib/featureFlags.ts). Without it the two
  // other launchers move into the corner it would have taken; with it everything is where it always was.
  return <DesignsContext.Provider value={session}>{LEGACY_IMAGE_TO_LAYERS && <><button className="decomp-launch" onClick={() => setDecomposing(true)}>Image to layers</button>{decomposing && <DecompositionPanel onClose={() => setDecomposing(false)} />}</>}
    {/* One row in the corner (the client's launcher first from the right); the developer launchers hide on phones. */}
    <div className="ff-launchers" style={LEGACY_IMAGE_TO_LAYERS ? { right: 160 } : undefined}>
      <button className="decomp-launch ff-dev-launch" onClick={() => setTemplating(true)}>Create Own Template</button>
      <button className="decomp-launch ff-dev-launch" onClick={() => setExperimenting(true)}>OpenAI + Seedream test</button>
      <button className="decomp-launch ff-create-launch" onClick={() => setCreating(true)}><Sparkles size={16} aria-hidden="true" />Create Offer Creative</button>
    </div>
    {creating && <LayerizeExperimentPanel client onClose={() => setCreating(false)} />}{experimenting && <LayerizeExperimentPanel onClose={() => setExperimenting(false)} />}{templating && <TemplateStudio onClose={() => setTemplating(false)} />}
    <EditorShell key={projectId} onNewDesign={() => setConfirming(true)} />
    {confirming && <NewDesignDialog session={session} onClose={() => {
      setConfirming(false);
      document.getElementById('new-design-action')?.focus();
    }} />}</DesignsContext.Provider>;
}
