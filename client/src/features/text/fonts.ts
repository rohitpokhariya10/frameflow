import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/lora/latin-400.css';
import '@fontsource/lora/latin-600.css';
import '@fontsource/lora/latin-700.css';
import { TEXT_FONTS, TEXT_WEIGHTS } from '@frameflow/shared';

export async function loadEditorFonts() {
  const faces = await Promise.all(TEXT_FONTS.flatMap((font) => TEXT_WEIGHTS.map((weight) => document.fonts.load(`${weight} 24px "${font}"`))));
  if (faces.some((loaded) => loaded.length === 0)) throw new Error('An editor font could not be loaded.');
}
