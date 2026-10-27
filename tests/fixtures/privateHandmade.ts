/**
 * The hand-made manifest of the client's reference creative (tests/fixtures/ganeshHandmade.fixture.ts) is confidential and
 * kept out of the repository: loaded only where it is present (undefined elsewhere). The module is named through a
 * variable, so nothing fails to resolve without it.
 */
import { existsSync } from 'node:fs';

type Box = { x: number; y: number; width: number; height: number };
export interface GaneshHandmade {
  GANESH_LG_SIZE: { readonly width: number; readonly height: number };
  GANESH_LG_HANDMADE_ANSWER: unknown;
  ganeshWordManifest: (size: { width: number; height: number }) => { words: { text: string; box: Box }[] } & Record<string, unknown>;
}
const MODULE = './ganeshHandmade.fixture.js';
export async function loadGaneshHandmade(): Promise<GaneshHandmade | undefined> {
  if (!existsSync(new URL('./ganeshHandmade.fixture.ts', import.meta.url))) return undefined;
  return (await import(MODULE)) as GaneshHandmade;
}
