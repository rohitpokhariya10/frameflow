/**
 * Import a brand kit file (Generator's .brand.json format, e.g. docs/brand/<brand>/<brand>.brand.json from the
 * Generator archive) with its logo files into Template Studio. Local files only; no provider call.
 *
 *   npm run studio:import-brand-kit -- <path/to/kit.brand.json>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ingestAsset } from './assets/ingest.js';
import { attachLogo, brandKitFile, createBrandKit } from './brand/kits.js';
import { parseStudioEnv } from './config.js';
import { openStudioStore } from './store.js';

const file = process.argv[2];
if (!file) { console.error('Usage: npm run studio:import-brand-kit -- <path/to/kit.brand.json>'); process.exit(1); }
const env = parseStudioEnv(process.env);
const db = openStudioStore(env.dataDir);
const kitFile = brandKitFile.parse(JSON.parse(await readFile(file, 'utf8')));
const kit = createBrandKit(db, { name: kitFile.name, rules: kitFile.rules, sourceNote: kitFile.sourceNote });
for (const logo of kitFile.logos ?? []) {
  const bytes = await readFile(path.resolve(path.dirname(file), logo.file));
  const { asset } = await ingestAsset({ buffer: bytes, role: 'logo', filename: path.basename(logo.file), label: logo.name }, { db, storageDir: env.assetStorageDir });
  attachLogo(db, kit.id, { assetId: asset.id, kind: logo.kind, name: logo.name, colourName: logo.colourName ?? null });
}
console.info(`Imported brand kit "${kit.name}" (${kitFile.logos?.length ?? 0} logos) into ${env.dataDir}.`);
