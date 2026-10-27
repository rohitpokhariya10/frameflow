import { productReuseProviders } from './productReuseProviders.js';
import { liveProductAnalyzer, parseProductScene, replayProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { failingResponsesClient, recordedResponsesClient, type FailingKind } from '../../server/src/decomposition/protectedTemplates/product/responsesClient.fixture.js';
import { replayArtworkGenerator } from '../../server/src/decomposition/protectedTemplates/product/artwork.js';
import { standInProductLayerizer } from '../../server/src/decomposition/protectedTemplates/product/aiDecompose.js';
import type { ReusePlacementPlanner } from '../../server/src/decomposition/protectedTemplates/product/reusePlacement.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
/** Local-only reviewer fixture: real routes/storage/planner adaptation/import, deterministic providers, no credentials. */
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { referenceCreativeFixture } from '../../server/src/decomposition/referenceCreative.fixture.js';
import { verboseImageAnalysis } from '../../server/src/decomposition/imageTemplateAnalysis.fixture.js';
import { createOpenAIImagePromptWriter, referenceForPrompt } from '../../server/src/decomposition/imageTemplates.js';
import { mkdtempSync, readFileSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp, readConfig } from '../../server/src/app.js';
import { createLayerizeRouter } from '../../server/src/decomposition/layerizeRouter.js';
import { createOpenAIPlanner } from '../../server/src/decomposition/layerizePlanner.js';
import type { GenerationConfig } from '../../server/src/decomposition/generationGroups.js';
import type { FalTransport } from '../../server/src/decomposition/providers/falClient.js';
import { ProviderError } from '../../server/src/decomposition/providers/adapters.js';
import { parseSceneDescription, type ResolverProposal, type SemanticCheck, type TemplateRole } from '@frameflow/shared';
import { ALL_PARTS, OFFER_PARTS, offerComposite, offerPart, partName, rowFillEdit, type OfferPart } from '../../server/src/decomposition/complexOffer.fixture.js';
import { RESIDUAL_PROMPT } from '../../server/src/decomposition/recursiveDecomposition.js';
import { TEMPLATE_CAPTURE_SCHEMA, SEMANTIC_SCHEMA, type SemanticAnalysis, type SemanticElement } from '../../server/src/decomposition/semanticPlanner.js';
import { BANGLE_PARTS, bangleAnalysis, blackSilhouetteEdit, creative, HOLDING_PARTS, holdingAnalysis, partPng } from '../../server/src/decomposition/protectedInteraction.fixture.js';
import { curationFixture } from '../../server/src/decomposition/curation.fixture.js';
import { parseStructure } from '../../server/src/decomposition/creativeTemplates/inspect.js';
import { createTemplateStudioRouter } from '../../server/src/templateStudio/router.js';
import { parseStudioEnv } from '../../server/src/templateStudio/config.js';
import { FakeProvider, fakeSegmenter } from '../../server/src/templateStudio/testing/fakeProvider.js';
import { fakeRecognizer, tesseractRecognizer, type WordRecognizer } from '../../server/src/textRecognition/recognizer.js';
import { masterPosterPng, newLogoPng } from '../../server/src/decomposition/protectedTemplates/master/masterPoster.fixture.js';
import { artworkPosterPng } from '../../server/src/decomposition/protectedTemplates/master/artworkObjects.fixture.js';
import { existsSync } from 'node:fs';
import { loadGaneshHandmade } from './privateHandmade.js';
import { homedir } from 'node:os';
import { replacementLogoPng, VARIATION_WORDS, variationPosterPng } from '../../server/src/textRecognition/variationPoster.fixture.js';
import { logoPng, productCutoutPng, productPhotoPng, referencePosterPng, TEST_BRAND_RULES } from '../../server/src/templateStudio/testing/fixtures.js';
import { fakeArtworkGenerator, fakeProductAnalyzer, fakeSegmenter as fakeProductSegmenter, PRODUCT_WORDS, productPosterPng } from '../../server/src/decomposition/protectedTemplates/product/productPoster.fixture.js';

if (process.env.FRAMEFLOW_OFFLINE_E2E !== '1') throw new Error('This fixture requires FRAMEFLOW_OFFLINE_E2E=1.');
// No SDK transport is used. An accidental fetch fails before it can leave this process.
globalThis.fetch = async () => { throw new Error('Network is disabled in the offline fixture server.'); };
const port = Number(process.env.FRAMEFLOW_OFFLINE_PORT ?? 3317), origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'frameflow-image-template-e2e-'));
// Optional real-poster fixture prepared by prepareSavedVariation.ts. Copy only; the saved original is never served or edited.
if (process.env.FRAMEFLOW_SAVED_VARIATION_FIXTURE) {
  cpSync(join(resolve(process.env.FRAMEFLOW_SAVED_VARIATION_FIXTURE), 'protected'), join(root, 'protected'), { recursive: true });
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const curation = curationFixture(), curationImages = new Set<string>();
const pixelsDigest = async (bytes: Buffer) => digest(await sharp(bytes).resize(32, 32).removeAlpha().raw().toBuffer());
const sources = new Map<string, string>(), analysisBehaviors = new Map<string, string>();
const offsetLayoutImages = new Set<string>();
const events: { kind: string; source: string; prompt?: string; size?: string; inputs?: string[] }[] = [];
const failedPortrait = new Set<string>(), editAttempts = new Map<string, number>();
/** Generated images whose first extraction fal rejects (422 invalid_request on body.image_url, 0 billable units), as seen live on 2026-10-08. */
const rejectFirstExtraction = new Set<string>(), rejectedRequests = new Set<string>(), submitted: string[] = [];
/**
 * An "Extraction 422 test" creative is marked by a flat magenta block inside the new product: it survives a local edit's
 * compositing (only the product's region comes from the model), so the first extraction of such an image is refused
 * whatever the rest of it is. Each marked image is refused once.
 */
const MARKER = [255, 0, 255], markerRejected = new Set<string>();
const hasMarker = async (bytes: Buffer) => { const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }); let n = 0; for (let i = 0; i < data.length; i += 3) if (Math.abs(data[i] - MARKER[0]) <= 3 && data[i + 1] <= 3 && Math.abs(data[i + 2] - MARKER[2]) <= 3) n++; return n >= 400; };
const pause = () => new Promise<void>(done => setTimeout(done, 350));
const BACKDROP = '<rect width="1000" height="1000" fill="#ede4f7"/><circle cx="190" cy="230" r="75" fill="#ddd0ed"/><circle cx="800" cy="500" r="110" fill="#e1d7ed"/><ellipse cx="500" cy="820" rx="320" ry="65" fill="#c6b6dc"/><ellipse cx="500" cy="790" rx="320" ry="60" fill="#faf7ff"/>';
const PHONE = '<rect x="345" y="190" width="310" height="570" rx="45" fill="#514661"/><rect x="357" y="202" width="286" height="546" rx="37" fill="#b294d2"/><rect x="375" y="222" width="105" height="130" rx="28" fill="#9a7aba"/><circle cx="405" cy="255" r="20" fill="#292431"/><circle cx="447" cy="305" r="20" fill="#292431"/><circle cx="505" cy="495" r="40" fill="#cbb4e2"/>';
/** A different product where the phone stood: a dark cylindrical speaker, another silhouette. */
const SPEAKER = '<rect x="410" y="330" width="180" height="440" rx="85" fill="#1d1d1f"/><circle cx="500" cy="450" r="50" fill="#4a4a4f"/><circle cx="500" cy="630" r="70" fill="#4a4a4f"/><rect x="470" y="345" width="60" height="12" rx="6" fill="#6b6b70"/>';
const svgPng = (width: number, height: number, body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`)).png().toBuffer();
/**
 * A person presenting in front of a rounded orange panel on a white canvas (as live run 2026-10-08T06-08 was): Seedream
 * returns the canvas, a hidden white plate, the panel and the person as separate layers.
 */
const PANEL_W = 600, PANEL_H = 750;
const PANEL_PARTS = {
  base: '<rect width="600" height="750" fill="#fbfbfa"/>',
  plate: '<rect x="40" y="190" width="520" height="450" rx="36" fill="#f7f7f5"/>',
  panel: '<defs><linearGradient id="og" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6913f"/><stop offset="1" stop-color="#f0561a"/></linearGradient></defs><rect x="40" y="190" width="520" height="450" rx="36" fill="url(#og)"/>',
  person: '<defs><pattern id="hoodie" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a3401d"/><rect width="4" height="8" fill="#7d2c12"/></pattern></defs><ellipse cx="380" cy="560" rx="120" ry="190" fill="url(#hoodie)"/><circle cx="380" cy="300" r="70" fill="#e0b39a"/>',
};
const panelPng = (...parts: (keyof typeof PANEL_PARTS)[]) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H}">${parts.map(p => PANEL_PARTS[p]).join('')}</svg>`)).png().toBuffer();
const panelCreativePng = () => panelPng('base', 'panel', 'person');
async function artwork(width: number, height: number, part: 'all' | 'background' | 'phone' = 'all', offset = false) {
  return svgPng(width, height, `${part !== 'phone' ? BACKDROP : ''}${part !== 'background' ? offset ? `<g transform="translate(-220 0)">${PHONE}</g>` : PHONE : ''}`);
}
/** Every fake provider request, by provider (fal includes Seedream's uploads, polls and downloads): an action that must spend nothing is checked against it. */
// Synthetic recorded billing facts, never live provider responses.
const imageUsage = { input_tokens: 1867, input_tokens_details: { image_tokens: 1178, text_tokens: 689 }, output_tokens: 1755 };
const plannerUsage = { input_tokens: 3376, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3373 }, output_tokens: 4835, output_tokens_details: { reasoning_tokens: 1552 } };
const referenceUsage = { input_tokens: 2616, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1937 };
const callCounts = { openai: 0, fal: 0, seedream: 0 };
const generate = async (request: { size: string; prompt: string; image?: File | File[]; mask?: File }) => {
  callCounts.openai++;
  const images = request.image ? Array.isArray(request.image) ? request.image : [request.image] : [];
  const inputs = await Promise.all(images.map(async image => digest(Buffer.from(await image.arrayBuffer()))));
  const source = inputs[0] ?? '';
  events.push({ kind: 'generation', source, inputs, prompt: request.prompt, size: request.size });
  if (request.prompt.includes('Slow phone')) await new Promise<void>(done => setTimeout(done, 2200));
  await pause();
  if (request.prompt.includes('Portrait retry test') && request.size === '1216x1520' && !failedPortrait.has(source)) { failedPortrait.add(source); throw new Error('Fixture portrait failure. Retry this size.'); }
  const [width, height] = request.size.split('x').map(Number);
  // A creative template edit returns a recolored creative, so the approved image is distinguishable from its original. A
  // replaced main product is drawn as a speaker, unless the prompt carries "Kept product test": a model that ignored the
  // replacement and kept the phone. A corner mark from the prompt makes each test's image its own.
  if (request.prompt.startsWith('Edit the attached creative. Make only this change:') || request.prompt.startsWith('Edit the attached advertising creative.')) {
    const attempt = (editAttempts.get(request.prompt) ?? 0) + 1;
    editAttempts.set(request.prompt, attempt);
    if (request.prompt.includes('Regenerate failure test') && attempt === 2) throw new Error('Fixture regeneration failure.');
    const replaced = (request.prompt.includes('Replace the main product') || request.prompt.includes('Replace the smartphone')) && !request.prompt.includes('Kept product test');
    const mark = `<rect x="4" y="4" width="10" height="10" fill="#${createHash('sha256').update(request.prompt).digest('hex').slice(0, 6)}"/>`;
    let bytes = await sharp(await svgPng(width, height, `${BACKDROP}${replaced ? SPEAKER : PHONE}${mark}`)).modulate({ hue: 25 }).png().toBuffer();
    if (request.prompt.includes('Extraction 422 test')) {
      const block = { left: Math.round(width * 0.46), top: Math.round(height * 0.52), width: Math.round(width * 0.08), height: Math.round(height * 0.08) };
      bytes = await sharp(bytes).composite([{ input: { create: { width: block.width, height: block.height, channels: 3, background: { r: MARKER[0], g: MARKER[1], b: MARKER[2] } } }, left: block.left, top: block.top }]).png().toBuffer();
      rejectFirstExtraction.add(digest(bytes));
    }
    return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: bytes.toString('base64') }] };
  }
  // A creative variant on its own ratio canvas: like a masked-edit model, new scenery everywhere the mask lets it paint,
  // and the placed products redrawn a little brighter and a few pixels off (a drift); the app restores their own pixels.
  if (request.prompt.startsWith('Create a premium advertising photograph around the products already placed')) {
    if (request.prompt.includes('Variant failure test')) throw Object.assign(new Error('Fixture variant failure.'), { status: 500 });
    const hue = parseInt(createHash('sha256').update(request.prompt).digest('hex').slice(0, 2), 16);
    const scenery = await sharp(await svgPng(width, height, '<rect width="1000" height="1000" fill="#2a8c8c"/><circle cx="210" cy="210" r="120" fill="#f5d76e"/><rect x="0" y="780" width="1000" height="220" fill="#1d5f5f"/>')).modulate({ hue }).png().toBuffer();
    // The kept products (the mask's opaque area), redrawn: built byte by byte, as sharp drops a joined alpha band here.
    const rgb = await sharp(Buffer.from(await images[0].arrayBuffer())).removeAlpha().raw().toBuffer(), keep = await sharp(Buffer.from(await request.mask!.arrayBuffer())).ensureAlpha().raw().toBuffer();
    const products = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) { for (let c = 0; c < 3; c++) products[i * 4 + c] = Math.min(255, rgb[i * 3 + c] + 10); products[i * 4 + 3] = keep[i * 4 + 3]; }
    const redrawn = await sharp(products, { raw: { width, height, channels: 4 } }).extract({ left: 0, top: 0, width: width - 9, height: height - 6 }).png().toBuffer();
    const bytes = await sharp(scenery).composite([{ input: redrawn, left: 9, top: 6 }]).png().toBuffer();
    return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: bytes.toString('base64') }] };
  }
  // A creative variant: new teal scenery around the (masked, kept) phone; the app restores the phone's own pixels on top.
  if (request.prompt.startsWith('Create a new offer-creative scene.')) {
    if (request.prompt.includes('Variant failure test')) throw Object.assign(new Error('Fixture variant failure.'), { status: 500 });
    const hue = parseInt(createHash('sha256').update(request.prompt).digest('hex').slice(0, 2), 16);
    const bytes = await sharp(await svgPng(width, height, `<rect width="1000" height="1000" fill="#2a8c8c"/><circle cx="210" cy="210" r="120" fill="#f5d76e"/><rect x="0" y="780" width="1000" height="220" fill="#1d5f5f"/><g transform="translate(14 10)">${PHONE}</g>`)).modulate({ hue }).png().toBuffer();
    return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: bytes.toString('base64') }] };
  }
  if (request.prompt.includes('Mint phone curation fixture')) {
    const bytes = await sharp((await curation).source).resize(width, height).png().toBuffer();
    curationImages.add(await pixelsDigest(bytes));
    return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: bytes.toString('base64') }] };
  }
  // A layout-family creative headlined "Mega Sale" keeps its family's layout when square; other sizes drift (the default artwork).
  if (request.prompt.includes('Mega Sale') && width === height) {
    const bytes = await artwork(width, height);
    return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: bytes.toString('base64') }] };
  }
  return { created: 1, quality: 'medium', usage: imageUsage, data: [{ b64_json: (await artwork(width, height)).toString('base64') }] };
};
const files = new Map<string, Buffer>(), inputs = new Map<string, Buffer>(), results = new Map<string, unknown>();
// The complex offer creative (recursive decomposition): its first decomposition misses the speaker and power bank and
// leaves everything baked into its base; the residual pass that follows finds both, plus a duplicate of the headphones.
const complexDigest = offerComposite().then(digest);
// A woman holding a phone: Seedream's answer is the split seen live (woman, phone, screen badge and gripping fingers as
// separate layers); the protection must turn it into one intact layer.
const holdingDigest = creative(HOLDING_PARTS).then(digest), bangleDigest = creative(BANGLE_PARTS).then(digest), panelDigest = panelCreativePng().then(digest);
// The live Paytm failure: Seedream bakes everything into its base, and the image edit answers with a black silhouette.
let blackEditNext = false;
let complexResidualNext = false;
const providerCalls: { kind: 'seedream-initial' | 'seedream-residual' | 'background-edit'; complex?: boolean }[] = [];
/**
 * Protected templates: a 900×1200 EMI poster (two bank logos, a headline, fine print) and its clean artwork. A 10 px
 * marker in the unprotected top-left corner tells the fake Seedream what to do with a base: answer with the base and the
 * phone as layers, or refuse it as the provider's partner content check did on 2026-10-19 (422, 0 billable units).
 */
