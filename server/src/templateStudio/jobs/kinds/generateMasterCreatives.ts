import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { MATCHED_EDGE_NOTE, type CreativeAsset, type MasterAiBatch } from '@frameflow/shared';
import { structuredCall } from '../../ai/calls.js';
import { acceptOptions, checkMasterPlan, creativeIdOf, creativeOfPlan, masterPlanSchema, MASTER_RECIPE_VERSION, reviewVariation, type PlanVariation } from '../../masterCreatives/plan.js';
import { planContext, recipeFileOf, type MasterAiJobInput } from '../../masterCreatives/service.js';
import { deriveArtwork, matchBacking } from '../../../decomposition/protectedTemplates/master/artwork.js';
import { renderMasterCreative } from '../../masterCreatives/render.js';
import type { ProtectedStore } from '../../../decomposition/protectedTemplates/store.js';
import { JobStageError, type JobKindDef } from '../runner.js';

/** The design stage's saved output: the options to build, and those the AI proposed that failed the checks. */
interface DesignOutput { variations: PlanVariation[]; skipped: MasterAiBatch['skipped']; corrected: boolean }
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const requestImage = (bytes: Buffer) => sharp(bytes).resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
/** The master's saved files and their local analysis; a failure here is reported as such, never as an uncertain paid call. */
async function prepared(store: ProtectedStore, input: MasterAiJobInput) {
  try {
    const source = store.read(input.masterId, input.sourceFile);
    if (sha256(source) !== input.sourceSha256) return { changed: true as const };
    return { changed: false as const, source, ...(await planContext(store, input.snapshot, input.options, input.canvas, input.readiness?.missingText ?? [])) };
  } catch (e) {
    throw new JobStageError('master_unavailable', 'The template’s saved files could not be read. Nothing was sent to the AI.', { detail: e instanceof Error ? e.message : String(e) });
  }
}

