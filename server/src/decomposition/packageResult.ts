import sharp from 'sharp';
import type { DecompositionArtifactRef, DecompositionLayer, DecompositionManifest } from '@frameflow/shared';
import { validDecompositionManifest } from '@frameflow/shared';
import type { PipelineContext } from './context.js';
import { compositeLayers } from './image/composite.js';
import { decodeRgba } from './image/extract.js';
import { decodeMask } from './image/masks.js';
import { DecompositionError } from './errors.js';
import type { ArtifactRecord } from './repository.js';

/** Strip storage paths, owners and database fields before creating a portable manifest. */
export function portableRef(record: DecompositionArtifactRef): DecompositionArtifactRef {
  const { artifactId, relativePath, sha256, mimeType, bytes, width, height } = record;
  return { artifactId, relativePath, sha256, mimeType, bytes, width, height };
}
export function manifestArtifacts(manifest: DecompositionManifest): DecompositionArtifactRef[] {
  const refs = manifest.layers.flatMap((l) => [l.rgba, l.alpha, l.visibleOwnership, l.generatedSupport, l.visibleOnlyRgba]);
  refs.push(manifest.preview, manifest.qualityReport, manifest.provenance);
  return [...new Map(refs.filter((ref): ref is DecompositionArtifactRef => !!ref).map((ref) => [ref.relativePath, ref])).values()];
}

export async function validateLayerArtifacts(layers: DecompositionLayer[], read: (id: string) => Promise<Buffer>) {
  const paths = new Map<string, string>();
  for (const layer of layers) {
    const rgba = await decodeRgba(await read(layer.rgba.artifactId));
    const alpha = await decodeMask(await read(layer.alpha.artifactId), { encoding: 'luminance' });
    if (rgba.width !== layer.bbox.width || rgba.height !== layer.bbox.height || alpha.width !== rgba.width || alpha.height !== rgba.height) throw new DecompositionError('PACKAGE_DIMENSIONS', 'Layer crop dimensions do not match the manifest.', 409);
    for (let i = 0; i < alpha.data.length; i++) if (alpha.data[i] !== rgba.data[i * 4 + 3]) throw new DecompositionError('PACKAGE_ALPHA', 'The layer alpha mask does not match the PNG.', 409);
    for (const ref of [layer.rgba, layer.alpha, layer.visibleOwnership, layer.generatedSupport, layer.visibleOnlyRgba]) {
      if (!ref) continue;
      if (paths.has(ref.relativePath) && paths.get(ref.relativePath) !== ref.artifactId) throw new DecompositionError('PACKAGE_PATH_CONFLICT', 'Two artifacts have the same package path.', 409);
      paths.set(ref.relativePath, ref.artifactId);
      const metadata = await sharp(await read(ref.artifactId)).metadata();
      if (metadata.format !== 'png' || metadata.width !== ref.width || metadata.height !== ref.height) throw new DecompositionError('PACKAGE_INVALID_IMAGE', 'A package image failed decoding or metadata verification.', 409);
    }
  }
}

export async function packageResult(context: PipelineContext, layers: DecompositionLayer[], status: 'completed' | 'partial', occlusion: DecompositionManifest['occlusion'] = []) {
  const source = context.repository.getSource(context.job.sourceId, context.job.ownerId)!;
  await validateLayerArtifacts(layers, (id) => context.artifact(id));
  const compositeInputs = [];
  for (const layer of [...layers].sort((a, b) => a.zIndex - b.zIndex)) compositeInputs.push({ rgba: await context.artifact(layer.rgba.artifactId), bbox: layer.bbox });
  const composite = await compositeLayers(source.width, source.height, compositeInputs);
  const preview = await context.put('preview', await sharp(composite).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'previews/composite.png');
  const thumbnails: { input: Buffer; left: number; top: number }[] = [];
  for (let i = 0; i < layers.length; i++) thumbnails.push({ input: await sharp(await context.artifact(layers[i].rgba.artifactId)).resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), left: i % 4 * 192, top: Math.floor(i / 4) * 192 });
  const contact = await sharp({ create: { width: 192 * Math.min(4, layers.length), height: 192 * Math.ceil(layers.length / 4), channels: 4, background: '#e8edf4' } }).composite(thumbnails).webp().toBuffer();
  const contactArtifact = await context.put('contact-sheet', contact, 'previews/contact-sheet.webp', 'image/webp');
  const sourcePixels = await decodeRgba(await context.artifact(source.masterArtifactId));
  const recomposed = await decodeRgba(composite); let changed = 0, maxError = 0;
  for (let i = 0; i < sourcePixels.data.length; i++) { const delta = Math.abs(sourcePixels.data[i] - recomposed.data[i]); if (delta) changed++; maxError = Math.max(maxError, delta); }
  const jsonArtifact = async (kind: string, value: unknown, path: string) => portableRef(await context.put(kind, Buffer.from(JSON.stringify(value, null, 2)), path, 'application/json'));
  const qualityReport = await jsonArtifact('quality', { schemaVersion: 1, status, warnings: context.job.warnings, review: context.job.data.resultReviewed ? 'user-accepted' : 'visible-only', fidelityReference: 'orientation-corrected sRGB working master', reconstruction: { changedChannelValues: changed, maximumChannelError: maxError, explanation: 'Generated regions and soft-alpha compositing can differ from the original. Opaque observed RGB is verified separately.' }, layers: layers.map(({ id, quality, completionStatus }) => ({ id, quality, completionStatus })), contactSheet: portableRef(contactArtifact), limitations: ['Hidden pixels are synthesized, not recovered.', 'Hair/glass edge RGB may contain source background color.', 'Automatic segmentation quality has no universal guarantee.'] }, 'quality-report.json');
  const inferences = context.job.data.inferences as Record<string, unknown> | undefined;
  const provenance = await jsonArtifact('provenance', { schemaVersion: 1, pipelineVersion: '1.0.0', workingMasterSha256: source.workingMasterSha256, providerModelRevision: 'unknown', calls: Object.values(inferences ?? {}), analysisTransform: context.job.data.analysisTransform, completionPlans: context.job.data.planMetadata, immutableOriginalRetained: true, alphaMode: 'straight', generatedContentIsPlausible: true }, 'provenance.json');
  const manifest: DecompositionManifest = { schemaVersion: 1, pipelineVersion: '1.0.0', jobId: context.job.id, revision: context.job.revision + 1, status, source: { originalSha256: source.originalSha256, workingMasterSha256: source.workingMasterSha256, width: source.width, height: source.height, colorSpace: 'srgb', orientationNormalized: source.orientationNormalized }, coordinateSystem: 'working-master-pixels', alphaMode: 'straight', layers, occlusion, warnings: context.job.warnings, createdAt: new Date().toISOString(), preview: portableRef(preview), qualityReport, provenance };
  if (!validDecompositionManifest(manifest)) throw new DecompositionError('MANIFEST_INVALID', 'The result manifest failed validation. Existing artifacts are preserved.', 409);
  // Verify every file exists and hashes match before the worker's fenced publication transaction.
  for (const ref of manifestArtifacts(manifest)) await context.artifact(ref.artifactId);
  context.job.manifest = manifest; context.job.state = status;
  await jsonArtifact('manifest', manifest, 'manifest.json');
  context.job.data.contactSheetArtifactId = contactArtifact.artifactId;
  context.finish(10, status === 'completed' ? 'Layer package ready' : 'Partial layer package ready');
  return manifest;
}

export function artifactIsPublicReference(record: ArtifactRecord, manifest: DecompositionManifest) {
  return manifestArtifacts(manifest).some((ref) => ref.artifactId === record.artifactId);
}
