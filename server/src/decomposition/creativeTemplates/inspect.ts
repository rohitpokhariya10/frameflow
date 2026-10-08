/** Cheap structure-only inspection. It never writes generation prompts or decomposition plans. */
import type OpenAI from 'openai';
import { TEMPLATE_ROLES, TEMPLATE_ZONES, TEMPLATE_RELATIONS, canonicalStructure, type TemplateStructure } from '@frameflow/shared';
import { createOpenAIClient } from '../../services/openAIClient.js';
import { structureCheapModel } from '../aiModels.js';
import { PlannerError } from '../layerizePlanner.js';

export interface StructureInspector {
  model: string;
  inspect(image: Buffer, mime: string, save: (file: string, value: object) => void): Promise<{ structure: TemplateStructure; confidence: number; values: Record<string, string> }>;
}
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' }, boolean = { type: 'boolean' };
const attachment = ['none', 'held_in_hand', 'worn_by_human', 'attached_to_human', 'part_of_object'] as const;
export const STRUCTURE_SCHEMA = object({
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  elements: { type: 'array', items: object({ id: string, role: { type: 'string', enum: TEMPLATE_ROLES }, zone: { type: 'string', enum: TEMPLATE_ZONES }, independent: boolean,
    parent: string, attachment: { type: 'string', enum: attachment }, keepWithParent: boolean, currentValue: string }) },
  relationships: { type: 'array', items: object({ source: string, relation: { type: 'string', enum: TEMPLATE_RELATIONS }, target: string }) },
});
export function parseStructure(value: unknown): { structure: TemplateStructure; confidence: number; values: Record<string, string> } {
  const v = value as { confidence: number; elements: { id: string; role: typeof TEMPLATE_ROLES[number]; zone: typeof TEMPLATE_ZONES[number]; independent: boolean; parent: string; attachment: typeof attachment[number]; keepWithParent: boolean; currentValue: string }[]; relationships: TemplateStructure['relationships'] };
  const bad = () => { throw new PlannerError('STRUCTURE_INVALID', 'The structure could not be validated. A fresh planner is needed.'); };
  if (!v || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1 || !Array.isArray(v.elements) || v.elements.length < 2 || v.elements.length > 20 || !Array.isArray(v.relationships) || v.relationships.length > 80) return bad();
  const ids = new Set<string>();
  for (const e of v.elements) {
    if (!e || typeof e.id !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(e.id) || ids.has(e.id) || !TEMPLATE_ROLES.includes(e.role) || !TEMPLATE_ZONES.includes(e.zone) || !attachment.includes(e.attachment) || typeof e.independent !== 'boolean' || typeof e.keepWithParent !== 'boolean' || typeof e.currentValue !== 'string') return bad();
    ids.add(e.id);
  }
  if (!v.elements.some(e => e.role === 'background') || !v.elements.some(e => e.independent && !['background', 'backdrop', 'decoration', 'effect'].includes(e.role))) return bad();
  for (const e of v.elements) if (e.attachment !== 'none' && (!ids.has(e.parent) || e.parent === e.id)) return bad();
  for (const e of v.elements) {
    const chain = new Set<string>();
    let next: typeof e | undefined = e;
    while (next?.attachment !== 'none' && next) {
      if (chain.has(next.id)) return bad();
      chain.add(next.id); const parent: string = next.parent;
      next = v.elements.find(p => p.id === parent);
    }
  }
  for (const r of v.relationships) if (!r || !ids.has(r.source) || !ids.has(r.target) || r.source === r.target || !TEMPLATE_RELATIONS.includes(r.relation)) return bad();
  const structure = canonicalStructure({ layers: v.elements.map((e, order) => ({ id: e.id, role: e.role, zone: e.zone, order, independent: e.independent, required: e.independent && !['background', 'backdrop', 'decoration', 'effect'].includes(e.role),
    ...(e.attachment !== 'none' ? { attachment: { parent: e.parent, relation: e.attachment, keepWithParent: e.keepWithParent, separationRisk: e.keepWithParent ? 'high' as const : 'low' as const } } : {}) })), relationships: v.relationships });
  return { structure, confidence: v.confidence, values: Object.fromEntries(v.elements.map(e => [e.id, e.currentValue.replace(/[{}<>\n\r]/g, ' ').slice(0, 120)])) };
}
export function liveStructureInspector(options: { model?: string; client?: Pick<OpenAI, 'responses'> } = {}): StructureInspector {
  const model = options.model ?? structureCheapModel();
  return { model, async inspect(image, mime, save) {
    const request = { model, store: false, reasoning: { effort: 'low' as const },
      instructions: 'Identify only the structural layout of this creative. Do not write any image-generation or decomposition prompt. Use role ids, canonical roles and coarse zones. Product parts in the same region (case, lid and earbuds) belong to one main_product group; two spatially separate independent products stay separate. A person holding any object uses primary_subject and held_object, with holds relationship and held_in_hand attachment. Frames, halos, cloud or rainbow arches behind a subject are backdrop. Colors, identity, product nouns and decoration themes are currentValue only, never structure. Group incidental decorations. If a role, geometry or relationship is uncertain, lower confidence below 0.85. Preserve meaningful text roles and subject counts.',
      input: [{ role: 'user' as const, content: [{ type: 'input_image' as const, image_url: `data:${mime};base64,${image.toString('base64')}`, detail: 'high' as const }] }],
      text: { format: { type: 'json_schema' as const, name: 'creative_structure', schema: STRUCTURE_SCHEMA, strict: true } } };
    save('structure.openai-request.json', { ...request, input: [{ role: 'user', image: `<${mime}; ${image.length} bytes>` }] });
    const client = options.client ?? createOpenAIClient(process.env.OPENAI_API_KEY);
    try {
      const response = await client.responses.create(request);
      save('structure.openai-response.json', response);
      if (response.status !== 'completed') throw new PlannerError('STRUCTURE_INCOMPLETE', 'Structure analysis was incomplete.');
      return parseStructure(JSON.parse(response.output_text));
    } catch (error) {
      save('structure.error.json', { message: error instanceof Error ? error.message : String(error), status: (error as { status?: number }).status });
      throw error;
    }
  } };
}
