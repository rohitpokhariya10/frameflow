import { createHash, randomUUID } from 'node:crypto';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeTemplateSlots, PLAN_RULES, promptContradictions, type TemplateExecution, type TemplateVersion } from '@frameflow/shared';
import { createLayerizeRouter } from '../layerizeRouter.js';
import type { GenerationConfig } from '../generationGroups.js';
import { imagesClient } from './variantTestKit.js';

// The data this app already saved, opened by this code: a copy of the main checkout's artifacts (templates, sessions,
// image analyses and plans, and the decomposition runs the sessions use), made with copy-on-write clones so the originals
// are never touched. Every AI provider is a fake that fails the test when called: opening old data costs nothing.
// Skipped unless FRAMEFLOW_REPLAY_ARTIFACTS names that artifacts folder.
const replay = process.env.FRAMEFLOW_REPLAY_ARTIFACTS;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]);
const fingerprint = (root: string) => new Map(files(root).map(f => [relative(root, f), sha(readFileSync(f))]));
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe.skipIf(!replay)('the data you already saved, opened by this code (a clone of your artifacts; no provider call)', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'saved-data-')), calls: string[] = [];
  const dirs = { templates: join(root, 'creative-templates'), executions: join(root, 'template-executions'), analyses: join(root, 'scene-analyses'), runs: join(root, 'runs') };
  /** The image model: refused (counted) unless a test lends it an offline fake. */
  let imageModel: GenerationConfig | undefined;
  const refuse = (what: string) => async (): Promise<never> => { calls.push(what); throw new Error(`${what}: no provider call is allowed while opening saved data`); };
  let base = '', server: ReturnType<ReturnType<typeof express>['listen']>, before: Map<string, string>;
  const saved = { executions: [] as TemplateExecution[], templates: [] as string[], analyses: [] as string[] };

  beforeAll(async () => {
    const clone = (from: string, to: string) => cpSync(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
    for (const name of ['creative-templates', 'template-executions', 'scene-analyses'] as const) clone(join(replay!, name), join(root, name));
    saved.executions = readdirSync(dirs.executions).filter(d => existsSync(join(dirs.executions, d, 'execution.json'))).map(d => json(join(dirs.executions, d, 'execution.json')));
    saved.templates = readdirSync(dirs.templates).filter(d => existsSync(join(dirs.templates, d, 'template.json')));
    saved.analyses = readdirSync(dirs.analyses).filter(d => existsSync(join(dirs.analyses, d, 'analysis.json')));
    // Only the decomposition runs the sessions and templates use (the run folder holds every other experiment too).
    const runIds = new Set([...saved.executions.map(e => e.runId), ...saved.templates.flatMap(t => readdirSync(join(dirs.templates, t)).filter(f => /^v\d+\.json$/.test(f)).map(f => json(join(dirs.templates, t, f)).source?.runId))]
      .filter((id): id is string => !!id && existsSync(join(replay!, 'layerize-experiment', id))));
    mkdirSync(dirs.runs);
    for (const id of runIds) clone(join(replay!, 'layerize-experiment', id), join(dirs.runs, id));
    before = fingerprint(root);
    const router = createLayerizeRouter({ runsDir: dirs.runs, templatesDir: dirs.templates, executionsDir: dirs.executions, imageTemplatesDir: join(root, 'image-templates'),
      deps: () => { calls.push('decomposition'); throw new Error('decomposition: no provider call is allowed while opening saved data'); },
      generation: () => { if (imageModel) return imageModel; calls.push('image'); throw new Error('image: no provider call is allowed while opening saved data'); },
      inspector: () => ({ model: 'gpt-5.6-luna', inspect: refuse('structure inspection') }), imagePrompt: () => { calls.push('image prompt'); throw new Error('no call'); },
      smart: { analysesDir: dirs.analyses, variantsDir: join(root, 'creative-variants'), env: {},
        analyzer: () => ({ model: 'gpt-5.6-sol', analyze: refuse('scene analysis') }), resolver: () => ({ model: 'gpt-5.6-sol', resolve: refuse('change resolution') }),
        verifier: () => ({ model: 'gpt-5.6-sol', verify: refuse('AI check') }), concepts: () => ({ model: 'gpt-5.6-sol', write: refuse('scene concepts') }), segmenter: () => undefined } });
    server = express().use('/x', router).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  });
  afterAll(() => { server?.close(); });
  const get = async (path: string) => { const res = await fetch(`${base}${path}`); return { status: res.status, type: res.headers.get('content-type') ?? '', body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }; };

  const deleted = (id: string) => json(join(dirs.templates, id, 'template.json')).status === 'deleted';
  /** A template you deleted later, restored in the copy only, to reuse what was saved with it. */
  const restore = (id: string) => { const file = join(dirs.templates, id, 'template.json'); writeFileSync(file, JSON.stringify({ ...json(file), status: 'active' }, null, 2)); };
  /** A session that was still working when the server stopped is shown as interrupted (resumable), as before. */
  const shownState = (e: TemplateExecution) => ['done', 'failed', 'ready', 'generated'].includes(e.state) ? e.state : 'failed';

  it('every saved template and version opens, with its fields and thumbnail; a deleted one stays out of the list', async () => {
    expect(saved.templates.length).toBeGreaterThan(0);
    const list = (await get('/templates')).body as { templates: { id: string }[] };
    expect(list.templates.map(t => t.id).sort()).toEqual(saved.templates.filter(id => !deleted(id)).sort());
    for (const id of saved.templates) {
      const template = await get(`/templates/${id}`);
      expect(template.status, id).toBe(deleted(id) ? 404 : 200);
      if (deleted(id)) continue;
      for (const file of readdirSync(join(dirs.templates, id)).filter(f => /^v\d+\.json$/.test(f))) {
        const version = await get(`/templates/${id}/versions/${file.match(/\d+/)![0]}`);
        expect(version.status, `${id} ${file}`).toBe(200);
        const v = version.body as TemplateVersion;
        expect(v.structure.layers.length, `${id} ${file}`).toBeGreaterThan(0);
        expect(describeTemplateSlots(v).length, `${id} ${file}: its fields`).toBeGreaterThan(0);
      }
      const thumbnail = await get(`/templates/${id}/thumbnail`);
      expect([thumbnail.status, thumbnail.type.startsWith('image/')], id).toEqual([200, true]);
    }
    expect(calls).toEqual([]);
  });

  it('every saved session opens in the state it was saved in, with its images and its decomposition run', async () => {
    expect(saved.executions.length).toBeGreaterThan(0);
    const list = (await get('/template-executions')).body as { executions: TemplateExecution[] };
    expect(list.executions.map(e => e.id).sort()).toEqual(saved.executions.map(e => e.id).sort());
    for (const e of saved.executions) {
      const shown = await get(`/template-executions/${e.id}`), now = shown.body as TemplateExecution;
      expect(shown.status, e.id).toBe(200);
      expect([now.mode, now.state, now.runId, now.template?.id], e.id).toEqual([e.mode, shownState(e), e.runId, e.template?.id]);
      if (shownState(e) !== e.state) expect(now.error, e.id).toMatchObject({ code: 'INTERRUPTED', state: e.state });
      const upload = await get(`/template-executions/${e.id}/images/upload`);
      expect([upload.status, upload.type.startsWith('image/')], `${e.id} upload`).toEqual([200, true]);
      if (e.edit?.image) {
        const edited = await get(`/template-executions/${e.id}/images/edited`), meta = await sharp(edited.body as Buffer).metadata();
        expect([edited.status, meta.width, meta.height], `${e.id} edited image`).toEqual([200, e.edit.image.width, e.edit.image.height]);
      }
      if (e.runId && existsSync(join(dirs.runs, e.runId))) {
        const run = await get(`/runs/${e.runId}`);
        expect(run.status, `${e.id} run`).toBe(200);
        if (e.state === 'done') expect((run.body as { stage: string }).stage, `${e.id} run`).toBe('done');
      }
    }
    expect(calls).toEqual([]);
  });

  it('a saved image analysis opens and is found again by its image\'s hash and template, with no call (a deleted template\'s, only once restored)', async () => {
    const ready = saved.analyses.map(id => json(join(dirs.analyses, id, 'analysis.json'))).filter(a => a.state === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    for (const a of ready) {
      const lookup = () => get(`/scene-analyses/lookup?imageSha256=${a.binding.imageSha256}&templateId=${a.binding.templateId}&templateVersion=${a.binding.templateVersion}`);
      if (deleted(a.binding.templateId)) expect(((await lookup()).body as { error: { code: string } }).error.code, a.id).toBe('TEMPLATE_NOT_FOUND');
      else expect(((await lookup()).body as { analysis: { id: string } | null }).analysis?.id, a.id).toBe(a.id);
      const opened = (await get(`/scene-analyses/${a.id}`)).body as { state: string; scene: { objects: unknown[] } };
      expect([opened.state, opened.scene.objects.length > 0], a.id).toEqual(['ready', true]);
    }
    for (const id of saved.analyses.filter(id => json(join(dirs.analyses, id, 'analysis.json')).state !== 'ready')) expect(((await get(`/scene-analyses/${id}`)).body as { state: string }).state, id).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('opening everything changed nothing that was saved', () => {
    const after = fingerprint(root);
    const changed = [...before].filter(([file, hash]) => after.get(file) !== hash).map(([file]) => file);
    expect(changed).toEqual([]);
  });

  it('a plan saved before the plan rules existed still generates (its prompt compiles the same), and resolving it again rebuilds it from what was saved, with no call', async () => {
    const withPlan = saved.executions.filter(e => e.resolution?.id && e.resolution.analysisId && existsSync(join(dirs.analyses, e.resolution.analysisId, 'resolutions', `${e.resolution.id}.json`)));
    if (!withPlan.length) return;
    const e = withPlan[0], old = json(join(dirs.analyses, e.resolution!.analysisId, 'resolutions', `${e.resolution!.id}.json`));
    expect(old.rules).toBeUndefined();
    if (deleted(e.template!.id)) restore(e.template!.id);
    const binding = json(join(dirs.analyses, e.resolution!.analysisId, 'analysis.json')).binding;
    expect(((await get(`/scene-analyses/lookup?imageSha256=${binding.imageSha256}&templateId=${binding.templateId}&templateVersion=${binding.templateVersion}`)).body as { analysis: { id: string } }).analysis.id).toBe(e.resolution!.analysisId);
    const analysis = json(join(dirs.analyses, e.resolution!.analysisId, 'analysis.json'));
    const form = new FormData();
    // Later sessions may have finished this same upload with another template; the fit warning that then raises is answered
    // as the wizard's "use anyway" does, since this checks the old plan, not the fit.
    for (const [k, v] of Object.entries({ mode: 'REUSE_TEMPLATE_WITH_EDIT', idempotencyKey: randomUUID(), templateId: e.template!.id, templateVersion: String(e.template!.version), reviewBeforeDecompose: 'true', allowMismatch: 'true',
      analysisId: e.resolution!.analysisId, resolutionId: e.resolution!.id, draft: JSON.stringify(old.draft) })) form.append(k, v);
    form.append('image', new Blob([new Uint8Array(readFileSync(join(dirs.analyses, analysis.id, analysis.upload.file)))], { type: analysis.upload.mimeType }), analysis.upload.originalName);
    const res = await fetch(`${base}/template-executions`, { method: 'POST', body: form }), started = await res.json() as TemplateExecution;
    expect(res.status, JSON.stringify(started)).toBe(202);
    let now = started;
    for (let i = 0; i < 200 && !['generated', 'failed', 'done'].includes(now.state); i++) { await new Promise(done => setTimeout(done, 25)); now = (await get(`/template-executions/${started.id}`)).body as TemplateExecution; }
    expect(now.state, JSON.stringify(now.error)).toBe('generated');
    expect(now.edit).toMatchObject({ original: true });
    expect(now.edit!.image).toMatchObject({ width: analysis.upload.width, height: analysis.upload.height });
    // Reopened, the plan lacks the current rules, so the wizard resolves the same changes again: the old plan is rebuilt
    // under the current rules from what was saved (its resolver answer, if any), as a new record linked to it. No call.
    const again = new FormData();
    again.append('draft', JSON.stringify(old.draft));
    const answer = await fetch(`${base}/scene-analyses/${analysis.id}/resolutions`, { method: 'POST', body: again }), rebuilt = await answer.json();
    expect(answer.status, JSON.stringify(rebuilt)).toBe(201);
    expect(rebuilt).toMatchObject({ state: 'ready', rules: PLAN_RULES, resolver: { reusedFrom: old.id }, plan: { status: old.plan.status } });
    expect(rebuilt.id).not.toBe(old.id);
    expect(json(join(dirs.analyses, analysis.id, 'resolutions', `${old.id}.json`))).toEqual(old); // the old record stays, for the sessions that used it
    const scene = (await get(`/scene-analyses/${analysis.id}`)).body as { scene: Parameters<typeof promptContradictions>[0] };
    expect(promptContradictions(scene.scene, rebuilt.plan, rebuilt.prompt)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a request in the format the previous version of the app sent is still accepted (no new fields)', async () => {
    const e = saved.executions.find(x => x.mode === 'REUSE_TEMPLATE_WITH_EDIT' && x.template && !deleted(x.template.id) && existsSync(join(dirs.executions, x.id, x.upload.file)))!;
    const version = (await get(`/templates/${e.template!.id}/versions/${e.template!.version}`)).body as TemplateVersion;
    const background = describeTemplateSlots(version).find(s => s.role === 'background');
    if (!background) return;
    const fake = imagesClient('obeys-mask');
    imageModel = { model: 'gpt-image-2', client: () => fake.client as never } as GenerationConfig;
    try {
      // The previous app's fields only: no regenerateUnchanged, no textDecisions; a background change only (no product replaced).
      const form = new FormData();
      for (const [k, v] of Object.entries({ mode: 'REUSE_TEMPLATE_WITH_EDIT', idempotencyKey: randomUUID(), templateId: e.template!.id, templateVersion: String(e.template!.version), reviewBeforeDecompose: 'true',
        values: JSON.stringify({ [background.id]: 'a sunlit kitchen with pale wood' }), options: JSON.stringify({}) })) form.append(k, v);
      form.append('image', new Blob([new Uint8Array(readFileSync(join(dirs.executions, e.id, e.upload.file)))], { type: e.upload.mimeType }), e.upload.originalName ?? 'creative.png');
      const res = await fetch(`${base}/template-executions`, { method: 'POST', body: form }), started = await res.json() as TemplateExecution;
      expect(res.status, JSON.stringify(started)).toBe(202);
      let now = started;
      for (let i = 0; i < 400 && !['generated', 'failed', 'done'].includes(now.state); i++) { await new Promise(done => setTimeout(done, 25)); now = (await get(`/template-executions/${started.id}`)).body as TemplateExecution; }
      expect(now.state, JSON.stringify(now.error)).toBe('generated');
      expect(fake.requests).toHaveLength(1); // the offline fake, never a paid call
      const meta = await sharp(readFileSync(join(dirs.executions, e.id, e.upload.file))).metadata();
      expect(now.edit!.image).toMatchObject({ width: meta.width, height: meta.height });
      expect(statSync(join(dirs.executions, now.id, 'execution.json')).isFile()).toBe(true);
    } finally { imageModel = undefined; }
    expect(calls).toEqual([]);
  });
});
