import type { StudioStyleProfile, StudioTemplate } from "@frameflow/shared";
import type { ServerEnv } from "../config.js";
import { costSummary } from "../costs/summary.js";
import type { StudioStore as Db } from "../store.js";
import type { templateView } from "./service.js";

type View = NonNullable<ReturnType<typeof templateView>>;

export function toTemplateDto(db: Db, env: ServerEnv, view: View): StudioTemplate {
  const { template, profile, status, latestJob, usage } = view;
  const campaigns = new Set(db.campaigns.filter((c) => c.templateId === template.id).map((c) => c.id));
  return {
    id: template.id,
    name: template.name,
    guidance: template.creatorGuidance,
    status,
    brandKit: (() => {
      const kit = db.brandKits.get(template.brandKitId);
      return kit ? { id: kit.id, name: kit.name } : null;
    })(),
    references: [...template.references]
      .sort((a, b) => a.position - b.position)
      .map((r) => {
        const asset = db.assets.get(r.assetId);
        return {
          assetId: r.assetId,
          refId: `ref${r.position + 1}`,
          thumb: `/api/template-studio/assets/${r.assetId}?variant=thumb`,
          full: `/api/template-studio/assets/${r.assetId}?variant=normalised`,
          width: asset?.width ?? 0,
          height: asset?.height ?? 0,
        };
      }),
    profile: profile
      ? {
          id: profile.id,
          version: profile.version,
          model: profile.analysisModel,
          promptVersion: profile.promptVersion,
          createdAt: profile.createdAt,
          selectedClusterId: profile.selectedClusterId,
          cached: profile.cached,
          data: profile.profile as StudioStyleProfile,
        }
      : null,
    versions: db.profiles
      .filter((p) => p.templateId === template.id)
      .sort((a, b) => b.version - a.version)
      .map((p) => ({ id: p.id, version: p.version, createdAt: p.createdAt })),
    latestJob: latestJob ? { id: latestJob.id, state: latestJob.state, error: latestJob.error, createdAt: latestJob.createdAt } : null,
    analysisCost: costSummary(usage, env),
    posterCount: db.posters.count((p) => campaigns.has(p.campaignId)),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

export type TemplateDto = StudioTemplate;
