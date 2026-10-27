/** Setup screen checks (Generator setup.ts): configuration, key presence, storage, the in-process worker and the fonts. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeConfig, type ServerEnv } from './config.js';
import { BUNDLED_DIR } from './fonts/library.js';
import { FONT_CATALOG } from './fonts/catalog.js';
import { removeStorageFile, writeStorageFile } from './storage.js';
import type { StudioWorker } from './jobs/worker.js';
import type { StudioStore } from './store.js';

export interface Check { ok: boolean; message: string }

export async function setupStatus(env: ServerEnv, db: StudioStore, worker: StudioWorker | undefined, decomposition: { falConfigured: boolean; runsDir: string }) {
  const apiKey: Check = env.OPENAI_API_KEY
    ? { ok: true, message: 'OPENAI_API_KEY is set on the server (never sent to the browser).' }
    : { ok: false, message: 'OPENAI_API_KEY is not set. Add it to server/.env and restart the FrameFlow server.' };
  let storage: Check;
  const rel = `selftest/${randomUUID()}.probe`;
  try { await writeStorageFile(env.assetStorageDir, rel, Buffer.from('ok')); await removeStorageFile(env.assetStorageDir, rel); storage = { ok: true, message: `Storage is writable (${env.dataDir}).` }; }
  catch { storage = { ok: false, message: `Storage is not writable: ${env.dataDir}. Check TEMPLATE_STUDIO_DIR.` }; }
  const queued = db.jobs.count(j => j.state === 'queued');
  const workerCheck: Check & { current: string | null; lastSeenAt: string | null } = worker
    ? { ok: true, message: worker.current() ? 'Worker is running a job.' : `Worker is idle${queued ? ` (${queued} queued)` : ''}.`, current: worker.current(), lastSeenAt: worker.lastSeenAt() }
    : { ok: false, message: 'The worker is not running in this server.', current: null, lastSeenAt: null };
  const missing = FONT_CATALOG.flatMap(f => f.faces.map(([, file]) => file)).filter(file => !existsSync(join(BUNDLED_DIR, file)));
  const fonts: Check = missing.length ? { ok: false, message: `${missing.length} bundled font files are missing (first: ${missing[0]}).` } : { ok: true, message: `${FONT_CATALOG.length} open-licence font families bundled for exact text.` };
  const handoff: Check = decomposition.falConfigured
    ? { ok: true, message: 'FrameFlow decomposition (OpenAI planner + Seedream) is configured for "Decompose Image".' }
    : { ok: false, message: 'FAL_KEY is not set: generated images can be created, but FrameFlow decomposition will refuse to start.' };
  return {
    config: describeConfig(env),
    checks: { apiKey, storage, worker: workerCheck, fonts, decomposition: handoff },
    counts: { templates: db.templates.count(), posters: db.posters.count(), assets: db.assets.count(), brandKits: db.brandKits.count() },
  };
}
