import type { StudioCostLine, StudioCostSummary } from "@frameflow/shared";
import type { ServerEnv } from "../config.js";
import type { UsageLedgerRecord } from "../store.js";
import { describeMoney } from "./profiles.js";
import { RATE_CARD_VERSION } from "./rateCard.js";

/** What each usage-ledger key paid for, in the words the cost tables use. */
export function usageLabel(stage: string): string {
  const base = stage.split(":")[0];
  const suffix = stage.endsWith(":repair") ? " (structure repair)" : stage.endsWith(":retry") ? " (second attempt)" : "";
  const label =
    base === "analyse_references" ? "Reference / template analysis"
      : base === "subject" ? "Product analysis"
        : base === "plan" ? "AI composition planning"
          : base === "generate_scene" ? "Image generation"
            : base === "review" ? "Image review"
              : base === "cutout" ? "Exact product cutout (SAM-3 mask)"
                : stage;
  return label + suffix;
}

/**
 * Recorded spend for a set of usage rows. A call whose provider usage could not be read counts at its reserved
 * upper-bound estimate and is flagged; it is never shown as free.
 */
export function costSummary(rows: UsageLedgerRecord[], env: Pick<ServerEnv, "USD_INR_RATE" | "fx">): StudioCostSummary {
  const money = (m: number) => describeMoney(m, env);
  const derived = rows.reduce((s, u) => s + (u.usageDerivedMicroUsd ?? 0), 0);
  const estimateOnly = rows.reduce((s, u) => s + (u.usageDerivedMicroUsd === null ? (u.estimatedMicroUsd ?? 0) : 0), 0);
  const lines: StudioCostLine[] = [...rows]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((u) => ({
      stage: u.stage,
      label: usageLabel(u.stage),
      model: u.model,
      providerRequestId: u.providerRequestId,
      status: u.usageDerivedMicroUsd === null ? "estimate_only" : "usage_derived",
      estimated: u.estimatedMicroUsd === null ? null : money(u.estimatedMicroUsd),
      recorded: u.usageDerivedMicroUsd === null ? null : money(u.usageDerivedMicroUsd),
      at: u.createdAt,
    }));
  return {
    total: money(derived + estimateOnly),
    usageDerived: money(derived),
    estimatedOnly: money(estimateOnly),
    calls: rows.length,
    unknownCalls: rows.filter((u) => u.costUnknown).length,
    lines,
    fx: env.fx,
    rateCardVersion: rows[0]?.rateCardVersion ?? RATE_CARD_VERSION,
  };
}
