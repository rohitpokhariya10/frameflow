import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appOrigin, decompositionDataDir } from './deployment.js';
import { readDecompositionConfig } from './decomposition/config.js';

// One Render web service: the app's own address and the persistent data folder. Modules that read the environment
// when they load are imported again after each change (vi.resetModules), so nothing leaks between tests.
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const REPO_ARTIFACTS = fileURLToPath(new URL('../../artifacts', import.meta.url));
const RENDER = 'https://pl-testing.onrender.com';

describe('the app\'s own origin', () => {
  it('is CLIENT_ORIGIN, else the address Render gives the service, without a trailing slash', () => {
    expect(appOrigin({ CLIENT_ORIGIN: 'https://studio.example/', RENDER_EXTERNAL_URL: RENDER })).toBe('https://studio.example');
    expect(appOrigin({ CLIENT_ORIGIN: `${RENDER}/` })).toBe(RENDER);
    expect(appOrigin({ RENDER_EXTERNAL_URL: ` ${RENDER}/ ` })).toBe(RENDER);
    expect(appOrigin({ CLIENT_ORIGIN: ' ', RENDER_EXTERNAL_URL: ' ' })).toBeUndefined();
    expect(appOrigin({})).toBeUndefined();
  });

  it('takes no other host\'s address', () => {
    expect(appOrigin({ WEBSITE_HOSTNAME: 'pl-testing.azurewebsites.net' })).toBeUndefined();
  });

  it('lets the legacy decomposition API accept the Render address', () => {
    expect(readDecompositionConfig({ RENDER_EXTERNAL_URL: RENDER }).allowedOrigins).toContain(RENDER);
    expect(readDecompositionConfig({}).allowedOrigins).not.toContain(RENDER);
  });

  it('opens the template APIs in production to the Render address only', async () => {
    vi.stubEnv('CLIENT_ORIGIN', ''); vi.stubEnv('RENDER_EXTERNAL_URL', RENDER);
    const { experimentAccess } = await import('./decomposition/layerizeRouter.js');
    const guard = experimentAccess({ production: true });
    const call = (method: string, headers: Record<string, string>) => new Promise<number | 'next'>(resolve => {
      const res = { status: (code: number) => ({ json: () => resolve(code) }) } as unknown as Response;
      guard({ method, headers, socket: { remoteAddress: '10.0.0.7' } } as unknown as Request, res, () => resolve('next'));
    });
    expect(await call('POST', { origin: RENDER })).toBe('next');
    expect(await call('GET', { 'sec-fetch-site': 'same-origin' })).toBe('next');
    expect(await call('POST', { origin: 'http://pl-testing.onrender.com' })).toBe(403);
    expect(await call('POST', { origin: 'https://elsewhere.example' })).toBe(403);
    expect(await call('POST', {})).toBe(403);
    expect(await call('GET', { 'sec-fetch-site': 'cross-site' })).toBe(403);
  });
});

describe('the persistent data folder', () => {
  it('stays the repository\'s own artifacts folder when FRAMEFLOW_DATA_DIR is unset, and says so on Render', async () => {
    vi.stubEnv('FRAMEFLOW_DATA_DIR', '');
    const { ARTIFACTS_DIR, prepareStorage } = await import('./deployment.js');
    expect(ARTIFACTS_DIR).toBe(REPO_ARTIFACTS);
    expect(prepareStorage({})).toEqual({ dir: REPO_ARTIFACTS });
    expect(prepareStorage({ RENDER: 'true' })).toEqual({ dir: REPO_ARTIFACTS, warning: expect.stringMatching(/No persistent disk.*temporary/) });
    expect(decompositionDataDir({})).toBeUndefined();
  });

  it('holds every store and the decomposition database under FRAMEFLOW_DATA_DIR', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'frameflow-disk-')), 'frameflow');
    vi.stubEnv('FRAMEFLOW_DATA_DIR', root);
    const { ARTIFACTS_DIR, prepareStorage } = await import('./deployment.js');
    expect(ARTIFACTS_DIR).toBe(join(root, 'artifacts'));
    const stores = [
      (await import('./decomposition/protectedTemplates/store.js')).DEFAULT_PROTECTED_DIR,
      (await import('./templateStudio/store.js')).DEFAULT_STUDIO_DIR,
      (await import('./decomposition/layerizeExperiment.js')).DEFAULT_RUNS_DIR,
      (await import('./decomposition/imageTemplates.js')).DEFAULT_IMAGE_TEMPLATES_DIR,
      (await import('./decomposition/creativeTemplates/store.js')).DEFAULT_TEMPLATES_DIR,
      (await import('./decomposition/creativeTemplates/executions.js')).DEFAULT_EXECUTIONS_DIR,
      (await import('./decomposition/creativeTemplates/smartStores.js')).DEFAULT_ANALYSES_DIR,
      (await import('./decomposition/creativeTemplates/smartStores.js')).DEFAULT_VARIANTS_DIR,
    ];
    expect(stores.map(dir => dir.slice(ARTIFACTS_DIR.length + 1))).toEqual(['decomposition/protected-templates', 'template-studio', 'decomposition/layerize-experiment',
      'decomposition/image-templates', 'decomposition/creative-templates', 'decomposition/template-executions', 'decomposition/scene-analyses', 'decomposition/creative-variants']);
    expect(stores.every(dir => dir.startsWith(`${ARTIFACTS_DIR}/`))).toBe(true);
    expect(readDecompositionConfig({ FRAMEFLOW_DATA_DIR: root }).dataDir).toBe(join(root, 'data/decomposition'));
    expect(readDecompositionConfig({ FRAMEFLOW_DATA_DIR: root, DECOMP_DATA_DIR: '/elsewhere' }).dataDir).toBe('/elsewhere');
    expect(prepareStorage()).toEqual({ dir: join(root, 'artifacts') });
    expect(existsSync(join(root, 'artifacts'))).toBe(true);
  });

  it('starts without the disk it names (Render Free): the repository\'s folders, with a warning', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'frameflow-disk-')), 'not-mounted', 'frameflow');
    vi.stubEnv('FRAMEFLOW_DATA_DIR', missing);
    const { ARTIFACTS_DIR, prepareStorage } = await import('./deployment.js');
    expect(ARTIFACTS_DIR).toBe(REPO_ARTIFACTS);
    expect(prepareStorage()).toEqual({ dir: REPO_ARTIFACTS, warning: expect.stringMatching(/does not exist \(no persistent disk\).*temporary/) });
    expect(decompositionDataDir({ FRAMEFLOW_DATA_DIR: missing })).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });
});
