/**
 * Feature flags of the client, read once from the build environment (Vite exposes the VITE_* variables).
 *
 * LEGACY_IMAGE_TO_LAYERS: the earlier generic decomposition flow ("Image to layers": upload, review the detected
 * layers, refine, open in the editor). It predates the template flow (the "OpenAI + Seedream test" panel with
 * Templates A, B and C) and is not part of it. Its three entry points are shown only when
 * VITE_LEGACY_IMAGE_TO_LAYERS is on:
 *   - the floating "Image to layers" button (App.tsx),
 *   - the AI panel's "Decompose" operation (AIPanel.tsx),
 *   - the editor's "Detected layers" tray (EditorShell.tsx).
 * Off unless set. Only the entry points are gated: the flow's own code, its API (/api/decomposition), worker and
 * database are untouched, and a saved design keeps its link to the job it was opened from.
 */
export const flagOn = (value: unknown) => typeof value === 'string' && /^(?:1|true|on|yes)$/i.test(value.trim());
export const LEGACY_IMAGE_TO_LAYERS = flagOn(import.meta.env.VITE_LEGACY_IMAGE_TO_LAYERS);

/**
 * LEGACY_CREATIVE_TEMPLATES: the earlier creative-template wizard of the OpenAI + Seedream workspace, replaced by
 * Template Studio. Its code, API, saved executions and decomposition-plan reuse are untouched, and a saved execution
 * still opens from Saved Runs; only its own tab is hidden. Shown with VITE_LEGACY_CREATIVE_TEMPLATES at build time, or
 * in one browser with localStorage "frameflow.legacyCreativeTemplates" = "1" (its regression tests use that).
 */
export function legacyCreativeTemplates(): boolean {
  if (flagOn(import.meta.env.VITE_LEGACY_CREATIVE_TEMPLATES)) return true;
  try { return flagOn(window.localStorage.getItem('frameflow.legacyCreativeTemplates') ?? ''); } catch { return false; }
}