const PT_SIZE = { width: 900, height: 1200 }, PT_MARKERS = { ok: [10, 126, 141], refuse: [10, 126, 142] } as const;
const PT_GRADIENT = '<defs><linearGradient id="ptg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b6e79"/><stop offset="1" stop-color="#14a3a8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#ptg)"/>';
const PT_PHONE = '<rect x="520" y="420" width="260" height="520" rx="36" fill="#22252c"/><rect x="536" y="440" width="228" height="480" rx="26" fill="#9fb7d9"/>';
const PT_LOGO_A = '<rect width="200" height="80" rx="10" fill="#f4f1e8"/><circle cx="40" cy="40" r="26" fill="#c8102e"/><rect x="80" y="26" width="100" height="28" fill="#1d2a6b"/>';
const PT_LOGO_B = '<circle cx="50" cy="50" r="46" fill="#1b8a3a"/><rect x="30" y="40" width="40" height="20" fill="#ffffff"/>';
const PT_LOGO_NEW = '<rect width="200" height="80" rx="40" fill="#f26b1d"/><rect x="40" y="30" width="120" height="20" fill="#ffffff"/>';
const ptSvg = (body: string, w = PT_SIZE.width, h = PT_SIZE.height) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
const ptMarker = (kind: keyof typeof PT_MARKERS) => `<rect x="4" y="4" width="10" height="10" fill="rgb(${PT_MARKERS[kind].join(',')})"/>`;
/** A test's own mark beside the marker (unprotected), so its images are its own while other specs share this server. */
const ptSeed = (seed: string) => seed ? `<rect x="20" y="4" width="10" height="10" fill="#${createHash('sha256').update(seed).digest('hex').slice(0, 6)}"/>` : '';
const ptSource = (kind: keyof typeof PT_MARKERS, seed = '') => ptSvg(PT_GRADIENT + ptMarker(kind) + ptSeed(seed) + PT_PHONE + `<g transform="translate(60 60)">${PT_LOGO_A}</g><g transform="translate(300 50)">${PT_LOGO_B}</g>`
  + '<text x="60" y="380" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#ffffff">Easy EMI</text>'
  + '<text x="60" y="1150" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#e8f4f4">T&amp;C apply. EMI on select bank cards. Offer valid till 31 Oct 2026.</text>');
