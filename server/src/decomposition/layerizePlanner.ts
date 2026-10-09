/**
 * The GPT decomposition planner. Looks at the actual image and returns its semantic analysis (semanticPlanner.ts) with
 * structured JSON output; the protected plan built from it is the prompt sent to Seedream (the endpoint has a single
 * `prompt` field, no negative prompt). A template-creating run asks the same call for its template capture as well.
 * Any refusal, incomplete output, invalid JSON or over-long prompt is a PlannerError, and the caller must not call
 * Seedream. The model is configurable and never silently substituted.
 */
import OpenAI from 'openai';
import { SEMANTIC_INSTRUCTION, SEMANTIC_SCHEMA, semanticPlan, splitTemplateCapture, TEMPLATE_CAPTURE_INSTRUCTION, TEMPLATE_CAPTURE_SCHEMA, type SemanticAnalysis, type SemanticProtection, type TemplateCapture } from './semanticPlanner.js';
import { DEFAULT_DECOMPOSITION_PLANNER_MODEL } from './aiModels.js';
import { openAIFailureSummary, openAIRequestDiagnostics, type OpenAIRequestDiagnostics } from '../services/openAIRequestDiagnostics.js';

/** Seedream's prompt limit as this app enforces it locally. */
export const MAX_LAYERIZE_PROMPT = 2000;

export type PlannedLayer = { name: string; description: string };
export type LayerizePlan = { prompt: string; planned_layers: PlannedLayer[]; warnings: string[]; semantic_analysis?: SemanticAnalysis; semantic_protection?: SemanticProtection };
export type PlannerUsage = { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; total_tokens?: number };
export type PlannerResult = { plan: LayerizePlan; model: string; responseId?: string; usage?: PlannerUsage; raw: unknown; request: Record<string, unknown>; capture?: TemplateCapture };
/** templateCapture: the run creates a template; the same call also returns its roles, name and description. */
export type PlannerContext = { templateCapture?: boolean };
export type Planner = (image: Buffer, mime: string, context?: PlannerContext) => Promise<PlannerResult>;

export class PlannerError extends Error {
  constructor(public readonly code: string, message: string, public readonly raw?: unknown, public readonly diagnostics?: OpenAIRequestDiagnostics) { super(message); this.name = 'PlannerError'; }
}

/** Validates a plan and the local prompt limit. Never truncates. */
export function validatePlan(value: unknown): LayerizePlan {
  const v = value as Partial<LayerizePlan> | null;
  const strings = (a: unknown) => Array.isArray(a) && a.every(s => typeof s === 'string');
  if (!v || typeof v !== 'object' || typeof v.prompt !== 'string' || !strings(v.warnings) || !Array.isArray(v.planned_layers)
    || !v.planned_layers.every(l => l && typeof l.name === 'string' && typeof l.description === 'string')) throw new PlannerError('PLANNER_INVALID_JSON', 'The planner output does not match the expected schema.', value);
  const prompt = v.prompt.trim();
  if (!prompt) throw new PlannerError('PLANNER_EMPTY_PROMPT', 'The planner returned an empty prompt.', value);
  if (prompt.length > MAX_LAYERIZE_PROMPT) throw new PlannerError('PLANNER_PROMPT_TOO_LONG', `The generated prompt is ${prompt.length} characters; the local limit is ${MAX_LAYERIZE_PROMPT}. Seedream was not called.`, value);
  return { prompt, planned_layers: v.planned_layers, warnings: v.warnings as string[] };
}

type ResponsesClient = Pick<OpenAI, 'responses'> & Partial<Pick<OpenAI, 'baseURL'>>;
const PLANNER_TIMEOUT_MS = 180_000;

