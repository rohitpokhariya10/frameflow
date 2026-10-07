import { expect, test, type Page } from '@playwright/test';
import { generationVariantId, IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIOS, IMAGE_TEMPLATE_SIZES, imageTemplateVariantPrompt, resolveImageTemplateName, resolveImageTemplatePrompt, resolveImageTemplateRatios } from '@frameflow/shared';

// "Create Template from Image" in the real app, with every provider faked. The experiment API is answered here, inside
// the browser, by a small in-memory fake: no request of this test reaches a server, so no OpenAI, fal or Seedream
// request can be made, and no credit is used. A request the fake does not know, or one that leaves this machine, fails
// the test.
const API = '/api/layerize-experiment';
const BASE = `${API}/image-templates`;
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GENERATED = 'A premium product advertisement in a soft 3D render style: a lavender smartphone stands upright in the centre on a white round platform, with pale spheres floating around it, on a pastel lilac studio background with soft daylight.';
const INFO = { ratios: IMAGE_TEMPLATE_RATIOS.map(ratio => ({ ratio, name: { '1:1': 'Square', '4:5': 'Portrait', '16:9': 'Landscape' }[ratio], ...IMAGE_TEMPLATE_SIZES[ratio] })), limits: IMAGE_TEMPLATE_LIMITS,
  imageModel: 'gpt-image-2', promptModel: 'gpt-5-mini', ratioReference: true,
  layerStyles: [{ key: 'template-a', name: 'Template A', summary: 'Framed portrait: one person or animal in a framed backdrop, optionally holding an object' },
    { key: 'template-b', name: 'Template B', summary: 'Product: one dominant product or object on a designed background' },
    { key: 'template-c', name: 'Template C', summary: 'People and campaign: several people, or people with product or promo modules' }] };
type Variant = Record<string, unknown> & { id: string; aspectRatio: string; status: string; attempts: number; decompositions: { runId: string; createdAt: string }[]; decomposition?: Record<string, unknown>; editor?: Record<string, unknown> };
type Template = Record<string, unknown> & { id: string; name: string; prompt: string; generatedPrompt?: string; aspectRatios: string[]; variants: Variant[]; promptGeneration?: { status: string; attempts: number; error?: Record<string, unknown> }; generatedAt?: string };
type Post = { method: string; path: string; body?: unknown };

/**
 * Installs the fake API. Work "finishes" when the template is next read: a prompt is written, a queued image is
 * generated, a decomposition is done. `failFirst` makes the first prompt of the first template fail, and the first 4:5
 * image of every template.
 */