const ptClean = (kind: keyof typeof PT_MARKERS, seed = '') => ptSvg(PT_GRADIENT + ptMarker(kind) + ptSeed(seed) + PT_PHONE);
async function ptMarkerOf(bytes: Buffer): Promise<keyof typeof PT_MARKERS | undefined> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== PT_SIZE.width || info.height !== PT_SIZE.height) return undefined;
  const i = (8 * info.width + 8) * 3;
  return (Object.keys(PT_MARKERS) as (keyof typeof PT_MARKERS)[]).find(k => PT_MARKERS[k].every((v, c) => data[i + c] === v));
}
const partnerRefused = new Set<string>();
// Master templates: the REAL local OCR (tesseract.js, its model read from node_modules; no network), every read counted, so
// a browser test can prove that reuse reads nothing. A master's clean background registered for "echo" comes back from the
// fake Seedream as its own layer (the artwork unchanged), instead of the lavender studio every unknown image gets.
const masterOcr = tesseractRecognizer();
let masterOcrCalls = 0;
const masterRecognizer: WordRecognizer = { engine: masterOcr.engine, recognize: input => { masterOcrCalls++; return masterOcr.recognize(input); } };
const masterEcho = new Set<string>();
// FRAMEFLOW_PRODUCT_REFERENCE=1 (screenshots of a real reference only): the real local OCR, and for the LG creative of
// Ganesh-Chaturthi.png the HAND-MADE stand-in answer (tests/fixtures/ganeshHandmade.fixture.ts), never a model's.
// (The hand-made manifest of the client's reference creative is confidential and kept out of the repository: used only
// where it is present, like the reference picture itself.)
const handmade = await loadGaneshHandmade();
const GANESH_LG_SIZE = handmade?.GANESH_LG_SIZE ?? { width: 607, height: 606 };
const realProduct = process.env.FRAMEFLOW_PRODUCT_REFERENCE === '1' && !!handmade, fixtureAnalyzer = fakeProductAnalyzer(), handmadeAnalyzer = fakeProductAnalyzer(handmade?.GANESH_LG_HANDMADE_ANSWER);
// New artwork for recomposed variations: the offline image model (no network, labelled as a test model).
// With the recorded real answer (FRAMEFLOW_PRODUCT_RECORDED=1) the RECORDED real gpt-image-2 artworks are replayed instead.
const reuseProof = process.env.FRAMEFLOW_PRODUCT_REUSE_PROOF === '1' ? productReuseProviders() : undefined;
const productArtwork = reuseProof?.artwork ?? (process.env.FRAMEFLOW_PRODUCT_RECORDED === '1' && existsSync('tests/fixtures/recorded/gpt-image-2-ganesh-16x9-2026-10-22.png')
  ? replayArtworkGenerator({ wide: readFileSync('tests/fixtures/recorded/gpt-image-2-ganesh-16x9-2026-10-22.png'), tall: readFileSync('tests/fixtures/recorded/gpt-image-2-ganesh-9x16-2026-10-22.png'), square: readFileSync('tests/fixtures/recorded/gpt-image-2-ganesh-1x1-2026-10-22.png') })
  : fakeArtworkGenerator());
const productRecognizer = realProduct ? Object.assign(masterRecognizer, { calls: [] as unknown[] }) : fakeRecognizer(PRODUCT_WORDS), productSegmenter = fakeProductSegmenter();
// The AI decomposition core's OFFLINE STAND-IN (aiDecompose.ts): no OpenAI planner, no Seedream — labelled so wherever it
// shows; FRAMEFLOW_PRODUCT_LAYERIZE=off removes it (the screens then offer only the local decomposition).
/**
 * Reuse Template's AI placement, as a test double (offline:false, so the cost approval is exercised; NEVER contacts a
 * provider): it returns the fixed-rule proposal with the middle product enlarged as the hero, and one deliberately bad
 * box (the last product over the headline) that the server's checks must reject.
 */
const placementCalls: { format: string; products: string[]; imageBytes: number; operationId: string }[] = [];
const reusePlacement: ReusePlacementPlanner = { model: 'test placement planner (no network or charges)', offline: false, async place(input, image, save, operationId) {
  placementCalls.push({ format: input.format, products: input.products.map(p => p.id), imageBytes: image.length, operationId });
  save('placement.test-request.json', { format: input.format, products: input.products.length, testOnly: true });
  const hero = input.proposal[Math.floor(input.proposal.length / 2)], text = input.keepOut[0];
  return { responseId: `fixture-placement-${placementCalls.length}`, raw: { notes: ['Hero product centred and enlarged (test double).'], products: input.proposal.map((b, i) => {
    if (b.id === hero?.id) { const k = 1.12; return { id: b.id, x: b.x + b.width / 2 - b.width * k / 2, y: b.y + b.height - b.height * k, width: b.width * k, height: b.height * k, z: 900, role: 'hero' }; }
    if (i === input.proposal.length - 1 && text && input.proposal.length > 1) return { id: b.id, x: text.x, y: text.y, width: b.width, height: b.height, z: b.z, role: 'supporting' };
    return { ...b, role: 'supporting' };
  }) } };
} };
const productLayerizer = process.env.FRAMEFLOW_PRODUCT_LAYERIZE === 'off' ? undefined : reuseProof?.layerizer ?? standInProductLayerizer();
// FRAMEFLOW_PRODUCT_RECORDED=1 (with FRAMEFLOW_PRODUCT_REFERENCE=1): the LG creative gets the RECORDED real answer of the one
// approved live detection (gpt-5.6-sol, 2026-10-22), replayed without network; otherwise the handmade manifest.
const recordedProduct = realProduct && process.env.FRAMEFLOW_PRODUCT_RECORDED === '1' && existsSync('tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.response.json');
let recordedAnalyzer: ReturnType<typeof replayProductAnalyzer> | undefined;
if (recordedProduct) {
  const sheet = readFileSync('Ganesh-Chaturthi.png'), c = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
  const creative = await sharp(sheet).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).png({ compressionLevel: 9 }).toBuffer();
  recordedAnalyzer = replayProductAnalyzer({ response: JSON.parse(readFileSync('tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.response.json', 'utf8')), model: 'gpt-5.6-sol', imageSha256: createHash('sha256').update(await sharp(creative).png().toBuffer()).digest('hex') });
}
// FRAMEFLOW_PRODUCT_AI_CLIENT: the LIVE analyzer code (picture sent at most 2048 px, request, error handling) with a client
// that never reaches the network: `recorded` answers with the RECORDED real answer for the LG creative at the size actually
// sent (any upload size of that creative); `timeout`, `connection`, `no-credit` or `bad-key` fail as the OpenAI SDK does.
const aiClientKind = process.env.FRAMEFLOW_PRODUCT_AI_CLIENT;
const liveWithFakeClient = !aiClientKind ? undefined : aiClientKind === 'recorded'
  ? liveProductAnalyzer({ model: 'gpt-5.6-sol (recorded answer, replayed)', client: recordedResponsesClient(JSON.parse(readFileSync('tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.response.json', 'utf8')), GANESH_LG_SIZE) })
  : liveProductAnalyzer({ model: 'gpt-5.6-sol', client: failingResponsesClient(aiClientKind as FailingKind) });