export const generateMasterCreativesJob: JobKindDef = {
  kind: 'generate_master_creatives',
  stages: [
    { name: 'design_master_creatives', state: 'planning', paid: true, async run(ctx) {
      const input = ctx.job.inputSnapshot as MasterAiJobInput, store = ctx.deps.protectedStore?.(), env = ctx.deps.env, provider = ctx.deps.provider;
      if (!store || !env || !provider) throw new JobStageError('not_configured', 'AI creative generation is not configured.');
      const p = await prepared(store, input);
      if (p.changed) throw new JobStageError('source_changed', 'The saved source changed.');
      const req = input.request, images = [await requestImage(p.source), ...(req.images > 1 && p.artworkImage ? [p.artworkImage] : [])];
      const boundedEnv = { ...env, MAX_JOB_BUDGET_USD: Math.min(env.MAX_JOB_BUDGET_USD, input.approvedMaxUsd) };
      try {
        const result = await structuredCall({ db: ctx.db, env: boundedEnv, provider, job: ctx.job }, { key: 'master-design', request: {
          model: input.model, system: req.system, schema: masterPlanSchema, schemaName: req.schemaName, maxOutputTokens: req.maxOutputTokens, reasoningEffort: input.reasoningEffort,
          content: [{ type: 'text', text: req.text }, ...images.map(data => ({ type: 'image' as const, data, mime: 'image/png', width: 1024, height: 1024, detail: 'low' as const }))],
        }, check: data => checkMasterPlan(data, p.ctx) });
        return { variations: result.data.variations, skipped: [], corrected: result.repaired } satisfies DesignOutput;
      } catch (e) {
        if (!(e instanceof JobStageError) || e.code !== 'invalid_output') throw e;
        // Both answers were paid for. Keep the options of the better one that pass every check and report the rest;
        // with none left the job fails honestly. Nothing is asked again.
        const answers = ['master-design:repair', 'master-design'].map(stage => ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === stage)?.response?.text ?? null)
          .map(text => { try { return text ? JSON.parse(text) as unknown : null; } catch { return null; } });
        const best = answers.map(a => acceptOptions(a, p.ctx)).sort((a, b) => b.variations.length - a.variations.length)[0];
        if (!best?.variations.length) throw e;
        const missing = input.options.count - best.variations.length - best.skipped.length;
        return { variations: best.variations, skipped: [...best.skipped, ...(missing > 0 ? [{ name: null, reason: `The AI returned ${missing} design${missing === 1 ? '' : 's'} fewer than requested.` }] : [])], corrected: true } satisfies DesignOutput;
      }
    } },
    { name: 'save_master_creatives', state: 'composing', paid: false, async run(ctx) {
      const input = ctx.job.inputSnapshot as MasterAiJobInput, store = ctx.deps.protectedStore?.();
      if (!store) throw new JobStageError('not_configured', 'The master store is not available.');
      const design = ctx.outputs.design_master_creatives as DesignOutput, p = await prepared(store, input);
      if (p.changed) throw new JobStageError('source_changed', 'The saved source changed.');
      const background = store.read(input.masterId, input.snapshot.background.file), provider = ctx.deps.provider?.offline ? 'offline-mock' as const : input.provider ?? 'openai';
      const skipped = [...design.skipped], creativeIds: string[] = [], built: { file: string; json: Buffer; files: { name: string; bytes: Buffer }[] }[] = [];
      const excluded = [...(input.readiness?.excluded ?? []).map(e => `Left out: ${e.label} (${e.reason}).`),
        ...(input.readiness?.missingText ?? []).filter(m => m.inBackground).map(m => `“${m.text}” is part of the background picture, not editable text.`)];
      for (const [index, designed] of design.variations.entries()) {
        const cid = creativeIdOf(ctx.job.id, index), file = `creative-${cid}.json`;
        // A resumed save never overwrites a creative (or its edits) saved before the server stopped.
        if (store.has(input.masterId, file)) { creativeIds.push(cid); continue; }
        try {
          const v = designed, hard = reviewVariation(v, p.ctx).filter(i => !i.soft);
          if (hard.length) throw new Error(hard[0].text);
          const files: { name: string; bytes: Buffer }[] = [];
          const stored = async (tag: string, png: Buffer, originalName: string): Promise<Extract<CreativeAsset, { kind: 'creative' }>> => {
            const sha = sha256(png), name = `cra-${cid.slice(3)}-${tag}-${sha.slice(0, 10)}.png`, meta = await sharp(png).metadata();
            files.push({ name, bytes: png });
            return { kind: 'creative', file: name, sha256: sha, width: meta.width ?? 1, height: meta.height ?? 1, originalName };
          };
          let artwork = null;
          // The master's own artwork, whole, its field tinted; logos whose edge is that field follow the tint.
          const art = p.ctx.artwork?.grounds.length ? p.ctx.artwork : null;
          if (art) {
            const d = await deriveArtwork(background, art, input.canvas, 'center', v.field, 'contain');
            artwork = { asset: await stored('art', d.png, d.recoloured ? 'Template artwork (recoloured)' : 'Template artwork'), box: d.box };
          }
          const backings = new Map<string, Extract<CreativeAsset, { kind: 'creative' }>>();
          for (const [i, slot] of p.ctx.content.slots.entries()) {
            if (!art || !p.ctx.edges.find(e => e.slotId === slot.id)?.fieldBacked) continue;
            const matched = await matchBacking(store.read(input.masterId, slot.replacement?.file ?? slot.original.file), art, v.field);
            if (matched) backings.set(slot.id, await stored(`logo${i}`, matched, `${slot.label} (${MATCHED_EDGE_NOTE})`));
          }
          const creative = creativeOfPlan(input.snapshot, v, { jobId: ctx.job.id, index, at: ctx.job.createdAt, canvas: input.canvas, formatId: input.options.formatId, count: input.options.count, model: input.model, provider, artwork, backings, notes: excluded }, p.ctx);
          // Rendered from the same editable objects before anything is published.
          files.push({ name: creative.generation!.previewFile, bytes: await renderMasterCreative(creative, store, new Map(files.map(f => [f.name, f.bytes]))) });
          built.push({ file, json: Buffer.from(JSON.stringify(creative, null, 2)), files });
          creativeIds.push(cid);
        } catch (e) {
          skipped.push({ name: designed.name, reason: e instanceof Error ? e.message : 'The design could not be built.' });
        }
      }
      if (!creativeIds.length) throw new JobStageError('invalid_output', 'None of the AI designs passed the layout checks, so nothing was saved. Existing creatives are unchanged.', { detail: skipped.map(s => s.reason).slice(0, 5).join(' · ') });
      const usage = ctx.db.usage.filter(u => u.jobId === ctx.job.id);
      store.write(input.masterId, recipeFileOf(ctx.job.id), Buffer.from(JSON.stringify({ version: MASTER_RECIPE_VERSION, provider, jobId: ctx.job.id, input, plan: { variations: design.variations }, corrected: design.corrected, usage,
        requestedCount: input.options.count, completedCount: creativeIds.length, creativeIds, skipped, createdAt: ctx.job.createdAt }, null, 2)));
      for (const b of built) {
        for (const f of b.files) store.write(input.masterId, f.name, f.bytes);
        store.write(input.masterId, b.file, b.json);
      }
      return { creativeIds, skipped, provider, requested: input.options.count };
    } },
  ],
  finish: outputs => ({ state: 'complete', result: outputs.save_master_creatives }),
};