async function fakeApi(page: Page, options: { failFirst?: boolean } = {}) {
  const templates: Template[] = [], posts: Post[] = [], unknown: string[] = [], outside: string[] = [], pageErrors: string[] = [], runs: Record<string, Record<string, unknown>> = {};
  let counter = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', (request) => { if (!/^(data|blob):/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url()); });
  page.on('dialog', dialog => void dialog.accept());
  const advance = (template: Template) => {
    if (template.promptGeneration?.status === 'generating') {
      const fail = options.failFirst && template === templates.at(-1) && template.promptGeneration.attempts === 1;
      template.promptGeneration = fail ? { ...template.promptGeneration, status: 'failed', error: { code: 'PROMPT_API_ERROR', message: 'OpenAI gpt-5-mini request failed (HTTP 429): Rate limit reached.' } }
        : { ...template.promptGeneration, status: 'done' };
      if (!fail) Object.assign(template, { generatedPrompt: GENERATED, prompt: GENERATED, promptEdited: false, detected: { templateKey: 'template-b', reason: 'One product is the clear hero.' }, decomposeWith: template.decomposeWithChosen ? template.decomposeWith : 'template-b', name: template.name || 'Lavender phone studio' });
    }
    for (const variant of template.variants) {
      if (variant.status === 'queued') {
        variant.attempts += 1;
        if (options.failFirst && variant.id === '4x5' && variant.attempts === 1) Object.assign(variant, { status: 'failed', error: { code: 'PROVIDER_NETWORK', status: 500, message: 'The image service had an error. Try again.' } });
        else { delete variant.error; Object.assign(variant, { status: 'done', image: { file: `${variant.id}.image.png`, mimeType: 'image/png', ...(variant.size as object), bytes: PIXEL.length, sha256: `sha${variant.id}${variant.attempts}` } }); }
      }
      if (variant.decomposition?.state === 'running') Object.assign(variant.decomposition, { state: 'done', stage: 'done', layers: 2 });
    }
    return template;
  };
  await page.route(url => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const body = request.headers()['content-type']?.startsWith('application/json') ? JSON.parse(request.postData() ?? '{}') as Record<string, unknown> : undefined;
    if (method !== 'GET') posts.push({ method, path: path.replace(BASE, ''), ...(body ? { body } : {}) });
    // What the OpenAI + Seedream test panel reads when it opens.
    if (path === `${API}/runs` && method === 'GET') return json({ active: null, runs: [] });
    if (path === `${API}/template-families`) return json({ families: [] });
    if (path === `${API}/templates`) return json({ templates: [], fitCheck: false });
    if (path === `${BASE}/info`) return json(INFO);
    if (path === BASE && method === 'GET') return json({ templates });
    if (path === BASE && method === 'POST') {
      // A multipart upload: the image and, when given, the name.
      const raw = request.postDataBuffer()!.toString('latin1'), name = /name="name"\r\n\r\n([^\r]*)\r\n/.exec(raw)?.[1] ?? '';
      const ratios = /name="aspectRatios"\r\n\r\n([^\r]*)\r\n/.exec(raw)?.[1];
      if (!/name="image"; filename="[^"]+"/.test(raw)) return json({ error: { code: 'INVALID_UPLOAD', message: 'Choose an image to upload.' } }, 400);
      posts.at(-1)!.body = { name, image: /filename="([^"]+)"/.exec(raw)![1] };
      const now = new Date().toISOString(), template: Template = { id: `2026-10-01T10-00-0${counter}-000Z-abc12${counter++}`, kind: 'image-template', version: 'image-template-v1', createdAt: now, updatedAt: now, name,
        reference: { file: 'reference.png', originalName: posts.at(-1)!.body && (posts.at(-1)!.body as { image: string }).image, mimeType: 'image/png', width: 1, height: 1, bytes: PIXEL.length },
        promptGeneration: { status: 'generating', attempts: 1 }, prompt: '', promptEdited: false, aspectRatios: ratios ? JSON.parse(ratios) : [...IMAGE_TEMPLATE_RATIOS], variants: [] };
      templates.unshift(template);
      return json(template, 202);
    }
    const match = /^\/image-templates\/([^/]+)(?:\/(reference|prompt|generate)|\/variants\/([^/]+)\/(generate|decompose|opened|image|resume))?$/.exec(path.replace(API, ''));
    const runMatch = /^\/runs\/([^/]+)(\/files\/[^/]+)?$/.exec(path.replace(API, ''));
    if (match) {
      const template = templates.find(item => item.id === match[1]), variant = template?.variants.find(item => item.id === match[3]);
      if (!template) return json({ error: { code: 'NOT_FOUND', message: 'Template not found.' } }, 404);
      if (match[2] === 'reference' || match[4] === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      if (!match[2] && !match[3]) {
        if (method === 'GET') return json(advance(template));
        // PATCH: what a draft may change.
        for (const [key, value] of Object.entries(body ?? {})) Object.assign(template, key === 'decomposeWith' ? { decomposeWith: value, decomposeWithChosen: true } : key === 'prompt' ? { prompt: value, promptEdited: value !== template.generatedPrompt } : { [key]: value });
        return json(template);
      }
      if (match[2] === 'prompt') { template.promptGeneration = { status: 'generating', attempts: (template.promptGeneration?.attempts ?? 0) + 1 }; return json(template, 202); }
      if (match[2] === 'generate') {
        const name = resolveImageTemplateName(body!.name), prompt = resolveImageTemplatePrompt(body!.prompt), ratios = resolveImageTemplateRatios(body!.aspectRatios);
        if (name.error || prompt.error || ratios.error) return json({ error: { code: 'INVALID', message: [name.error, prompt.error, ratios.error].filter(Boolean).join(' ') } }, 400);
        Object.assign(template, { name: name.name, prompt: prompt.prompt, promptEdited: prompt.prompt !== template.generatedPrompt, aspectRatios: ratios.ratios, generatedAt: new Date().toISOString(), ratioStrategy: 'uploaded-reference',
          variants: IMAGE_TEMPLATE_RATIOS.map(ratio => ({ id: generationVariantId(ratio), aspectRatio: ratio, size: IMAGE_TEMPLATE_SIZES[ratio], status: ratios.ratios.includes(ratio) ? 'queued' : 'pending', framing: '',
            prompt: imageTemplateVariantPrompt(prompt.prompt, ratio), generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 0, decompositions: [] })) });
        return json(template, 202);
      }
      if (!variant) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      if (match[4] === 'generate') {
        if (!template.aspectRatios.includes(variant.aspectRatio)) template.aspectRatios = IMAGE_TEMPLATE_RATIOS.filter(ratio => ratio === variant.aspectRatio || template.aspectRatios.includes(ratio));
        variant.status = 'queued'; return json(template, 202);
      }
      if (match[4] === 'decompose') {
        const runId = `2026-10-01T11-00-0${counter}-000Z-ffee1${counter++}`, size = variant.size as { width: number; height: number };
        runs[runId] = { id: runId, stage: 'done', createdAt: new Date().toISOString(), templateKey: 'template-b', canvas: size, warnings: [], timings: {}, seedream: { endpoint: 'fake' },
          original: { file: 'original.png', ...size }, input: { file: 'original.png', ...size, orientationNormalized: false },
          layers: [{ index: 0, file: 'layer-0.png', zIndex: 0, pixelWidth: size.width, pixelHeight: size.height, opaquePercent: 100, placement: { kind: 'base', x: 0, y: 0, ...size } },
            { index: 1, file: 'layer-1.png', zIndex: 1, name: 'Phone', pixelWidth: 200, pixelHeight: 300, opaquePercent: 60, placement: { kind: 'bbox-crop', x: 100, y: 50, width: 200, height: 300 } }] };
        variant.decompositions.push({ runId, createdAt: new Date().toISOString() });
        variant.decomposition = { runId, templateKey: 'template-b', createdAt: new Date().toISOString(), state: 'running', stage: 'planning' };
        return json(template, 202);
      }
      if (match[4] === 'opened') { variant.editor = { runId: (body as { runId: string }).runId, openedAt: new Date().toISOString() }; return json(template); }
    }
    if (runMatch && runs[runMatch[1]]) return runMatch[2] ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }) : json({ ...runs[runMatch[1]], active: false });
    unknown.push(`${method} ${path}`);
    return route.abort();
  });
  return { templates, posts, unknown, outside, pageErrors };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create Template from Image' });