// `model` is the analyser that answered the last request (detection records it: a replayed real answer is labelled so).
let lastProductModel = 'offline-test-analyser';
const productAnalyzer = { get model() { return lastProductModel; }, get calls() { return fixtureAnalyzer.calls + handmadeAnalyzer.calls + (recordedAnalyzer?.calls ?? 0); },
  async analyze(image: Buffer, mime: string, save: (file: string, value: object) => void) { const m = await sharp(image).metadata();
    lastProductModel = 'offline-test-analyser';
    if (liveWithFakeClient) { lastProductModel = liveWithFakeClient.model; return liveWithFakeClient.analyze(image, mime, save); }
    if (recordedAnalyzer && m.width === GANESH_LG_SIZE.width) { lastProductModel = recordedAnalyzer.model; return recordedAnalyzer.analyze(image, mime, save); }
    if (realProduct && handmade && m.width === GANESH_LG_SIZE.width) { await handmadeAnalyzer.analyze(image, mime, save); return parseProductScene(handmade.ganeshWordManifest({ width: m.width!, height: m.height! }), { width: m.width!, height: m.height! }); } return fixtureAnalyzer.analyze(image, mime, save); } };
// Style variations: the word-analysis poster and the words its fake recognizer reads (variationPoster.fixture.ts). No OCR runs.
const variationRecognizer = fakeRecognizer(VARIATION_WORDS);
async function complexLayers(requestId: string, base: readonly OfferPart[], parts: OfferPart[], duplicates: OfferPart[] = []) {
  const entries: [string, Buffer][] = [['Background', await offerComposite(base)], ...await Promise.all([...parts, ...duplicates].map(async part => [partName(part), await offerPart(part)] as [string, Buffer]))];
  return entries.map(([name, png], z_index) => { const url = `https://v3b.fal.media/files/offline/${requestId}-${z_index}.png`; files.set(url, png); return { image: { url }, z_index, name }; });
}
const transport: FalTransport = {
  upload: async bytes => { callCounts.fal++; const url = `https://v3b.fal.media/files/offline/input-${inputs.size}.png`; inputs.set(url, bytes); return url; },
  submit: async (_endpoint, input) => {
    callCounts.fal++; callCounts.seedream++;
    const bytes = inputs.get(String(input.image_url))!; submitted.push(digest(bytes));
    const residual = String(input.prompt ?? '').startsWith(RESIDUAL_PROMPT.slice(0, 60));
    const { width = 1024, height = 1024 } = await sharp(bytes).metadata();
    const requestId = `offline-${results.size}`;
    if (!residual && masterEcho.has(await pixelsDigest(bytes))) {
      providerCalls.push({ kind: 'seedream-initial' });
      const url = `https://v3b.fal.media/files/offline/${requestId}-master-0.png`; files.set(url, await sharp(bytes).png().toBuffer());
      results.set(requestId, { layers: [{ image: { url }, z_index: 0, name: 'Clean background' }] }); return { requestId };
    }
    const protectedBase = residual ? undefined : await ptMarkerOf(bytes);
    if (protectedBase === 'refuse') { providerCalls.push({ kind: 'seedream-initial' }); partnerRefused.add(requestId); results.set(requestId, { refused: true }); return { requestId }; }
    if (protectedBase === 'ok') {
      providerCalls.push({ kind: 'seedream-initial' });
      const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < PT_SIZE.height; y++) for (let x = 0; x < PT_SIZE.width; x++) if (!(x >= 520 && x < 780 && y >= 420 && y < 940)) raw[(y * PT_SIZE.width + x) * 4 + 3] = 0;
      const layers = await Promise.all([await sharp(bytes).png().toBuffer(), await sharp(raw, { raw: { ...PT_SIZE, channels: 4 } }).png().toBuffer()].map(async (png, z_index) => {
        const url = `https://v3b.fal.media/files/offline/${requestId}-protected-${z_index}.png`; files.set(url, png); return { image: { url }, z_index, name: z_index ? 'Phone' : 'Background' };
      }));
      results.set(requestId, { layers }); return { requestId };
    }
    if (!residual && rejectFirstExtraction.delete(digest(bytes))) rejectedRequests.add(requestId);
    else if (!residual && !markerRejected.has(digest(bytes)) && await hasMarker(bytes)) { markerRejected.add(digest(bytes)); rejectedRequests.add(requestId); }
    if (!residual && curationImages.has(await pixelsDigest(bytes))) {
      providerCalls.push({ kind: 'seedream-initial' });
      const layers = await Promise.all((await curation).layers.map(async (layer, z_index) => {
        const url = `https://v3b.fal.media/files/offline/${requestId}-curation-${z_index}.png`;
        files.set(url, await sharp(layer.png).resize(width, height).png().toBuffer());
        return { image: { url }, z_index, name: layer.name };
      }));
      results.set(requestId, { layers }); return { requestId };
    }
    if (!residual && digest(bytes) === await panelDigest) {
      providerCalls.push({ kind: 'seedream-initial' });
      const parts: [string, (keyof typeof PANEL_PARTS)[]][] = [['Background', ['base']], ['Global canvas background', ['plate']], ['Rounded orange gradient panel backdrop', ['panel']], ['Person presenting', ['person']]];
      const layers = await Promise.all(parts.map(async ([name, keys], z_index) => { const url = `https://v3b.fal.media/files/offline/${requestId}-panel-${z_index}.png`; files.set(url, await panelPng(...keys)); return { image: { url }, z_index, name }; }));
      results.set(requestId, { layers }); return { requestId };
    }
    if (!residual && digest(bytes) === await complexDigest) {
      providerCalls.push({ kind: 'seedream-initial', complex: true }); complexResidualNext = true;
      results.set(requestId, { layers: await complexLayers(requestId, ALL_PARTS, ALL_PARTS.filter(part => part !== 'speaker' && part !== 'powerBank')) });
      return { requestId };
    }
    for (const [creativeDigest, parts, black] of [[await holdingDigest, HOLDING_PARTS, true], [await bangleDigest, BANGLE_PARTS, false]] as const) {
      if (residual || digest(bytes) !== creativeDigest) continue;
      providerCalls.push({ kind: 'seedream-initial' }); blackEditNext = black;
      // The base is the whole creative (everything baked in); every other part is its own layer, as Seedream split them.
      const layers = await Promise.all(parts.map(async (part, z_index) => {
        const url = `https://v3b.fal.media/files/offline/${requestId}-${part.key}.png`;
        files.set(url, z_index === 0 ? await creative(parts) : await partPng(part));
        return { image: { url }, z_index, name: z_index === 0 ? 'Background' : part.name };
      }));
      results.set(requestId, { layers });
      return { requestId };
    }
    if (residual && complexResidualNext) {
      providerCalls.push({ kind: 'seedream-residual', complex: true }); complexResidualNext = false;
      results.set(requestId, { layers: await complexLayers(requestId, [], ['speaker', 'powerBank'], ['headphones']) });
      return { requestId };
    }
    providerCalls.push({ kind: residual ? 'seedream-residual' : 'seedream-initial' });
    const offset = offsetLayoutImages.has(await pixelsDigest(bytes));
    const layers = await Promise.all((['background', 'phone'] as const).map(async (part, z_index) => {
      const url = `https://v3b.fal.media/files/offline/${requestId}-${part}.png`;
      files.set(url, await artwork(width, height, part, offset));
      return { image: { url }, z_index, name: part === 'phone' ? 'Lavender phone' : 'Studio background' };
    }));
    results.set(requestId, { layers });
    return { requestId };
  },
  status: async () => { callCounts.fal++; return 'COMPLETED'; },
  result: async (_endpoint, id) => {
    callCounts.fal++; await pause();
    if (partnerRefused.has(id)) {
      // The provider's partner content check, as answered live on 2026-10-19 (request 01a1539b-…): the reason is not disclosed.
      const detail = { msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation', loc: 'body.image_url', reason: 'partner_validation_failed' };
      throw Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request. Check the saved input and provider account.', false, 422),
        { providerDetail: { status: 422, billableUnits: '0', requestId: id, messages: [detail] } });
    }
    if (rejectedRequests.has(id)) {
      // fal's intake refusal: answered in the submission second, 0 billable units, a generic invalid_request on the image.
      const detail = { msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request', loc: 'body.image_url' };
      const error = Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request. Check the saved input and provider account.', false, 422),
        { providerDetail: { status: 422, billableUnits: '0', requestId: id, messages: [detail] } });
      Object.defineProperty(error, 'providerBody', { value: { status: 422, headers: { date: new Date().toUTCString(), 'x-fal-billable-units': '0', 'x-fal-request-id': id }, body: { detail: [{ ...detail, loc: ['body', 'image_url'] }] } }, enumerable: false });
      throw error;
    }
    return results.get(id);
  },
  cancel: async () => undefined,
  download: async url => { callCounts.fal++; const bytes = files.get(url); if (!bytes) throw new Error('Unknown fixture layer.'); return bytes; },
};
// Image-template decompositions ask for the semantic analysis (semanticPlanner.ts); the test panel's runs for the plain plan.
const semanticAnalysis: SemanticAnalysis = { image_type: 'product photograph', scene_summary: 'A lavender smartphone standing in a lavender studio.',
  elements: [
    { id: 'studio_background', type: 'background', description: 'The lavender studio background with its soft shapes', editable_independently: true, approximate_region: 'full canvas', z_order: 0, confidence: 'high', occlusion: { is_occluded: true, occluded_by: ['lavender_phone'], requires_reconstruction: true }, attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } },
    { id: 'lavender_phone', type: 'product', description: 'The lavender smartphone, whole', editable_independently: true, approximate_region: 'center', z_order: 1, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } },
  ],
  relationships: [{ source: 'lavender_phone', relationship: 'in_front_of', target: 'studio_background' }], ambiguities: [], recommended_layer_count: 2,
  decomposition_strategy: 'Separate the phone from the studio.', downstream_decomposition_prompt: 'Extract the lavender phone as a whole object. Separate the studio background.' };
