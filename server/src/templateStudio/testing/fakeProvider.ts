/**
 * MOCK provider for tests and the offline browser fixture (ported from the Generator's tests/helpers/fakeProvider.ts).
 * It answers with schema-valid data derived from the request and draws a synthetic scene. It never contacts OpenAI and
 * its images are not real generations: anything shown from it must be labelled as offline/mock.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ProviderCallError, type ImageEditRequest, type Provider, type StructuredRequest } from '../ai/provider.js';
import type { Segmenter } from '../../decomposition/creativeTemplates/segmenter.js';
import { mockMasterPlan } from './masterCreativePlan.js';

export interface FakeCall { kind: 'structured' | 'image'; schemaName?: string; model: string; system?: string; prompt?: string; images?: number; imageNames?: string[]; data?: Record<string, unknown> }

export class FakeProvider implements Provider {
  readonly offline = true;
  calls: FakeCall[] = [];
  /** Override answers per schema name (return a JSON string or object). */
  overrides: Record<string, (req: StructuredRequest) => unknown> = {};
  /** Text the fake reviewer "sees" in the raw scene. */
  sceneText: string[] = [];
  /** The fake reviewer's Match Reference score (1–5) for match-mode posters; copy containing "Drift check" always scores 2. */
  referenceMatchScore = 5;
  /** Milliseconds each call takes (the offline browser fixture shows progress with it). */
  delayMs = 0;

  async structured(req: StructuredRequest) {
    const data = dataBlock(req);
    this.calls.push({ kind: 'structured', schemaName: req.schemaName, model: req.model, system: req.system, data });
    await this.pause();
    const override = this.overrides[req.schemaName];
    const body = override ? override(req) : req.schemaName === 'editable_offer_style_variations' ? mockMasterPlan(req) : this.answer(req.schemaName, data);
    return {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      refusal: null,
      incompleteReason: null,
      usage: { input_tokens: 4000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 900 },
      requestId: `req_fake_${this.calls.length}`,
    };
  }

  /** Style-variation prompts that make the fake image model refuse (as a provider safety refusal would). */
  refuseVariations = /Fixture refusal/;

  async editImage(req: ImageEditRequest) {
    this.calls.push({ kind: 'image', model: req.model, prompt: req.prompt, images: req.images.length, imageNames: req.images.map(i => i.name) });
    await this.pause();
    const [w, h] = req.size.split('x').map(Number);
    // A style variation: the supplied text-free base, recoloured by a hue taken from the prompt (each direction its own
    // look). "Fixture drawn text" in the prompt adds a magenta block the fake recognizer reads as drawn text.
    if (req.prompt.startsWith('Restyle the attached poster artwork')) {
      if (this.refuseVariations.test(req.prompt)) throw new ProviderCallError({ code: 'content_policy', message: 'The image service declined this request (fixture refusal).', safeToRetry: false, outcomeUnknown: false, requestId: 'req_fake_refused' });
      const hue = parseInt(createHash('sha256').update(req.prompt).digest('hex').slice(0, 2), 16) * 1.4;
      let image = await sharp(req.images[0].data).resize(w, h, { fit: 'fill' }).modulate({ hue: Math.round(hue), saturation: 1.3 }).png().toBuffer();
      if (req.prompt.includes('Fixture drawn text')) image = await sharp(image).composite([{ input: { create: { width: Math.round(w * 0.3), height: Math.round(h * 0.06), channels: 3, background: { r: 255, g: 0, b: 255 } } }, left: Math.round(w * 0.05), top: Math.round(h * 0.9) }]).png().toBuffer();
      return { image, usage: { input_tokens: 9000, input_tokens_details: { text_tokens: 1500, image_tokens: 7500 }, output_tokens: 6000 }, requestId: `req_fake_img_${this.calls.length}` };
    }
    // A blue studio backdrop, a white podium and a teal "product" where the layout guide puts the first product.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6fd6"/><stop offset="1" stop-color="#1c4fa8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><ellipse cx="${w / 2}" cy="${h * 0.8}" rx="${w * 0.3}" ry="${h * 0.05}" fill="#f4f6fb"/><rect x="${w * 0.2}" y="${h * 0.72}" width="${w * 0.6}" height="${h * 0.08}" fill="#e8ecf5"/><rect x="${w * 0.4}" y="${h * 0.45}" width="${w * 0.2}" height="${h * 0.27}" rx="${w * 0.02}" fill="#2e7d6b"/></svg>`;
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    return { image, usage: { input_tokens: 9000, input_tokens_details: { text_tokens: 1500, image_tokens: 7500 }, output_tokens: 6000 }, requestId: `req_fake_img_${this.calls.length}` };
  }

  private pause() { return this.delayMs ? new Promise<void>(done => setTimeout(done, this.delayMs)) : Promise.resolve(); }

  private answer(schemaName: string, data: Record<string, unknown>) {
    switch (schemaName) {
      case 'style_profile': {
        const refs = (data.references as { id: string }[]).map(r => r.id);
        return {
          summary: 'Blue studio product advertising: products on white geometric podiums, soft lighting and a reflective floor, with generous space for a headline.',
          visualMedium: 'photo',
          campaignCharacter: 'Confident, premium retail',
          visualHierarchy: 'Products on podiums first, bold headline, small footer',
          palette: { colors: [{ hex: '#2f6fd6', role: 'studio backdrop', prominence: 'dominant' }, { hex: '#f4f6fb', role: 'podiums', prominence: 'secondary' }, { hex: '#ffcc33', role: 'offer accent', prominence: 'accent' }], allowedVariation: 'Small hue shifts within cool blues' },
          typography: { headlineCharacter: 'Geometric bold sans', bodyCharacter: 'Regular sans', casing: 'Sentence case', suggestedHeadlineFamily: 'Poppins', suggestedBodyFamily: 'Poppins', identificationConfidence: 0.4 },
          layout: { density: 'balanced', negativeSpace: 'high', alignment: 'centre', focalHierarchy: 'Products first', textPlacement: 'Headline across the top', typicalRelationships: 'Products sit on podiums of different heights' },
          composition: {
            arrangement: 'stepped_levels', staging: 'Three products on white geometric podiums of different heights.', heroPlacement: 'Raised in the centre.',
            subjectGroupWidth: 0.6, subjectGroupHeight: 0.35, subjectGroupCenterX: 0.5, subjectGroupCenterY: 0.6, headroom: 0.32, footroom: 0.18, minEdgeMargin: 0.08, overlap: 'none', visibleSupports: true,
            backdrop: null,
          },
          lighting: 'Soft studio light from the front with gentle reflections on the floor',
          materials: 'Matte white podiums, glossy reflective floor',
          backgroundTreatment: 'Smooth blue studio backdrop with a subtle vertical gradient',
          sharedInvariants: ['Blue studio backdrop', 'White geometric podiums', 'Reflective floor'],
          referenceSpecificMotifs: [{ referenceId: refs[0], motif: 'Three appliances in a row' }],
          allowedVariation: ['Number of podiums to match the products'],
          excludedDirections: ['Outdoor scenes', 'Dark backgrounds'],
          referenceClusters: [{ id: 'c1', label: 'Blue studio', description: 'All references', referenceIds: refs }],
          // One inventory per reference, as style-profile/5 requires (contracts/ai.ts): no products listed, so uploaded products
          // are added rather than swapped in; the reference poster's yellow offer banner and white sub-headline bar as text.
          referenceScenes: refs.map(referenceId => ({ referenceId, confidence: 0.8, products: [], camera: 'Front, eye level', lighting: 'Soft studio light', supportingObjects: ['White podiums'], background: 'Blue studio gradient',
            textRegions: [{ kind: 'text', description: 'Yellow offer banner', box: { x: 0.0833, y: 0.0815, width: 0.8333, height: 0.0889 } }, { kind: 'text', description: 'White sub-headline bar', box: { x: 0.0833, y: 0.1926, width: 0.5556, height: 0.037 } }] })),
          defaultClusterId: 'c1',
          contentToReplace: [{ referenceId: refs[0], kind: 'product', description: 'Three kitchen appliances' }, { referenceId: refs[0], kind: 'offer', description: 'Old 10% cashback offer' }],
          evidence: [{ rule: 'Blue studio backdrop', referenceIds: refs, confidence: 0.8 }],
          overallConfidence: 0.7,
          singleReferenceCaveat: refs.length === 1 ? 'Only one reference: the rules are provisional.' : null,
        };
      }
      case 'subject_analysis':
        return { category: 'appliance', silhouette: 'Rectangular', materials: ['steel'], colors: ['silver'], definingDetails: ['Black control panel'], visibleView: 'front', supportNeeds: 'Stands on a flat surface', visibleText: [], isolatedOnPlainBackground: true, uncertainties: [], confidence: 0.8 };
      case 'concept_plan': {
        const fields = Object.keys(data.copy as object);
        const subjects = (data.subjects as { id: string }[]).map(s => s.id);
        const corners = (data.brand as { logo?: { allowedCorners: string[] } } | null)?.logo?.allowedCorners ?? ['top_left'];
        return {
          concepts: [{ id: 'a', title: 'Blue studio podiums', summary: 'The reference studio with the new products' }, { id: 'b', title: 'Lifestyle kitchen', summary: 'A kitchen scene' }],
          chosenConceptId: 'a',
          selectionRationale: 'Matches the reference best',
          theme: /diwali/i.test(JSON.stringify(data.copy ?? {}) + String(data.userDirection ?? '') + String(data.occasion ?? ''))
            ? { occasion: 'Diwali', visualCues: ['glowing diyas', 'marigold garlands'], paletteAccents: ['#f5a623'], avoidCues: ['tricolour ribbon'] }
            : null,
          scene: { medium: 'photo', environment: 'Blue studio', background: 'Smooth blue gradient', palette: ['#2f6fd6', '#f4f6fb'], lighting: 'Soft key light', camera: 'Eye level, straight on', composition: 'Products centred low on podiums, text top', backgroundComplexity: 'low', mood: 'Calm', supportingElements: [] },
          subjects: subjects.map((id, i) => ({ subjectId: id, placement: 'on a podium', region: { x: 0.25 + i * 0.01, y: 0.45, width: 0.5, height: 0.4 }, prominence: i === 0 ? 'hero' : 'secondary', scaleBasis: 'fills width', support: 'white podium' })),
          texts: fields.map((f, i) => ({
            field: f, x: 0.06, y: 0.14 + i * 0.09, width: 0.88, height: 0.08, align: 'left', verticalAlign: 'top', fontFamily: 'Poppins',
            fontWeight: f === 'headline' ? 700 : 400, fontSizePct: f === 'headline' ? 6 : 2.2, lineHeight: 1.1, uppercase: false,
            color: '#2f6fd6', // deliberately low contrast on the blue scene → auto-fixed and noted
            plate: null,
          })),
          logo: { corner: corners[corners.length - 1], widthPct: 18 },
          avoid: ['clutter'],
          designRationale: 'Simple and readable',
        };
      }
      case 'poster_review': {
        // Decided by the request, so parallel browser tests sharing one fixture server never change each other's result.
        const score = /drift check/i.test(JSON.stringify(data.campaignCopy ?? {})) ? 2 : this.referenceMatchScore;
        return {
          summary: 'Looks good.',
          scores: { styleConsistency: 4, subjectIdentity: 4, subjectCount: 5, focalHierarchy: 4, readability: 4, physicalPlausibility: 4, advertisingUsefulness: 4 },
          issues: [],
          copiedReferenceContent: [],
          unwantedSceneText: this.sceneText,
          ...(data.fidelityMode === 'match' ? {
            referenceMatch: {
              score,
              sameBackground: score >= 4, sameStagingAndProps: score >= 4, sameCameraAndFraming: score >= 3, sameLighting: score >= 3, samePalette: score >= 4,
              differences: score >= 4 ? [] : ['A dark kitchen instead of the blue studio', 'No podiums'],
            },
          } : {}),
        };
      }
      default:
        throw new Error(`FakeProvider: no answer for ${schemaName}`);
    }
  }
}

function dataBlock(req: StructuredRequest): Record<string, unknown> {
  const first = req.content.find(c => c.type === 'text');
  if (!first || first.type !== 'text') return {};
  try { return JSON.parse(first.text.slice(first.text.indexOf('{'))); } catch { return {}; }
}

/** MOCK of FrameFlow's SAM-3 segmenter: the photo's non-white pixels are "the product". No request leaves the process. */
export function fakeSegmenter(calls: { label: string }[] = []): Segmenter {
  return {
    provider: 'sam3',
    async segment(input) {
      calls.push({ label: input.targets[0]?.label ?? '' });
      const { data, info } = await sharp(input.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const mask = Buffer.alloc(info.width * info.height);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 3] > 235 && data[i * 3 + 1] > 235 && data[i * 3 + 2] > 235 ? 0 : 255;
      const png = await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
      return { mask: png, masks: [png], requestIds: [`fake-sam3-${calls.length}`] };
    },
  };
}