const card = (page: Page, ratio: string) => dialog(page).locator(`article[aria-label="${ratio} result"]`);
const statuses = (page: Page) => dialog(page).locator('[data-testid^="status-"]').allInnerTexts();
const ratioBox = (page: Page, ratio: string) => dialog(page).getByRole('checkbox', { name: new RegExp(`^${ratio} `) });
/** The flow opens from the OpenAI + Seedream test panel, which closes behind it. */
const openFromPanel = async (page: Page) => {
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await page.getByRole('dialog', { name: 'OpenAI + Seedream test' }).getByRole('button', { name: 'Create Template from Image' }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByLabel('Legacy prompt workflow').check();
  await expect(page.getByRole('dialog', { name: 'OpenAI + Seedream test' })).toHaveCount(0);
};
const open = async (page: Page) => { await page.goto('/'); await openFromPanel(page); };

/** An existing saved result, so request-order regressions do not depend on the upload/generation journey above. */
function savedSquare(name: string): Template {
  const now = '2026-10-01T10:00:00.000Z';
  return { id: '2026-10-01T10-00-00-000Z-abc123', kind: 'image-template', version: 'image-template-v1', createdAt: now, updatedAt: now,
    name, prompt: GENERATED, generatedPrompt: GENERATED, promptEdited: false, promptGeneration: { status: 'done', attempts: 1 },
    reference: { file: 'reference.png', originalName: 'reference.png', mimeType: 'image/png', width: 1, height: 1, bytes: PIXEL.length },
    detected: { templateKey: 'template-b', reason: 'One product is the clear hero.' }, decomposeWith: 'template-b', aspectRatios: ['1:1'], generatedAt: now,
    variants: IMAGE_TEMPLATE_RATIOS.map(ratio => ({ id: generationVariantId(ratio), aspectRatio: ratio, size: IMAGE_TEMPLATE_SIZES[ratio],
      status: ratio === '1:1' ? 'done' : 'pending', attempts: ratio === '1:1' ? 1 : 0, decompositions: [],
      ...(ratio === '1:1' ? { image: { file: '1x1.image.png', mimeType: 'image/png', ...IMAGE_TEMPLATE_SIZES[ratio], bytes: PIXEL.length, sha256: 'saved-square' } } : {}) })) };
}

test('immediate prompt edits and repeated Generate clicks submit one request with the latest prompt (fake providers)', async ({ page }) => {
  const api = await fakeApi(page), template = savedSquare('Latest edit');
  delete template.generatedAt; template.variants = [];
  api.templates.push(template);
  let release!: () => void, requests = 0;
  const gate = new Promise<void>(done => { release = done; });
  await page.route(`**${BASE}/${template.id}/generate`, async route => { requests++; await gate; return route.fallback(); });
  await open(page);
  const d = dialog(page), edited = `${GENERATED} Keep the exact camera module and neutral gray background.`;
  await d.getByLabel('Generated prompt').fill(edited);
  const generate = d.getByRole('button', { name: 'Generate selected templates (1)' });
  await generate.click();
  // A second event while the first request is outstanding must not enqueue another action.
  await generate.dispatchEvent('click');
  await expect.poll(() => requests).toBe(1);
  release();
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated']);
  expect(api.posts.filter(post => post.path.endsWith('/generate'))).toEqual([{ method: 'POST', path: `/${template.id}/generate`, body: { name: template.name, prompt: edited, aspectRatios: ['1:1'] } }]);
  expect(api.posts.some(post => post.path.endsWith('/prompt') || post.path.endsWith('/decompose'))).toBe(false);
  expect(requests).toBe(1);
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('a failed template rename blocks a waiting decomposition until Retry save succeeds (fake providers)', async ({ page }) => {
  const api = await fakeApi(page), template = savedSquare('Save protection');
  api.templates.push(template);
  let releaseSave!: () => void, intercepted = false;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route(`**${BASE}/${template.id}`, async route => {
    if (route.request().method() !== 'PATCH' || intercepted) return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ name: 'Renamed saved template' });
    intercepted = true;
    await saveGate;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Template save unavailable.' } }) });
  });
  await open(page);
  const d = dialog(page), result = card(page, '1:1');
  await d.getByRole('button', { name: 'Rename', exact: true }).click();
  await d.getByLabel('Template name').fill('Renamed saved template');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => intercepted).toBe(true);
  // Decompose waits for this exact PATCH; a failed edit must never fall through to a paid POST.
  await result.getByRole('button', { name: 'Decompose into layers' }).click();
  await expect(result.getByRole('button', { name: 'Decompose into layers' })).toBeDisabled();
  releaseSave();
  await expect(d.getByRole('alert')).toContainText('Template save unavailable.');
  await expect(result.getByTestId('status-1x1')).toHaveText('Generated');
  expect(api.posts.filter(post => post.path.endsWith('/decompose'))).toEqual([]);
  expect(template.name).toBe('Save protection');

  await d.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(d.getByRole('heading', { name: 'Renamed saved template', exact: true })).toBeVisible();
  expect(template.name).toBe('Renamed saved template');
  await result.getByRole('button', { name: 'Decompose into layers' }).click();
  await expect(result.getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 10_000 });
  expect(api.posts.filter(post => post.path.endsWith('/decompose'))).toHaveLength(1);
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('a delayed selection read cannot overwrite decomposition progress or stop polling (fake providers)', async ({ page }) => {
  const api = await fakeApi(page), template = savedSquare('Response ordering');
  api.templates.push(template);
  await open(page);
  let releaseRead!: () => void, intercepted = false;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  await page.route(`**${BASE}/${template.id}`, async route => {
    if (route.request().method() !== 'GET' || intercepted) return route.fallback();
    const beforeDecomposition = JSON.stringify(template);
    intercepted = true;
    await readGate;
    return route.fulfill({ status: 200, contentType: 'application/json', body: beforeDecomposition });
  });
  // Selecting the saved template triggers a refresh while its existing card remains usable.
  await dialog(page).getByRole('complementary', { name: 'Your templates' }).getByRole('button', { name: /Response ordering/ }).click();
  await expect.poll(() => intercepted).toBe(true);
  const result = card(page, '1:1');
  await result.getByRole('button', { name: 'Decompose into layers' }).click();
  await expect(result.getByTestId('status-1x1')).toHaveText('Decomposing…');
  // The stale response says Generated. Accepting it stops templateInProgress polling, so the next assertion fails.
  releaseRead();
  await expect(result.getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 10_000 });
  await expect(result.getByRole('button', { name: 'Open in editor', exact: true })).toBeVisible();
  expect(api.posts.filter(post => post.path.endsWith('/decompose'))).toHaveLength(1);
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('create a template from an image: name, reference, prompt, sizes, results, decompose, open in editor (fake providers)', async ({ page }, testInfo) => {
  const api = await fakeApi(page);
  await open(page);
  const d = dialog(page);
  await expect(d.getByText('No templates yet. Upload a reference image to create your first one.')).toBeVisible();
  await expect(d.getByRole('heading', { name: 'New template' })).toBeVisible();

  // 1–2. The name and the reference image; nothing is sent until the prompt is asked for.
  const generatePrompt = d.getByRole('button', { name: 'Generate prompt from image' });
  await expect(generatePrompt).toBeDisabled();
  await d.getByLabel('Template name').fill('Lavender launch');
  await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'lavender.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(d.getByAltText('Reference preview')).toBeVisible();
  await expect(d.getByText('lavender.png')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('1-new-template.png') });
  await expect(d.getByRole('button', { name: /^Generate selected templates/ })).toBeDisabled();
  expect(api.posts).toEqual([]);

  // 3–4. One request writes the prompt from the image; it is shown, and it can be edited.
  await generatePrompt.click();
  await expect.poll(() => api.posts).toEqual([{ method: 'POST', path: '', body: { name: 'Lavender launch', image: 'lavender.png' } }]);
  const prompt = d.getByLabel('Generated prompt');
  await expect(prompt).toHaveValue(GENERATED, { timeout: 10_000 });
  await expect(d.getByTestId('prompt-state')).toHaveText('Written from your image');
  await expect(d.getByLabel('Template name')).toHaveValue('Lavender launch');
  await expect(d.getByTestId('layer-style').locator('summary')).toHaveText('Image-aware decomposition · Reference style: Product (Template B) · detected from your image');
  await expect(d.getByRole('list').getByRole('button')).toHaveCount(1);
  await prompt.fill(`${GENERATED} Golden hour light.`);
  await expect(d.getByTestId('prompt-state')).toHaveText('Edited');
  await d.getByLabel('Template name').click();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'PATCH', path: `/${api.templates[0].id}`, body: { prompt: `${GENERATED} Golden hour light.` } });
  await expect(d.getByRole('button', { name: 'Reset to generated prompt' })).toBeVisible();

  // 5. The sizes: all three to start with; one turned off.
  for (const ratio of IMAGE_TEMPLATE_RATIOS) await expect(ratioBox(page, ratio)).toBeChecked();
  await ratioBox(page, '4:5').uncheck();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'PATCH', path: `/${api.templates[0].id}`, body: { aspectRatios: ['1:1', '16:9'] } });
  await expect(d.getByTestId('generate-hint')).toHaveText('2 paid image requests · OpenAI gpt-image-2. Each size can then be decomposed and opened in the editor.');
  await page.screenshot({ path: testInfo.outputPath('2-prompt-and-sizes.png'), fullPage: true });

  // 6. Generating sends exactly the name, the edited prompt and the chosen sizes; one result per chosen size.
  await d.getByRole('button', { name: 'Generate selected templates (2)' }).click();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'POST', path: `/${api.templates[0].id}/generate`, body: { name: 'Lavender launch', prompt: `${GENERATED} Golden hour light.`, aspectRatios: ['1:1', '16:9'] } });
  await expect(d.getByRole('heading', { name: 'Lavender launch' })).toBeVisible();
  await expect(d.locator('article[data-ratio]')).toHaveCount(2);
  // 7. Each result's status, as it goes.
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated', 'Generated']);
  await expect(card(page, '1:1').locator('img')).toHaveCount(1);
  await expect(d.getByText('Add another size:')).toContainText('4:5 Portrait');
  await d.getByText(/^Prompt used/).click();
  await expect(d.getByTestId('prompt-used')).toHaveText(`${GENERATED} Golden hour light.`);

  // 8. One result decomposed: only it; the other is untouched.
  await card(page, '1:1').getByRole('button', { name: 'Decompose into layers' }).click();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'POST', path: `/${api.templates[0].id}/variants/1x1/decompose` });
  await expect(card(page, '1:1').getByTestId('status-1x1')).toHaveText('Decomposing…');
  await expect(card(page, '1:1').getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 10_000 });
  await expect(card(page, '1:1')).toContainText('2 layers ready to open in the editor.');
  await expect(card(page, '16:9').getByTestId('status-16x9')).toHaveText('Generated');
  await expect(card(page, '16:9').getByRole('button', { name: 'Open in editor' })).toHaveCount(0);
  await card(page, '1:1').getByText('Preview layers', { exact: true }).click();
  await expect(card(page, '1:1').locator('.cti-layer-previews img')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('3-results.png') });

  // 9. Open in editor: a design of its own, named after the template and the size (one version); the design that was
  // open is kept with no version added; the dialog closes onto it.
  await card(page, '1:1').getByRole('button', { name: 'Open in editor' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByLabel('Open design').locator('option:checked')).toHaveText('Lavender launch · 1:1 · 1 version');
  await expect(page.getByLabel('Open design').locator('option')).toHaveCount(2);
  await expect(page.getByLabel('Active version')).toHaveCount(0);
  await expect(page.locator('.workspace-unit')).toHaveText('1024 × 1024 px');
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'POST', path: `/${api.templates[0].id}/variants/1x1/opened`, body: { runId: api.templates[0].variants[0].decompositions[0].runId } });
  // Back in the dialog, the template is where it was left, and the result says it is in the editor.
  await openFromPanel(page);
  await expect(card(page, '1:1').getByTestId('status-1x1')).toHaveText('Ready in editor');
  await expect(card(page, '1:1').getByRole('button', { name: 'Open in editor again' })).toBeVisible();
  await expect(d.getByTestId('template-summary')).toHaveText('1:1 · 16:9 · 1 decomposed');
  await page.screenshot({ path: testInfo.outputPath('4-ready-in-editor.png') });

  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('failures are shown where they happen and can be retried; several templates are kept side by side (fake providers)', async ({ page }) => {
  const api = await fakeApi(page, { failFirst: true });
  await open(page);
  const d = dialog(page);

  // An unnamed template: the prompt request fails, is tried again, and suggests a name.
  await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: PIXEL });
  await d.getByRole('button', { name: 'Generate prompt from image' }).click();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'POST', path: '', body: { name: '', image: 'first.png' } });
  await expect(d.getByRole('alert')).toContainText('The prompt could not be written: OpenAI gpt-5-mini request failed (HTTP 429): Rate limit reached.', { timeout: 10_000 });
  await expect(d.getByTestId('generate-hint')).toHaveText('Name your template. Generate the prompt from the image, or write one.');
  await d.getByRole('button', { name: 'Try again' }).click();
  await expect(d.getByLabel('Generated prompt')).toHaveValue(GENERATED, { timeout: 10_000 });
  await expect(d.getByLabel('Template name')).toHaveValue('Lavender phone studio');
  // A name cleared again blocks generating, and says so.
  await d.getByLabel('Template name').fill('');
  await expect(d.getByRole('button', { name: /^Generate selected templates/ })).toBeDisabled();
  await expect(d.getByTestId('generate-hint')).toHaveText('Name your template.');
  await d.getByLabel('Template name').fill('Spring sale');
  // The reference style is informational: the existing pipeline analyzes each generated image separately.
  await d.getByTestId('layer-style').locator('summary').click();
  await expect(d.getByTestId('layer-style').getByRole('combobox')).toHaveCount(0);
  await expect(d.getByTestId('layer-style')).toContainText('Each result is analyzed individually');
  await expect(d.getByTestId('layer-style').locator('summary')).toHaveText('Image-aware decomposition · Reference style: Product (Template B) · detected from your image');

  // All three sizes; the 4:5 image fails, the others are kept, and only it is generated again.
  await d.getByRole('button', { name: 'Generate selected templates (3)' }).click();
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated', 'Failed', 'Generated']);
  await expect(card(page, '4:5').getByRole('alert')).toHaveText('The image service had an error. Try again.');
  await expect(card(page, '4:5').getByRole('button', { name: 'Decompose into layers' })).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Generate from prompt only' })).toHaveCount(0);
  await card(page, '4:5').getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => api.posts.at(-1)).toEqual({ method: 'POST', path: `/${api.templates[0].id}/variants/4x5/generate` });
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated', 'Generated', 'Generated']);
  // Decompose all: one request per result, in order.
  await d.getByRole('button', { name: 'Decompose all (3)' }).click();
  await expect.poll(() => api.posts.slice(-3).map(post => post.path)).toEqual(['1x1', '4x5', '16x9'].map(id => `/${api.templates[0].id}/variants/${id}/decompose`));
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Decomposed', 'Decomposed', 'Decomposed']);

  // A second template, with its own name, reference and prompt; the first one keeps its results.
  await d.getByRole('button', { name: 'New template' }).click();
  await expect(d.getByRole('heading', { name: 'New template' })).toBeVisible();
  await d.getByLabel('Template name').fill('Summer launch');
  await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: PIXEL });
  await d.getByRole('button', { name: 'Generate prompt from image' }).click();
  await expect(d.getByLabel('Generated prompt')).toHaveValue(GENERATED, { timeout: 10_000 });
  await ratioBox(page, '16:9').uncheck();
  await ratioBox(page, '4:5').uncheck();
  await d.getByRole('button', { name: 'Generate selected templates (1)' }).click();
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated']);
  const list = d.getByRole('complementary', { name: 'Your templates' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.locator('.cti-list-name')).toHaveText(['Summer launch', 'Spring sale']);
  await list.getByRole('button', { name: /Spring sale/ }).click();
  await expect(d.getByRole('heading', { name: 'Spring sale' })).toBeVisible();
  await expect.poll(() => statuses(page)).toEqual(['Decomposed', 'Decomposed', 'Decomposed']);
  await list.getByRole('button', { name: /Summer launch/ }).click();
  await expect.poll(() => statuses(page)).toEqual(['Generated']);

  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('10. the launchers are unchanged; the OpenAI + Seedream test panel keeps its Template A/B/C generators and offers the new flow (fake providers)', async ({ page }, testInfo) => {
  const api = await fakeApi(page);
  await page.goto('/');
  await expect(page.locator('.decomp-launch')).toHaveText(['OpenAI + Seedream test', 'Create Own Template']);
  const zoom = (await page.getByLabel('Canvas zoom').boundingBox())!;
  for (const launcher of await page.locator('.decomp-launch').all()) {
    const box = (await launcher.boundingBox())!;
    expect(box.x >= zoom.x + zoom.width || box.x + box.width <= zoom.x || box.y >= zoom.y + zoom.height || box.y + box.height <= zoom.y).toBe(true);
  }
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('launchers.png') });
  await expect(page.getByRole('button', { name: 'Create Template from Image' })).toHaveCount(0);
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await page.getByRole('tab', { name: 'Create Template', exact: true }).click();
  for (const name of ['Create Template from Image', 'Create Template A', 'Create Template B', 'Create Template C']) await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('panel-entry.png') });
  // Closing the new flow returns to the editor; nothing was sent.
  await page.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await panel.getByRole('button', { name: 'Create Template from Image', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect([api.posts, api.unknown, api.outside, api.pageErrors]).toEqual([[], [], [], []]);
});