/**
 * The planner's answer for the fixture creatives a test uploads to Create New Template: their elements described with
 * the very names the fake Seedream gives their layers (so the plan's coverage can be verified), with structural roles
 * and held/worn attachments. Any other image gets the lavender phone answer.
 */
type KnownCreative = { analysis: SemanticAnalysis; roles: Record<string, TemplateRole>; name: string; description: string };
const unattached = { relation: 'none' as const, parent_id: '', separation_risk: 'low' as const, keep_with_parent: false };
const element = (id: string, description: string, type: string, z: number, attachment: SemanticElement['attachment'] = unattached, region = 'as in the image'): SemanticElement =>
  ({ id, type, description, editable_independently: true, approximate_region: region, z_order: z, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false }, attachment });
const analysisOf = (summary: string, elements: SemanticElement[], relationships: SemanticAnalysis['relationships'] = []): SemanticAnalysis => ({ image_type: 'offer creative', scene_summary: summary, elements, relationships,
  ambiguities: [], recommended_layer_count: elements.length, decomposition_strategy: 'Separate every element named here.', downstream_decomposition_prompt: `Create ${elements.length} layers back-to-front: ${elements.map(e => e.description).join('; ')}.` });
const OFFER_ROLE: Record<OfferPart, TemplateRole> = { pedestal: 'prop', giftBox: 'main_product', speaker: 'main_product', powerBank: 'main_product', headphones: 'main_product', earbuds: 'main_product', watch: 'main_product', confetti: 'decoration', text: 'headline' };
const offerCreative: KnownCreative = { name: 'Multi-Product Offer', description: 'Several products with a prop and decorations under a headline, in front of a background.',
  analysis: analysisOf('A sale offer with seven products on a pedestal under a headline.', [element('backdrop_gradient', 'Background', 'background', 0, unattached, 'full canvas'), ...OFFER_PARTS.map((part, i) => element(part.key, part.name, OFFER_ROLE[part.key] === 'main_product' ? 'product' : OFFER_ROLE[part.key], i + 1))]),
  roles: { backdrop_gradient: 'background', ...OFFER_ROLE } };
/** The recorded live analyses (protectedInteraction.fixture.ts), described with the fake Seedream's layer names. */
const describedAs = (analysis: SemanticAnalysis, names: Record<string, string>): SemanticAnalysis => ({ ...analysis, elements: analysis.elements.map(e => ({ ...e, description: names[e.id] ?? e.description })) });
const holdingCreative: KnownCreative = { name: 'Subject Holding Product', description: 'A primary subject holding an object beside a headline and a call to action.',
  analysis: describedAs(holdingAnalysis('high'), { background_white: 'Light studio background', yellow_field: 'Bright yellow curved decorative field', headline_text: 'Black headline text', cta_pill: 'Navy rounded CTA pill',
    woman_base: 'Woman base', phone_device: 'Smartphone with white screen', success_badge: 'Green success badge on the screen', phone_grip_foreground: 'Foreground gripping finger fragments' }),
  roles: { background_white: 'background', yellow_field: 'backdrop', headline_text: 'headline', cta_pill: 'cta', woman_base: 'primary_subject', phone_device: 'held_object', success_badge: 'decoration', phone_grip_foreground: 'effect' } };
const bangleCreative: KnownCreative = { name: 'Worn Product Showcase', description: 'Three subjects wearing products with a supporting product under a headline.',
  analysis: describedAs(bangleAnalysis(), { background_red: 'Deep red gradient background', left_hands: 'Left paired hands', left_bangles: 'Left Coorgi gold bangle stack', center_hands: 'Center crossed hands',
    center_bangles: 'Center South-Indian gold bangle cluster', right_hands: 'Right paired hands', right_bangles: 'Right Bengali gold bangle stack', standalone_bangle: 'Standalone gold bangle product', main_headline: '"BANGLES OF INDIA" headline' }),
  roles: { background_red: 'background', left_hands: 'primary_subject', left_bangles: 'main_product', center_hands: 'secondary_subject', center_bangles: 'main_product', right_hands: 'secondary_subject', right_bangles: 'main_product',
    standalone_bangle: 'supporting_product', main_headline: 'headline' } };
const panelCreative: KnownCreative = { name: 'Subject on a Panel', description: 'A primary subject in front of a rounded panel on a plain canvas.',
  analysis: analysisOf('A person presenting in front of a rounded panel on a white canvas.', [element('background_canvas', 'Global canvas background', 'background surface', 0, unattached, 'full canvas'),
    element('orange_backdrop', 'Rounded orange gradient panel backdrop', 'rounded graphic panel', 1, unattached, 'center'), element('presenter', 'Person presenting', 'person', 2, unattached, 'center')]),
  roles: { background_canvas: 'background', orange_backdrop: 'backdrop', presenter: 'primary_subject' } };
