import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ArtifactRecord, DecompositionRepository } from './repository.js';
import type { ArtifactStore } from './artifactStore.js';
import { DecompositionError } from './errors.js';

const phases = [
  ['01-original', '01 · Original and working master'], ['02-analysis', '02 · Analysis and preview'],
  ['03-qwen', '03 · Qwen proposals'], ['04-sam2', '04 · Segmentation candidates'], ['05-refined', '05 · Refined masks and overlays'],
] as const;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const imageMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
type ExportArtifact = { artifactId: string; relativePath: string; sha256: string; mimeType: string; bytes: number; width: number; height: number; kind: string };
function publicArtifact(record: ArtifactRecord, relativePath = record.relativePath): ExportArtifact {
  return { artifactId: record.artifactId, relativePath, sha256: record.sha256, mimeType: record.mimeType, bytes: record.bytes, width: record.width, height: record.height, kind: record.kind };
}
function safeRelativePath(path: string): void {
  if (path.length > 240 || !phases.some(([directory]) => path.startsWith(`${directory}/`)) || !path.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) throw new DecompositionError('INVALID_EXPORT_PATH', 'Demo artifact has an unsafe path or falls outside phases 01–05.', 400);
}
function portableMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) || value.startsWith('/') ? '[private location omitted]' : value.slice(0, 4000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 256).map(item => portableMetadata(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|password|authorization|cookie|falKey|storageKey|output|url/i.test(key)).map(([key, item]) => [key, portableMetadata(item, depth + 1)]));
  return undefined;
}

