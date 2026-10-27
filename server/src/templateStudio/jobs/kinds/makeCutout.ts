/**
 * Make an exact product cutout from an opaque product photo, with FrameFlow's own segmenter
 * (decomposition/creativeTemplates/segmenter.ts: a SAM-3 mask, no generated pixels) and FrameFlow's cutout files
 * (variantCompose.ts cutoutFiles: the photo's own pixels with the mask as alpha). Both are used as they are.
 *
 * One explicit, paid user action per photo. The mask request is sent once and never retried; a server restart while it
 * is in flight marks it outcome_unknown (the runner's rule). fal reports no usage, so the listed price is recorded as an
 * estimate, never as a confirmed charge.
 */
import sharp from "sharp";
import { cutoutFiles, maskBox, maskRaster, sourceRaster } from "../../../decomposition/creativeTemplates/variantCompose.js";
import { ingestAsset } from "../../assets/ingest.js";
import { reserveBudget } from "../../costs/budget.js";
import { FAL_RATES, RATE_CARD_VERSION } from "../../costs/rateCard.js";
import { readStorageFile, writeStorageFile } from "../../storage.js";
import { newId, now } from "../../store.js";
import { JobStageError, type JobKindDef } from "../runner.js";

export interface MakeCutoutInput { assetId: string; label: string }

export const makeCutoutJob: JobKindDef = {
  kind: "make_cutout",
  stages: [
    {
      name: "segment",
      state: "running",
      paid: true,
      async run(ctx) {
        const input = ctx.job.inputSnapshot as MakeCutoutInput;
        const env = ctx.deps.env;
        const segmenter = ctx.deps.segmenter?.();
        if (!env || !segmenter) throw new JobStageError("not_configured", "Exact cutouts need FrameFlow's SAM-3 masks (FAL_KEY, CREATIVE_CUTOUT_PROVIDER=sam3). You can upload a transparent PNG cutout instead.");
        if (segmenter.provider !== "sam3") throw new JobStageError("cost_unbounded", `No price is configured for the ${segmenter.provider} mask provider, so its cost cannot be bounded. Use CREATIVE_CUTOUT_PROVIDER=sam3 or upload a transparent cutout.`);
        const asset = ctx.db.assets.require(input.assetId, "Product image");
        const bytes = await readStorageFile(ctx.deps.storageDir, asset.normalisedPath);
        const estimate = FAL_RATES.cutoutSam3.perRequest;
        try { reserveBudget(ctx.db, env, { jobId: ctx.job.id, jobKind: ctx.job.kind, stage: "cutout", estimateMicroUsd: estimate }); }
        catch (err) { throw new JobStageError("budget_exceeded", err instanceof Error ? err.message : String(err)); }
        const audit = (file: string, value: object) => { void writeStorageFile(ctx.deps.storageDir, `cutouts/${ctx.job.id}/${file}`, Buffer.from(JSON.stringify(value, null, 2))); };
        let result;
        try {
          result = await segmenter.segment({ image: bytes, width: asset.width, height: asset.height, targets: [{ label: input.label, box: { x: 0, y: 0, width: asset.width, height: asset.height } }] }, audit);
        } catch (err) {
          // The segmenter cannot say whether fal already started the request, so a failure is treated as possibly billed.
          throw new JobStageError("segmentation_failed", `${err instanceof Error ? err.message : String(err)} The request may have been billed; it was not repeated.`, { outcomeUnknown: true });
        }
        ctx.db.usage.insert({
          id: newId("use"), jobId: ctx.job.id, stage: "cutout", model: `fal ${segmenter.provider}`, providerRequestId: result.requestIds[0] ?? null,
          rawUsage: { requestIds: result.requestIds, priceSource: FAL_RATES.cutoutSam3.source }, rateCardVersion: RATE_CARD_VERSION,
          estimatedMicroUsd: estimate * Math.max(1, result.requestIds.length), usageDerivedMicroUsd: null, costUnknown: true, createdAt: now(),
        });
        ctx.db.reservations.updateMany((r) => r.jobId === ctx.job.id && r.stage === "cutout" && r.status === "held", () => ({ status: "settled", updatedAt: now() }));
        const raster = await sourceRaster(bytes);
        const mask = await maskRaster(result.mask, raster.width, raster.height);
        if (!maskBox(mask, raster.width, raster.height).box) throw new JobStageError("empty_mask", "SAM-3 found no product in this photo. Upload a transparent cutout instead.");
        const { subject } = await cutoutFiles(raster, mask);
        const trimmed = await sharp(subject).trim({ threshold: 1 }).png().toBuffer();
        const { asset: cutout } = await ingestAsset({ buffer: trimmed, role: "cutout", filename: `${input.label}-cutout.png`, label: `${input.label} (cutout)` }, { db: ctx.db, storageDir: ctx.deps.storageDir });
        return { cutoutAssetId: cutout.id, sourceAssetId: asset.id, requestIds: result.requestIds };
      },
    },
  ],
  finish(outputs) {
    return { state: "complete", result: outputs.segment };
  },
};