const CURATION_ROLES: Record<string, TemplateRole> = { seated_model: 'primary_subject', held_phone: 'held_object', oversized_phone: 'main_product', headline_outline: 'effect', headline: 'headline', pro_badge: 'badge', secondary_text: 'body_text' };
/** A small thumbnail: the planner may receive a resized copy, so a known creative is recognized by its look, not its bytes. */
const thumb = (bytes: Buffer) => sharp(bytes).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const knownCreatives = (async () => [
  { look: await thumb(await offerComposite()), creative: offerCreative }, { look: await thumb(await creative(HOLDING_PARTS)), creative: holdingCreative },
  { look: await thumb(await creative(BANGLE_PARTS)), creative: bangleCreative }, { look: await thumb(await panelCreativePng()), creative: panelCreative },
  { look: await thumb((await curation).source), creative: { analysis: (await curation).semantic, roles: CURATION_ROLES, name: 'Subject with Product', description: 'A seated primary subject holding an object beside a main product, a headline and a badge.' } },
])();
async function knownCreative(image: Buffer): Promise<KnownCreative | undefined> {
  const look = await thumb(image);
  return (await knownCreatives).find(k => k.look.reduce((sum, value, i) => sum + Math.abs(value - look[i]), 0) / look.length < 4)?.creative;
}
const captureOf = (known: KnownCreative) => ({ ...known.analysis, elements: known.analysis.elements.map(e => ({ ...e, template_role: known.roles[e.id] })), reusable_template: { name: known.name, description: known.description } });
const planner = createOpenAIPlanner({ model: 'gpt-5.6-sol', client: { responses: { create: async (request: { text: { format: { schema: unknown } }; input: { content: { image_url?: string }[] }[] }) => {
  callCounts.openai++;
  const image = request.input[0].content.find(c => c.image_url)?.image_url, bytes = image ? Buffer.from(image.split(',')[1], 'base64') : undefined;
  const known = bytes && await knownCreative(bytes), offset = bytes && offsetLayoutImages.has(await pixelsDigest(bytes)), schema = request.text.format.schema;
  const lavenderCapture = { ...semanticAnalysis, elements: semanticAnalysis.elements.map(e => ({ ...e, ...(offset && e.type === 'product' ? { approximate_region: 'middle left' } : {}), template_role: e.type === 'background' ? 'background' : 'main_product' })),
    reusable_template: { name: offset ? 'Offset Product' : 'Centered Product', description: offset ? 'One product on the left of a full background.' : 'One central product on a full background.' } };
  return { id: 'offline-planner-request', usage: plannerUsage, status: 'completed', output: [], output_text: JSON.stringify(schema === TEMPLATE_CAPTURE_SCHEMA ? known ? captureOf(known) : lavenderCapture
    : schema === SEMANTIC_SCHEMA ? known?.analysis ?? semanticAnalysis : {
      prompt: 'Extract the lavender phone as a whole object. Separate the studio background.', planned_layers: [{ name: 'Lavender phone', description: 'The main product, in one layer.' }], warnings: [],
    }) };
} } } as never });
/** The lavender phone artwork as the scene analysis describes it (synthetic, not a recorded answer). */
const phoneScene = () => parseSceneDescription({ summary: 'A lavender smartphone standing in a lavender studio.', objects: [
  { id: 'studio', kind: 'scenery', importance: 'background', category: 'background', description: 'Lavender studio with soft shapes', box: { x: 0, y: 0, w: 1, h: 1, certainty: 'approximate' }, occluded: true, properties: [{ key: 'color', value: 'lavender' }], identity: { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' }, confidence: 0.95 },
  { id: 'phone', kind: 'product', importance: 'main', category: 'smartphone', description: 'Lavender smartphone with a dual camera', box: { x: 0.345, y: 0.19, w: 0.31, h: 0.57, certainty: 'tight' }, occluded: false, properties: [{ key: 'color', value: 'lavender' }],
    identity: { brand: 'Lumen', model: '', evidence: 'a logo disc on the back', confidence: 0.7, markings: 'physical' }, confidence: 0.94 }],
  relations: [], marks: [{ id: 'logo', kind: 'product_brand', text: '', owner_id: 'phone', overlay: false, box: { x: 0.465, y: 0.455, w: 0.08, h: 0.08, certainty: 'approximate' } }], text_overlays: [],
  lighting: { direction: 'left', quality: 'soft', color: 'neutral' }, main_candidates: ['phone'], uncertainties: [] });
const textUsage = (model: string) => ({ model, id: 'offline-text', usage: referenceUsage });
const router = createLayerizeRouter({
  // Smart edits and creative variants: every model and fal call faked, each counted like the others.
  smart: { analysesDir: join(root, 'analyses'), variantsDir: join(root, 'variants'), env: {},
    analyzer: () => ({ model: 'gpt-5.6-sol', analyze: async (_image, _mime, save) => { callCounts.openai++; await pause(); save('scene.openai-request.json', { model: 'gpt-5.6-sol' }); save('scene.openai-response.json', textUsage('gpt-5.6-sol')); return phoneScene(); } }),
    resolver: () => ({ model: 'gpt-5.6-sol', resolve: async (input, save) => {
      callCounts.openai++; save('resolution.openai-request.json', { model: 'gpt-5.6-sol' }); save('resolution.openai-response.json', textUsage('gpt-5.6-sol'));
      const words = Object.values(input.draft.edits).map(e => e.value ?? '').join(' '), brand = /xiaomi/i.test(words) ? 'Xiaomi' : '';
      const target = Object.keys(input.draft.edits).find(id => input.draft.edits[id].action === 'replace') ?? '';
      return { understanding: brand && target ? [{ targetId: target, brand, brandSource: 'inferred', identity: `a ${brand} smartphone`, specificity: 'brand_and_category' }] : [], inferred: [], conflicts: [],
        productPhoto: { present: false, category: '', brand: '', evidence: '', matchesRequest: 'unclear', description: '' } } satisfies ResolverProposal;
    } }),
    verifier: () => ({ model: 'gpt-5.6-sol', verify: async (input, save) => { callCounts.openai++; save('verification.openai-request.json', { model: 'gpt-5.6-sol' }); save('verification.openai-response.json', textUsage('gpt-5.6-sol'));
      return input.expectations.map((e): SemanticCheck => ({ id: e.id, status: 'pass', message: 'Consistent in the offline check.' })); } }),
    concepts: () => ({ model: 'gpt-5.6-sol', write: async (input, save) => { callCounts.openai++; save('concepts.openai-request.json', { model: 'gpt-5.6-sol' }); save('concepts.openai-response.json', textUsage('gpt-5.6-sol'));
      // Structured art directions, two of them recolours of another (the app must leave those out). "failure drill" in
      // the direction makes the paper-shapes creative's image request fail.
      const drill = /failure drill/.test(input.direction ?? ''), theme = input.direction ? `after: ${input.direction}` : '';
      const marble = { title: 'Marble studio', family: 'studio', theme, environment: 'a seamless warm grey studio sweep', surface: 'a polished marble plinth', props: [], palette: ['warm grey', 'ivory'], lighting: 'soft window light from the left', mood: 'precise', camera: 'eye-level', composition: { x: 0.5, y: 0.6, scale: 0.6, copy_space: 'top' } };
      const rooftop = { title: 'Rooftop dusk', family: 'architectural', theme, environment: 'a concrete rooftop at dusk with city lights far below', surface: 'a wet concrete ledge with glossy puddles', props: ['a potted olive tree'], palette: ['indigo', 'amber'], lighting: 'cool dusk light with warm city glow', mood: 'urban', camera: 'low-angle', composition: { x: 0.62, y: 0.62, scale: 0.55, copy_space: 'left' } };
      const pool = [marble, { ...marble, title: 'Marble studio in rose', palette: ['rose', 'ivory'] }, rooftop, { ...rooftop, title: 'Rooftop dusk in teal', palette: ['teal', 'amber'] },
        { title: 'Paper shapes', family: 'abstract', theme, environment: `floating pastel paper shapes in a calm set${drill ? ', Variant failure test' : ''}`, surface: 'a folded paper riser', props: ['paper arches'], palette: ['peach', 'lilac'], lighting: 'even diffused light', mood: 'playful', camera: 'high-angle', composition: { x: 0.4, y: 0.55, scale: 0.65, copy_space: 'right' } },
        { title: 'Desert light', family: 'nature', theme, environment: 'sand dunes at golden hour', surface: 'a flat sandstone slab', props: ['dry grass'], palette: ['sand', 'burnt orange'], lighting: 'low golden sun from the right', mood: 'warm', camera: 'eye-level', composition: { x: 0.5, y: 0.66, scale: 0.5, copy_space: 'bottom' } },
        { title: 'Festive table', family: 'festive', theme, environment: 'a dinner table with brass diyas and marigold garlands', surface: 'a carved wooden tray', props: ['marigolds', 'brass diyas'], palette: ['saffron', 'maroon', 'gold'], lighting: 'warm candle glow', mood: 'joyful', camera: 'high-angle', composition: { x: 0.56, y: 0.58, scale: 0.6, copy_space: 'none' } }];
      return pool.slice(0, input.count); } }),
    segmenter: () => ({ provider: 'sam3', segment: async ({ width, height }) => { callCounts.fal++; await pause();
      return { mask: await svgPng(width, height, '<rect width="1000" height="1000" fill="#000"/><rect x="345" y="190" width="310" height="570" rx="45" fill="#fff"/>'), requestIds: ['offline-sam3'] }; } }),
  },
  runsDir: join(root, 'runs'), imageTemplatesDir: join(root, 'templates'), protectedDir: join(root, 'protected'), wordRecognizer: () => variationRecognizer, masterRecognizer: () => masterRecognizer,
  // Product with Text templates: the fixture poster's words (no OCR), the fixture's vision answer and a fake cut-out service, each counted.
  productRecognizer: () => productRecognizer, productAnalyzer: () => productAnalyzer, productSegmenter: () => productSegmenter, productLayerizer: () => productLayerizer, productPlacement: () => reusePlacement, productArtwork: () => productArtwork,
  templatesDir: join(root, 'creative-templates'), executionsDir: join(root, 'executions'),
  inspector: () => ({ model: 'gpt-5.6-luna', inspect: async (_bytes, _mime, save) => {
    callCounts.openai++;
    save('structure.openai-request.json', { model: 'gpt-5.6-luna' });
    save('structure.openai-response.json', { model: 'gpt-5.6-luna', id: 'offline-structure', usage: referenceUsage });
    return parseStructure({ confidence: 0.96, elements: [
      { id: 'background', role: 'background', zone: 'full-canvas', independent: true, parent: '', attachment: 'none', keepWithParent: false, currentValue: 'Studio background' },
      { id: 'product', role: 'main_product', zone: 'center', independent: true, parent: '', attachment: 'none', keepWithParent: false, currentValue: 'Green phone' },
    ], relationships: [] });
  } }),
  access: { production: true, clientOrigin: origin },
  generation: (): GenerationConfig => ({ model: 'gpt-image-2', client: () => ({ images: { generate: async () => { throw new Error('Image templates must use images.edit.'); }, edit: generate } }) as unknown as ReturnType<GenerationConfig['client']> }),
  imagePrompt: () => createOpenAIImagePromptWriter({ model: 'gpt-5-mini', client: { responses: { create: async (request: { input: { content: { image_url?: string }[] }[] }) => {
    callCounts.openai++; await pause();
    const image = request.input[0].content.find(item => item.image_url)!.image_url!;
    const input = Buffer.from(image.split(',')[1], 'base64');
    const source = sources.get(digest(input)) ?? digest(input);
    events.push({ kind: 'analysis', source });
    if (analysisBehaviors.get(source) === 'fail' && events.filter(e => e.source === source && e.kind === 'analysis').length === 1) throw new Error('Fixture analysis failure');
    const { width } = await sharp(input).metadata();
    if (width === 600) return { id: 'offline-reference-analysis', usage: referenceUsage, status: 'completed', output: [], output_text: JSON.stringify(referenceCreativeFixture) };
    const characters = width === 900 ? 3344 : 4002;
    return { id: `offline-analysis-${characters}`, usage: referenceUsage, status: 'completed', output: [], output_text: JSON.stringify(verboseImageAnalysis(characters)) };
  } } } as never }),
  // The clean-background edit: a local row fill (exact for the complex offer's vertical gradient); never a network call.
  deps: () => ({ planner, transport: () => transport, backgroundReconstructor: { model: 'offline-image-edit', reconstruct: async ({ image, mask }) => {
    providerCalls.push({ kind: 'background-edit' }); callCounts.openai++; await pause();
    const black = blackEditNext; blackEditNext = false;
    return { image: black ? await blackSilhouetteEdit(image, mask) : await rowFillEdit(image, mask), requestId: `offline-edit-${providerCalls.length}` };
  } } }),
});
// Template Studio with MOCKED OpenAI answers and SAM-3 masks: synthetic scenes, never real generations.
const studioProvider = new FakeProvider();
studioProvider.delayMs = 300;
const studioRouter = createTemplateStudioRouter({ env: parseStudioEnv({}, join(root, 'template-studio')), provider: studioProvider, segmenter: () => fakeSegmenter(), runsDir: join(root, 'runs'),
  protectedDir: join(root, 'protected'), recognizer: () => variationRecognizer, masterRecognizer: () => masterRecognizer,
  access: { production: true, clientOrigin: origin }, falConfigured: true, log: () => undefined });
// Explicit empty configuration: no environment credentials or .env files are read.
const app = createApp(readConfig({ CLIENT_ORIGIN: origin }), undefined, () => undefined, undefined, undefined, router, undefined, studioRouter);
// Template Studio's fake provider calls (prompts and instructions), and synthetic posters and products to upload.
app.get('/__test__/studio-calls', (_req, res) => res.json(studioProvider.calls.map(c => ({ kind: c.kind, schemaName: c.schemaName, system: c.system, prompt: c.prompt, images: c.images, fidelityMode: c.data?.fidelityMode, masterId: (c.data?.master as { id?: string } | undefined)?.id }))));
app.get('/__test__/studio-reference.png', async (_req, res) => res.type('png').send(await referencePosterPng()));
app.get('/__test__/studio-product.png', async (req, res) => res.type('png').send(await productPhotoPng(String(req.query.colour ?? '#8b929c'))));
app.get('/__test__/studio-cutout.png', async (_req, res) => res.type('png').send(await productCutoutPng()));
app.get('/__test__/studio-logo.png', async (_req, res) => res.type('png').send(await logoPng('#14325c')));
app.get('/__test__/studio-brand-rules', (_req, res) => res.json(TEST_BRAND_RULES));
// Clone a persisted fake run into a billing-unknown failure; this route exists ONLY in the offline fixture.
app.post('/__test__/dashboard-failure/:id', (req, res) => {
  if (!/^[0-9TZa-f-]+$/.test(req.params.id)) return void res.status(400).end();
  // Saved Runs lists the newest 20 IDs: a fixed old timestamp disappears during the full suite.
  const now = new Date().toISOString(), id = `${now.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const original = join(root, 'runs', req.params.id), dir = join(root, 'runs', id);
  cpSync(original, dir, { recursive: true });
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  Object.assign(run, { id, stage: 'failed', createdAt: now, updatedAt: now,
    error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', stage: 'queued', message: 'Offline technical failure details' }, layers: [], outputLayers: [], editorLayerFiles: [] });
  delete run.refinement; delete run.layerCount;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
  for (const file of ['seedream-response.json', 'raw-layers.json']) rmSync(join(dir, file), { force: true });
  res.json({ id });
});
// The curation creative: its fake Seedream answer has 13 raw candidates, of which 6 are worth editing.
app.get('/__test__/curation.png', async (_req, res) => { const { source } = await curation; curationImages.add(await pixelsDigest(source)); res.type('png').send(source); });
app.get('/__test__/complex-offer.png', async (_req, res) => res.type('png').send(await offerComposite()));
app.get('/__test__/holding-phone.png', async (_req, res) => res.type('png').send(await creative(HOLDING_PARTS)));
app.get('/__test__/bangles.png', async (_req, res) => res.type('png').send(await creative(BANGLE_PARTS)));
app.get('/__test__/panel.png', async (_req, res) => res.type('png').send(await panelCreativePng()));
// The run's background layer measured against the true scene where the people (and what they hold or wear) were:
// share of those pixels within 30 of the truth, and how many are near-black.
app.get('/__test__/background-check', async (req, res) => {
  const runDir = join(root, 'runs', String(req.query.run).replace(/[^0-9TZa-f-]/g, '')), holding = req.query.creative === 'holding';
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { outputLayers: { file: string }[] };
  const raw = (png: Buffer) => sharp(png).resize(1024, 1024, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const background = await raw(readFileSync(join(runDir, run.outputLayers[0].file)));
  // The clean background is the base canvas alone: the yellow field is a backdrop layer of its own.
  const parts = holding ? HOLDING_PARTS : BANGLE_PARTS, scene = parts.filter(p => p.key === 'background');
  const removed = parts.filter(p => holding ? ['woman', 'phone', 'fingers', 'badge'].includes(p.key) : /Hands|Bangles/.test(p.key));
  const truth = await raw(await creative(scene));
  const alphas = await Promise.all(removed.map(async p => sharp(await partPng(p)).ensureAlpha().extractChannel(3).raw().toBuffer()));
  let area = 0, match = 0, black = 0;
  for (let i = 0; i < 1024 * 1024; i++) {
    if (!alphas.some(a => a[i] > 200)) continue;
    area++;
    if (Math.max(...[0, 1, 2].map(c => Math.abs(background[i * 3 + c] - truth[i * 3 + c]))) <= 30) match++;
    if (Math.max(background[i * 3], background[i * 3 + 1], background[i * 3 + 2]) < 60) black++;
  }
  res.json({ file: run.outputLayers[0].file, area, matchShare: Math.round(1000 * match / Math.max(1, area)) / 1000, black });
});
app.get('/__test__/provider-calls', (_req, res) => res.json(providerCalls));
// Master templates: OCR reads so far, a synthetic offer poster and logo, the reference posters when present on this machine,
// and a master's clean background registered for the fake Seedream's echo.
app.get('/__test__/master-ocr-calls', (_req, res) => res.json({ calls: masterOcrCalls }));
app.get('/__test__/product-poster.png', async (_req, res) => res.type('png').send(await productPosterPng()));
app.get('/__test__/ganesh-sheet.png', (_req, res) => { const p = resolve('Ganesh-Chaturthi.png'); if (!existsSync(p)) { res.status(404).json({ error: 'not available' }); return; } res.type('png').send(readFileSync(p)); });
app.post('/__test__/product-fail-after-one', (_req, res) => { reuseProof?.failProductAfter(2); res.json({ testOnly: true }); });
app.get('/__test__/reuse-layerize-input.png', (_req, res) => { const bytes = reuseProof?.layerizer.calls[0]?.image; if (!bytes) { res.sendStatus(404); return; } res.type('image/png').send(bytes); });
app.get('/__test__/placement-calls', (_req, res) => res.json({ calls: placementCalls }));
app.get('/__test__/product-calls', (_req, res) => res.json({ decompositionInputs: reuseProof?.layerizer.calls.map(c => ({ excluded: c.excluded, elements: c.elements, width: c.width, height: c.height })) ?? [], submissions: reuseProof?.submissions ?? [], productPrompts: reuseProof?.prompts ?? [], analyzer: productAnalyzer.calls, segmenter: productSegmenter.calls.length, layerizer: productLayerizer?.calls.length ?? 0, recognizer: productRecognizer.calls.length, artwork: typeof productArtwork.calls === 'number' ? productArtwork.calls : productArtwork.calls.length }));
app.get('/__test__/product-sheet.png', async (_req, res) => { const p = await productPosterPng(); res.type('png').send(await sharp({ create: { width: 2200, height: 1400, channels: 3, background: '#f5f5f5' } }).composite([{ input: p, left: 60, top: 100 }, { input: p, left: 1140, top: 100 }]).png().toBuffer()); });
app.get('/__test__/product-packshot.png', async (_req, res) => res.type('png').send(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400"><rect width="240" height="400" fill="#ffffff"/><rect x="40" y="30" width="160" height="340" rx="20" fill="#1e40af"/><circle cx="120" cy="250" r="50" fill="#93c5fd"/></svg>')).png().toBuffer()));
app.get('/__test__/master-poster.png', async (_req, res) => res.type('png').send(await masterPosterPng()));
app.get('/__test__/master-logo.png', async (_req, res) => res.type('png').send(await newLogoPng()));
app.get('/__test__/master-art-poster.png', async (_req, res) => res.type('png').send(await artworkPosterPng()));
app.get('/__test__/reference-poster/:name', (req, res) => {
  const dir = resolve(process.env.FRAMEFLOW_MASTER_REFERENCE_DIR ?? join(homedir(), 'Downloads', 'pL-Templates')), name = String(req.params.name);
  if (!/^[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/.test(name) || !existsSync(join(dir, name))) { res.status(404).json({ error: 'not available' }); return; }
  res.type(name.endsWith('png') ? 'png' : 'jpeg').send(readFileSync(join(dir, name)));
});
app.post('/__test__/seedream-echo/:id', async (req, res) => {
  const t = JSON.parse(readFileSync(join(root, 'protected', String(req.params.id).replace(/[^a-z0-9-]/g, ''), 'template.json'), 'utf8')) as { base?: { file: string } };
  if (!t.base) { res.status(409).json({ error: 'no base' }); return; }
  masterEcho.add(await pixelsDigest(readFileSync(join(root, 'protected', String(req.params.id), t.base.file)))); res.json({ ok: true });
});
app.get('/__test__/protected-source.png', async (req, res) => res.type('png').send(await ptSource(req.query.refuse === '1' ? 'refuse' : 'ok', String(req.query.seed ?? ''))));
app.get('/__test__/protected-clean.png', async (req, res) => res.type('png').send(await ptClean(req.query.refuse === '1' ? 'refuse' : 'ok', String(req.query.seed ?? ''))));
app.get('/__test__/variation-poster.png', async (req, res) => res.type('png').send(await variationPosterPng(String(req.query.seed ?? ''))));
app.get('/__test__/variation-logo.png', async (_req, res) => res.type('png').send(await replacementLogoPng()));
app.get('/__test__/recognizer-calls', (_req, res) => res.json({ template: variationRecognizer.calls.filter(c => c.purpose === 'template').length, artwork: variationRecognizer.calls.filter(c => c.purpose === 'artwork-check').length }));
app.get('/__test__/protected-logo-a.png', async (_req, res) => res.type('png').send(await ptSvg(PT_LOGO_A, 200, 80)));
app.get('/__test__/protected-logo-b.png', async (_req, res) => res.type('png').send(await ptSvg(PT_LOGO_B, 100, 100)));
app.get('/__test__/protected-logo-new.png', async (_req, res) => res.type('png').send(await ptSvg(PT_LOGO_NEW, 200, 80)));
// Seedream submissions of one image (by its sha256): exact per test while other specs share the server.
app.get('/__test__/extractions', (req, res) => res.json({ count: submitted.filter(s => s === String(req.query.image)).length }));
app.get('/__test__/call-counts', (_req, res) => res.json(callCounts));
// Image requests whose prompt carries a test's own token: an exact count even while other specs share this server.
app.get('/__test__/image-calls', (req, res) => res.json({ count: events.filter(e => e.kind === 'generation' && e.prompt?.includes(String(req.query.contains ?? '\u0000'))).length }));
app.get('/__test__/reference-events', (req, res) => res.json(events.filter(event => event.source === String(req.query.source))));
app.get('/__test__/offer-reference.png', async (req, res) => {
  const seed = String(req.query.seed ?? ''), color = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  const bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#e5edf5"/><rect x="285" y="100" width="280" height="380" rx="40" fill="#c4d4e8"/><text x="40" y="170" font-size="38" fill="#20334a">Sound.</text><text x="40" y="212" font-size="38" fill="#20334a">Redefined.</text><path d="M350 285V245A72 72 0 0 1 144 0V285" fill="none" stroke="#68798c" stroke-width="20"/><rect x="326" y="272" width="48" height="120" rx="20" fill="#8195ad"/><rect x="470" y="272" width="48" height="120" rx="20" fill="#8195ad"/><rect x="40" y="475" width="175" height="50" rx="12" fill="#20334a"/><text x="62" y="508" fill="white" font-size="19">DISCOVER</text><rect x="10" y="10" width="8" height="8" fill="#${color}"/></svg>`)).png().toBuffer();
  const source = digest(bytes), normalized = await referenceForPrompt(bytes);
  sources.set(digest(normalized.bytes), source); analysisBehaviors.set(source, req.query.failAnalysis === '1' ? 'fail' : '');
  res.setHeader('x-fixture-source', source); res.type('png').send(bytes);
});
app.get('/__test__/reference.png', async (req, res) => {
  const side = req.query.analysis === '3344' ? 900 : 1024, offset = req.query.shape === 'wide';
  const bytes = await artwork(offset ? 1400 : side, side, 'all', offset);
  if (offset) offsetLayoutImages.add(await pixelsDigest(bytes));
  res.type('png').send(req.query.variant === 'green' ? await sharp(bytes).modulate({ hue: 140 }).png().toBuffer() : bytes);
});
app.use(express.static(resolve('client/dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('client/dist/index.html')));
const server = app.listen(port, '127.0.0.1', () => console.info(`Offline fixture: ${origin}; data: ${root}`));
// Longer than any client's idle reuse: Node's 5 s default can close a kept-alive socket just as a test reuses it (ECONNRESET).
server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000;