test('cancelled prompt regeneration keeps edits; a successful retry replaces them', async ({ page }) => {
  await fakeApi(page);
  await open(page);
  const d = dialog(page);
  await d.getByLabel('Template name').fill('Prompt revisions');
  await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: PIXEL });
  await ratioBox(page, '4:5').uncheck();
  await d.getByRole('button', { name: 'Generate prompt from image' }).click();
  const prompt = d.getByLabel('Generated prompt');
  await expect(prompt).toHaveValue(GENERATED, { timeout: 10_000 });
  await expect(ratioBox(page, '4:5')).not.toBeChecked();
  await prompt.fill(`${GENERATED} Orange lighting.`);
  page.removeAllListeners('dialog');
  page.once('dialog', dialog => void dialog.dismiss());
  await d.getByRole('button', { name: 'Write again from image' }).click();
  await expect(prompt).toHaveValue(`${GENERATED} Orange lighting.`);
  page.once('dialog', dialog => void dialog.accept());
  await d.getByRole('button', { name: 'Write again from image' }).click();
  await expect(prompt).toHaveValue(GENERATED, { timeout: 10_000 });
});


test('raw editable counter and inclusive limit block invalid Generate without provider work', async ({ page }) => {
  const api = await fakeApi(page), template = savedSquare('Boundary draft');
  delete template.generatedAt; template.variants = []; api.templates.push(template);
  await open(page);
  const d = dialog(page), prompt = d.getByLabel('Generated prompt');
  const generate = d.getByRole('button', { name: /^Generate selected templates/ });
  for (const size of [IMAGE_TEMPLATE_LIMITS.prompt - 1, IMAGE_TEMPLATE_LIMITS.prompt, IMAGE_TEMPLATE_LIMITS.prompt + 1, IMAGE_TEMPLATE_LIMITS.prompt - 1]) {
    const text = 'a'.repeat(size - 1) + ' ';
    await prompt.fill(text);
    await expect(prompt).toHaveValue(text);
    await expect(d.locator('.cti-count')).toHaveText(`${size} / ${IMAGE_TEMPLATE_LIMITS.prompt}`);
    if (size > IMAGE_TEMPLATE_LIMITS.prompt) {
      await expect(generate).toBeDisabled();
      await expect(d.locator('.cti-count')).toHaveClass(/is-over/);
      await expect(d.getByTestId('generate-hint')).toContainText(`The prompt is ${size} characters`);
    } else await expect(generate).toBeEnabled();
  }
  expect(api.posts.filter(p => p.path.endsWith('/generate'))).toHaveLength(0);
});