/** Responses API with image input and strict json_schema output; reasoning effort medium. */
export function createOpenAIPlanner(options: { apiKey?: string; model?: string; client?: ResponsesClient } = {}): Planner {
  const model = options.model?.trim() || DEFAULT_DECOMPOSITION_PLANNER_MODEL;
  return async (image, mime, context) => {
    if (!options.client && !options.apiKey?.trim()) throw new PlannerError('PLANNER_NOT_CONFIGURED', 'Set OPENAI_API_KEY in server/.env.');
    const client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: PLANNER_TIMEOUT_MS });
    const capture = context?.templateCapture === true;
    const request = {
      model, reasoning: { effort: 'medium' as const }, store: false,
      instructions: capture ? `${SEMANTIC_INSTRUCTION}\n\n${TEMPLATE_CAPTURE_INSTRUCTION}` : SEMANTIC_INSTRUCTION,
      input: [{ role: 'user' as const, content: [
        { type: 'input_text' as const, text: 'Analyze this exact image and generate its editable-layer decomposition plan.' },
        { type: 'input_image' as const, image_url: `data:${mime};base64,${image.toString('base64')}`, detail: 'high' as const },
      ] }],
      text: { format: { type: 'json_schema' as const, name: capture ? 'layerize_plan_with_template' : 'layerize_plan', schema: (capture ? TEMPLATE_CAPTURE_SCHEMA : SEMANTIC_SCHEMA) as unknown as Record<string, unknown>, strict: true } },
    };
    const shown = { ...request, input: [{ ...request.input[0], content: [request.input[0].content[0], { ...request.input[0].content[1], image_url: `<${mime}, ${image.length} bytes>` }] }] };
    let response: Awaited<ReturnType<ResponsesClient['responses']['create']>>;
    const started = Date.now();
    try { response = await client.responses.create(request) as typeof response; }
    catch (error) {
      const diagnostics = openAIRequestDiagnostics(error, { baseURL: client.baseURL, elapsedMs: Date.now() - started, timeoutMs: PLANNER_TIMEOUT_MS,
        imageBytes: image.length, requestBytes: Buffer.byteLength(JSON.stringify(request)) });
      // The SDK's raw message may echo credentials or image data. Keep only safe transport facts; never retry.
      throw new PlannerError('PLANNER_API_ERROR', `OpenAI ${model} request failed: ${openAIFailureSummary(diagnostics.error)}.`, undefined, diagnostics);
    }
    const r = response as unknown as { id?: string; status?: string; incomplete_details?: { reason?: string } | null; output?: { type: string; content?: { type: string; refusal?: string; text?: string }[] }[]; output_text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } };
    const usage: PlannerUsage | undefined = r.usage && { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, reasoning_tokens: r.usage.output_tokens_details?.reasoning_tokens, total_tokens: r.usage.total_tokens };
    const content = (r.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []);
    const refusal = content.find(c => c.type === 'refusal');
    if (refusal) throw new PlannerError('PLANNER_REFUSED', `The planner refused: ${refusal.refusal ?? '(no reason given)'}`, response);
    if (r.status !== 'completed') throw new PlannerError('PLANNER_INCOMPLETE', `The planner response is ${r.status ?? 'unknown'}${r.incomplete_details?.reason ? ` (${r.incomplete_details.reason})` : ''}.`, response);
    const text = r.output_text ?? content.filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new PlannerError('PLANNER_INVALID_JSON', 'The planner did not return valid JSON.', response); }
    let plan: LayerizePlan, captured: TemplateCapture | undefined;
    try {
      let answer = parsed;
      if (capture) { const split = splitTemplateCapture(parsed); answer = split.semantic; captured = split.capture; }
      const semantic = semanticPlan(answer);
      plan = { ...semantic, ...validatePlan(semantic) };
    } catch (error) {
      if (error instanceof PlannerError) throw new PlannerError(error.code, error.message, response);
      throw new PlannerError('PLANNER_INVALID_JSON', error instanceof Error ? error.message : String(error), response);
    }
    return { plan, model, responseId: r.id, usage, raw: response, request: shown, ...(captured ? { capture: captured } : {}) };
  };
}
