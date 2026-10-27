/**
 * Template Studio configuration (Generator env.ts), read from the server's environment. The Generator's names are kept on
 * the parsed object so the ported pipeline reads the same fields; the environment variables carry a STUDIO_ prefix so they
 * never change FrameFlow's own decomposition models (OPENAI_IMAGE_MODEL, OPENAI_DECOMPOSITION_MODEL…).
 *
 * Rupees use FrameFlow's one configured rate (AI_BUDGET_USD_INR, the same one the decomposition dashboard uses), never a
 * live exchange rate: budgets and caps are enforced in USD, the rate is display only and is stated wherever it is used.
 */
import { z } from 'zod';
import { AI_PRICING, budgetFx, type StudioFx } from '@frameflow/shared';
import { DEFAULT_STUDIO_DIR } from './store.js';
import { join } from 'node:path';

const usd = z.coerce.number().finite().min(0).max(1000);
const optionalKey = z.string().trim().optional().transform(v => (v ? v : undefined));
const schema = z.object({
  OPENAI_API_KEY: optionalKey,
  STUDIO_ANALYSIS_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
  STUDIO_PLANNER_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
  STUDIO_REVIEW_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
  STUDIO_IMAGE_MODEL: z.string().trim().min(1).default('gpt-image-2'),
  /** Reasoning tokens are billed as output; low keeps analysis and planning cheap. */
  STUDIO_TEXT_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).default('low'),
  STUDIO_IMAGE_QUALITY: z.enum(['low', 'medium', 'high']).default('high'),
  STUDIO_MAX_JOB_BUDGET_USD: usd.default(1),
  /** Cap for creating one template (reference analysis). */
  STUDIO_MAX_TEMPLATE_BUDGET_USD: usd.default(1),
  STUDIO_DAILY_BUDGET_USD: usd.default(5),
  TEMPLATE_STUDIO_DIR: z.string().trim().optional(),
  AI_BUDGET_USD_INR: z.string().optional(),
});

export interface ServerEnv {
  OPENAI_API_KEY: string | undefined;
  OPENAI_ANALYSIS_MODEL: string; OPENAI_PLANNER_MODEL: string; OPENAI_REVIEW_MODEL: string; OPENAI_IMAGE_MODEL: string;
  OPENAI_TEXT_REASONING_EFFORT: 'none' | 'low' | 'medium' | 'high';
  IMAGE_QUALITY: 'low' | 'medium' | 'high';
  /** One image request per job, never an automatic second one (Generator default). */
  MAX_IMAGE_ATTEMPTS_PER_JOB: 1;
  MAX_JOB_BUDGET_USD: number; MAX_TEMPLATE_BUDGET_USD: number; DAILY_BUDGET_USD: number;
  USD_INR_RATE: number;
  fx: StudioFx;
  dataDir: string; assetStorageDir: string;
}

export class EnvConfigError extends Error {
  constructor(public readonly issues: string[]) { super(`Invalid Template Studio configuration:\n- ${issues.join('\n- ')}`); this.name = 'EnvConfigError'; }
}

export function parseStudioEnv(source: Record<string, string | undefined> = process.env, dataDir?: string): ServerEnv {
  const emptyBudgets = ['STUDIO_MAX_JOB_BUDGET_USD', 'STUDIO_MAX_TEMPLATE_BUDGET_USD', 'STUDIO_DAILY_BUDGET_USD'].filter(k => source[k] !== undefined && !source[k]!.trim());
  if (emptyBudgets.length) throw new EnvConfigError(emptyBudgets.map(k => `${k}: enter a non-negative USD amount, or remove the variable to use its default.`));
  const cleaned = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === '' ? undefined : v]));
  const result = schema.safeParse(cleaned);
  if (!result.success) throw new EnvConfigError(result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const e = result.data, dir = dataDir ?? e.TEMPLATE_STUDIO_DIR ?? DEFAULT_STUDIO_DIR, rate = budgetFx(e.AI_BUDGET_USD_INR);
  return {
    OPENAI_API_KEY: e.OPENAI_API_KEY,
    OPENAI_ANALYSIS_MODEL: e.STUDIO_ANALYSIS_MODEL, OPENAI_PLANNER_MODEL: e.STUDIO_PLANNER_MODEL, OPENAI_REVIEW_MODEL: e.STUDIO_REVIEW_MODEL, OPENAI_IMAGE_MODEL: e.STUDIO_IMAGE_MODEL,
    OPENAI_TEXT_REASONING_EFFORT: e.STUDIO_TEXT_REASONING_EFFORT, IMAGE_QUALITY: e.STUDIO_IMAGE_QUALITY, MAX_IMAGE_ATTEMPTS_PER_JOB: 1,
    MAX_JOB_BUDGET_USD: e.STUDIO_MAX_JOB_BUDGET_USD, MAX_TEMPLATE_BUDGET_USD: e.STUDIO_MAX_TEMPLATE_BUDGET_USD, DAILY_BUDGET_USD: e.STUDIO_DAILY_BUDGET_USD,
    USD_INR_RATE: rate,
    fx: {
      rate, source: 'configured', variable: 'AI_BUDGET_USD_INR', pricingVersion: AI_PRICING.version,
      note: e.AI_BUDGET_USD_INR ? `₹${rate}/$ from AI_BUDGET_USD_INR (configured on the server).` : `₹${rate}/$, FrameFlow's default planning rate (pricing ${AI_PRICING.version}); set AI_BUDGET_USD_INR to change it.`,
    },
    dataDir: dir, assetStorageDir: join(dir, 'files'),
  };
}

/** Safe, secret-free view of the configuration for the Setup screen. */
export function describeConfig(env: ServerEnv) {
  return {
    apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
    models: { analysis: env.OPENAI_ANALYSIS_MODEL, planner: env.OPENAI_PLANNER_MODEL, review: env.OPENAI_REVIEW_MODEL, image: env.OPENAI_IMAGE_MODEL },
    textReasoningEffort: env.OPENAI_TEXT_REASONING_EFFORT, imageQuality: env.IMAGE_QUALITY, maxImageAttemptsPerJob: env.MAX_IMAGE_ATTEMPTS_PER_JOB,
    maxJobBudgetUsd: env.MAX_JOB_BUDGET_USD, maxTemplateBudgetUsd: env.MAX_TEMPLATE_BUDGET_USD, dailyBudgetUsd: env.DAILY_BUDGET_USD,
    fx: env.fx,
    variables: ['OPENAI_API_KEY', 'STUDIO_ANALYSIS_MODEL', 'STUDIO_PLANNER_MODEL', 'STUDIO_REVIEW_MODEL', 'STUDIO_IMAGE_MODEL', 'STUDIO_TEXT_REASONING_EFFORT', 'STUDIO_IMAGE_QUALITY', 'STUDIO_MAX_JOB_BUDGET_USD', 'STUDIO_MAX_TEMPLATE_BUDGET_USD', 'STUDIO_DAILY_BUDGET_USD', 'TEMPLATE_STUDIO_DIR', 'AI_BUDGET_USD_INR'],
  };
}