/** Export to a new directory; never overwrite an earlier review or expose internal storage paths. */
export async function exportDemo(repository: DecompositionRepository, store: ArtifactStore, jobId: string, destination: string): Promise<{ directory: string; indexPath: string; metadataPath: string; artifactCount: number }> {
  const job = repository.getJob(jobId);
  if (!job || job.tombstonedAt) throw new DecompositionError('JOB_NOT_FOUND', 'Demo job was not found.', 404);
  const source = repository.getSource(job.sourceId, job.ownerId);
  if (!source) throw new DecompositionError('SOURCE_NOT_FOUND', 'The source for this demo is unavailable.', 404);
  const original = repository.getArtifact(source.originalArtifactId, job.ownerId), master = repository.getArtifact(source.masterArtifactId, job.ownerId);
  if (!original || !master) throw new DecompositionError('ARTIFACT_UNAVAILABLE', 'Original or working master is unavailable.', 409);
  const originalExtension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[source.mimeType];
  if (!originalExtension) throw new DecompositionError('INVALID_MIME', 'Source encoding cannot be exported.');
  const allEntries = [{ record: original, ref: publicArtifact(original, `01-original/original.${originalExtension}`) }, { record: master, ref: publicArtifact(master, '01-original/working-master.png') },
    ...repository.listArtifacts(jobId).filter(record => record.ownerId === job.ownerId).map(record => ({ record, ref: publicArtifact(record) }))];
  const entries = [...new Map(allEntries.filter(({ref}) => phases.some(([phase]) => ref.relativePath.startsWith(phase + '/'))).map(entry => [entry.ref.relativePath, entry])).values()];
  const paths = new Set<string>();
  for (const { ref } of entries) { safeRelativePath(ref.relativePath); if (paths.has(ref.relativePath)) throw new DecompositionError('DUPLICATE_EXPORT_PATH', 'Two demo artifacts have the same relative path.', 409); paths.add(ref.relativePath); }
  const mode = job.data.verificationMode === 'mock' ? 'mock' : job.data.verificationMode === 'live' ? 'live' : 'unverified';
  const requests = repository.providerRequests(jobId).map(request => ({ id: request.id, stepId: request.stepId, endpoint: request.endpoint, inputHash: request.inputHash, adapterVersion: request.adapterVersion,
    providerRequestId: request.providerRequestId ?? null, seed: request.seed ?? null, modelRevision: 'unknown', status: request.status, createdAt: new Date(request.createdAt).toISOString(), updatedAt: new Date(request.updatedAt).toISOString() }));
  const metadata = { schemaVersion: 1, scope: 'phases-01-to-05', verificationMode: mode, exportedAt: new Date().toISOString(),
    job: { id: job.id, state: job.state, phase: job.phase, revision: job.revision, progress: job.progress, callsUsed: job.callsUsed, warnings: job.warnings, options: job.options, review: job.review },
    source: { width: source.width, height: source.height, originalSha256: source.originalSha256, workingMasterSha256: source.workingMasterSha256, orientationNormalized: source.orientationNormalized, hasAlpha: source.hasAlpha, colorSpace: 'srgb' },
    artifacts: entries.map(({ ref }) => ref), steps: repository.steps(jobId).filter(step => step.phase <= 5).map(step => ({ id: step.id, phase: step.phase, objectId: step.objectId, inputHash: step.inputHash, attempt: step.attempt, status: step.status, outputArtifactIds: step.outputArtifactIds })),
    providerRequests: requests, phaseMetadata: portableMetadata(job.data) };
  const directory = resolve(destination);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // New-only directory also prevents writes through user-supplied symlinks inside an existing export.
  await mkdir(directory, { mode: 0o700 });
  for (const [phase] of phases) await mkdir(resolve(directory, phase), { mode: 0o700 });
  for (const { record, ref } of entries) {
    const filename = resolve(directory, ref.relativePath);
    if (!filename.startsWith(`${directory}${sep}`)) throw new DecompositionError('INVALID_EXPORT_PATH', 'Demo artifact escapes its export directory.');
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, await store.read(record), { flag: 'wx', mode: 0o600 });
  }
  const banner = mode === 'mock' ? 'MOCK FIXTURE DEMO · No live inference or model quality verified.' : mode === 'live' ? 'LIVE PROVIDER RUN · Review the masks visually; a returned image is not proof of semantic quality.' : 'UNVERIFIED RUN · Verification mode was not recorded.';
  const rows = phases.map(([phase, title]) => {
    const artifacts = entries.filter(({ ref }) => ref.relativePath.startsWith(`${phase}/`));
    return `<section><h2>${title}</h2><div class="row">${artifacts.length ? artifacts.map(({ ref }) => `<figure>${imageMime.has(ref.mimeType) ? `<a href="${escapeHtml(ref.relativePath)}"><img src="${escapeHtml(ref.relativePath)}" alt="${escapeHtml(ref.kind)}" loading="lazy"></a>` : ''}<figcaption><a href="${escapeHtml(ref.relativePath)}">${escapeHtml(ref.relativePath)}</a><br>${ref.width} × ${ref.height} · ${ref.bytes} bytes</figcaption></figure>`).join('') : '<p>No artifacts recorded for this phase.</p>'}</div></section>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>FrameFlow phases 01–05 review</title><style>body{font:16px/1.5 system-ui;margin:0;background:#111827;color:#f3f4f6}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:28px}.banner{background:#713f12;padding:16px;border-radius:8px;font-weight:700}a{color:#93c5fd}.row{display:flex;gap:18px;overflow:auto;padding:8px 0 18px}figure{margin:0;min-width:240px;max-width:480px;flex:1}img{width:100%;height:300px;object-fit:contain;background:repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%) 0/20px 20px}figcaption{font-size:12px;overflow-wrap:anywhere}section{border-top:1px solid #374151;margin-top:28px}code{overflow-wrap:anywhere}li{margin:6px 0}</style></head><body><main><h1>FrameFlow image decomposition · phases 01–05</h1><p class="banner">${banner}</p><p>Job <code>${escapeHtml(job.id)}</code> · ${escapeHtml(job.state)} · phase ${job.phase} · native canvas ${source.width} × ${source.height}</p><p>${escapeHtml(job.progress)}</p><p><a href="metadata.json">Metadata, hashes and provider request IDs</a> · <a href="provenance.json">Provenance</a></p>${job.warnings.length ? `<ul>${job.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}${rows}<section><h2>Provider requests</h2><ul>${requests.length ? requests.map(request => `<li><code>${escapeHtml(request.endpoint)}</code> · ${escapeHtml(request.status)} · request <code>${escapeHtml(request.providerRequestId ?? 'not submitted')}</code></li>`).join('') : '<li>No provider requests recorded.</li>'}</ul><p>This folder contains diagnostic masks and overlays. It does not contain phase 06–10 extraction, reconstruction, completion or final layer packaging.</p></section></main></body></html>`;
  const metadataPath = resolve(directory, 'metadata.json'), indexPath = resolve(directory, 'index.html');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'provenance.json'), JSON.stringify({ verificationMode: mode, providerRequests: requests, inferences: portableMetadata(job.data.inferences ?? {}) }, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(indexPath, html, { flag: 'wx', mode: 0o600 });
  return { directory, indexPath, metadataPath, artifactCount: entries.length };
}
