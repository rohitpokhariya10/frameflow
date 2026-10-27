/**
 * What differs between this machine and a deployed server (one Render web service): where runtime data is kept, and the
 * app's own address.
 *
 * FRAMEFLOW_DATA_DIR is an optional persistent data folder, e.g. /var/data/frameflow on a paid Render disk mounted at
 * /var/data. It holds the same `artifacts/` layout the repository keeps locally (artifacts/decomposition/…,
 * artifacts/template-studio) and the legacy decomposition database (data/decomposition), so a local folder can be
 * copied over as it is. Unset, or naming a disk that is not there (Render Free has none), everything stays in the
 * repository's own folders: permanent on this machine, temporary on a host without a disk.
 */
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configuredRoot = (env: NodeJS.ProcessEnv) => env.FRAMEFLOW_DATA_DIR?.trim() ? resolve(env.FRAMEFLOW_DATA_DIR.trim()) : undefined;
/** The configured folder when its parent (the mounted disk) exists; else undefined, and the repository's folders are used. */
const dataRoot = (env: NodeJS.ProcessEnv) => { const root = configuredRoot(env); return root && existsSync(dirname(root)) ? root : undefined; };
const DATA_ROOT = dataRoot(process.env);

/** The runtime `artifacts/` folder: FRAMEFLOW_DATA_DIR/artifacts, else the repository's own. */
export const ARTIFACTS_DIR = resolve(DATA_ROOT ?? repoRoot, 'artifacts');

/** The legacy decomposition database folder under FRAMEFLOW_DATA_DIR (DECOMP_DATA_DIR still wins); undefined when unset. */
export function decompositionDataDir(env: NodeJS.ProcessEnv = process.env) {
  const root = dataRoot(env);
  return root ? resolve(root, 'data/decomposition') : undefined;
}

/**
 * Run once at startup; never stops the server. Returns the artifacts folder and, when saved files will not outlast the
 * process (no disk on a host such as Render Free, or FRAMEFLOW_DATA_DIR naming a disk that is not mounted), a warning
 * for the log.
 */
export function prepareStorage(env: NodeJS.ProcessEnv = process.env): { dir: string; warning?: string } {
  if (DATA_ROOT) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    accessSync(ARTIFACTS_DIR, constants.W_OK);
    return { dir: ARTIFACTS_DIR };
  }
  const configured = configuredRoot(env), temporary = 'saved templates, uploads and creatives are temporary: they are lost on every restart, redeploy or spin-down';
  if (configured) return { dir: ARTIFACTS_DIR, warning: `FRAMEFLOW_DATA_DIR is ${configured}, but ${dirname(configured)} does not exist (no persistent disk); using ${ARTIFACTS_DIR}, so ${temporary}.` };
  if (env.RENDER) return { dir: ARTIFACTS_DIR, warning: `No persistent disk (FRAMEFLOW_DATA_DIR is not set); ${temporary}.` };
  return { dir: ARTIFACTS_DIR };
}

/**
 * The deployed app's own origin, without a trailing slash: CLIENT_ORIGIN, else the address Render gives the service
 * (RENDER_EXTERNAL_URL, e.g. https://name.onrender.com, which Render sets). A custom domain needs CLIENT_ORIGIN.
 */
export function appOrigin(env: NodeJS.ProcessEnv = process.env) {
  const origin = env.CLIENT_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  return origin ? origin.replace(/\/$/, '') : undefined;
}