test('failed prompt autosave prevents Generate from using stale text until an explicit save retry', async ({ page }) => {
  const api = await fakeApi(page), template = savedSquare('Prompt save protection');
  delete template.generatedAt; template.variants = []; api.templates.push(template);
  let failSave = true;
  await page.route(`**${BASE}/${template.id}`, route => {
    if (route.request().method() !== 'PATCH' || !failSave) return route.fallback();
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Prompt save unavailable.' } }) });
  });
  await open(page);
  const d = dialog(page), edited = `${GENERATED} Warm light and unchanged product.`;
  await d.getByLabel('Generated prompt').fill(edited);
  await d.getByRole('button', { name: /^Generate selected templates/ }).click();
  await expect(d.getByRole('alert')).toContainText('Prompt save unavailable.');
  expect(api.posts.filter(post => post.path.endsWith('/generate'))).toHaveLength(0);
  expect(template.prompt).toBe(GENERATED);
  failSave = false;
  await d.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect.poll(() => template.prompt).toBe(edited);
  await d.getByRole('button', { name: /^Generate selected templates/ }).click();
  await expect.poll(() => statuses(page), { timeout: 10_000 }).toEqual(['Generated']);
  expect(api.posts.filter(post => post.path.endsWith('/generate'))).toHaveLength(1);
  expect(template.prompt).toBe(edited);
});
