/**
 * TEST FIXTURE: the variation poster (variationPoster.fixture.ts) as a protected template with confirmed regions and an
 * approved local-fill base, made through the real service and store in a temporary folder. No provider is reachable:
 * the decomposition deps count and refuse every use.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerDeps } from '../decomposition/layerizeExperiment.js';
import { createProtectedTemplates } from '../decomposition/protectedTemplates/service.js';
import { fileProtectedStore } from '../decomposition/protectedTemplates/store.js';
import { fakeRecognizer } from './recognizer.js';
import { VARIATION_ELEMENTS, VARIATION_WORDS, variationPosterPng } from './variationPoster.fixture.js';

export async function readyVariationTemplate(root = mkdtempSync(join(tmpdir(), 'protected-words-')), recognizer = fakeRecognizer(VARIATION_WORDS)) {
  const providers = { planner: 0, transport: 0 };
  const deps = (): RunnerDeps => ({ planner: async () => { providers.planner++; throw new Error('no planner'); }, transport: () => { providers.transport++; throw new Error('no transport'); } } as unknown as RunnerDeps);
  const store = fileProtectedStore(join(root, 'protected'));
  const service = createProtectedTemplates({ store, runsDir: join(root, 'runs'), deps, isActiveRun: () => false, recognizer: () => recognizer });
  const created = await service.create(await variationPosterPng(root), { name: 'Easy EMI poster', filename: 'poster.png' });
  let v = await service.setElements(created.id, created.revision, VARIATION_ELEMENTS);
  v = await service.confirmRegions(created.id, v.revision);
  v = await service.fillBase(created.id, v.revision);
  v = await service.approveBase(created.id, v.revision, true);
  return { root, store, service, recognizer, providers, template: v };
}
