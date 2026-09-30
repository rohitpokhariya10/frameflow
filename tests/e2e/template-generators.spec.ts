import { expect, test, type Page } from '@playwright/test';
import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROFILES, GENERATION_PROMPT_LIMITS, GENERATION_TEMPLATE_KEYS, generationProfile, generationVariantId, hasHeldObject, hasVisibleBorder,
  resolveGenerationBasePrompt, type GenerationTemplateKey, type TemplateAFieldValues } from '@frameflow/shared';

// The Template A / B / C test generators in the real app, with every provider faked. The experiment API is answered
// here, inside the browser, by a small in-memory fake: no request of this test reaches a server, so no OpenAI, fal or
// Seedream request can be made, and no credit is used. A request the fake does not know, or one that leaves the local
// dev server, fails the test.
const API = '/api/layerize-experiment';
// A 1×1 PNG: what every "generated" image is here.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The template list as the server serves it: Template A has its held-object checkbox; B and C declare their own options.
const TEMPLATES = [
  { key: 'template-a', name: 'Template A', description: 'Subject in a framed inner region.', providerPrompt: 'planned', layerRoles: [{ name: 'base' }, { name: 'outer background' }, { name: 'inner region' }, { name: 'border' }, { name: 'subject', foreground: true }, { name: 'held object', heldObject: true, foreground: true }],
    grouping: { label: 'Separate held object from subject', checked: 'Checked: subject and held object become separate layers.', unchecked: 'Unchecked: held object stays combined with the subject.', minReason: 'background, subject and held object', modeName: 'Held object mode' } },
  { key: 'template-b', name: 'Template B', description: 'Single-hero product compositions.', providerPrompt: 'planned', imageSpecificPrompt: true, layerRoles: [], dynamicLayerCount: true,
    options: [{ key: 'separateTouchingIndependentObjects', label: 'Separate touching / overlapping independent objects', help: 'Objects that touch the hero become their own layers.', default: false }] },
  { key: 'template-c', name: 'Template C', description: 'Human-centric campaign compositions.', providerPrompt: 'planned', imageSpecificPrompt: true, layerRoles: [], dynamicLayerCount: true,
    options: [{ key: 'separateHumanSubjects', label: 'Separate individual people / human subjects', help: 'Each person becomes a layer.', default: false },
      { key: 'separateRepeatedModules', label: 'Separate repeated subject / showcase panels', help: 'Each panel becomes a layer.', default: false }] },
];
type Variant = { id: string; aspectRatio: string; size: { width: number; height: number }; status: string; framing: string; prompt: string; generator: Record<string, string>; attempts: number; decompositions: Record<string, unknown>[];
  error?: Record<string, unknown>; image?: Record<string, unknown>; durationMs?: number; reference?: { variantId: string; aspectRatio: string; instruction: string }; independent?: boolean };
type Group = { id: string; templateKey: GenerationTemplateKey; promptEdited: boolean; variants: Variant[] } & Record<string, unknown>;
type Post = { path: string; body?: Record<string, unknown> };

/**
 * Installs the fake experiment API on the page. Generating "finishes" when the group is next read; the first creative of
 * each template has its 16:9 fail once. As on the server, a template whose profile keeps its ratios together by image
 * (Template B) makes a ratio from the first finished one, unless it was asked for from the prompt only.
 */
async function fakeExperimentApi(page: Page) {
  const groups: Record<GenerationTemplateKey, Group[]> = { 'template-a': [], 'template-b': [], 'template-c': [] };
  const posts: Post[] = [], unknown: string[] = [], outside: string[] = [], pageErrors: string[] = [];
  let counter = 0, lastRun: Record<string, unknown> | undefined;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', (request) => { if (!/^(data|blob):/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url()); });
  const newGroup = (key: GenerationTemplateKey, body: Record<string, unknown>): Group => {
    const profile = generationProfile(key), { values } = profile.resolveFields(body.fields), base = resolveGenerationBasePrompt(profile, values, body.basePrompt), wanted = (body.aspectRatios as string[] | undefined) ?? GENERATION_ASPECT_RATIOS, notes = profile.notes(values);
    const now = new Date().toISOString();
    const group: Group = { id: `2026-09-30T15-00-0${counter}-000Z-abc12${counter++}`, templateKey: key, version: profile.version, createdAt: now, updatedAt: now, fields: values, builtPrompt: base.builtPrompt, basePrompt: base.basePrompt, promptEdited: base.promptEdited,
      ...(key === 'template-a' ? { structure: { visibleBorder: hasVisibleBorder(values as TemplateAFieldValues), heldObject: hasHeldObject(values as TemplateAFieldValues) } } : {}), ...(notes.length ? { notes } : {}),
      ...(profile.referenceInstruction ? { ratioStrategy: 'reference' } : {}), aspectRatios: [...GENERATION_ASPECT_RATIOS],
      variants: GENERATION_ASPECT_RATIOS.map(ratio => ({ id: generationVariantId(ratio), aspectRatio: ratio, size: GENERATION_IMAGE_SIZES[ratio], status: wanted.includes(ratio) ? 'queued' : 'pending', framing: profile.framing[ratio],
        prompt: buildGenerationVariantPrompt(profile, base.basePrompt, ratio), generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 0, decompositions: [] })) };
    groups[key].unshift(group);
    return group;
  };
  const advance = (key: GenerationTemplateKey, group: Group) => {
    for (const variant of group.variants) {
      if (variant.status !== 'queued') continue;
      variant.attempts += 1;
      const source = group.ratioStrategy === 'reference' && !variant.independent ? group.variants.find(other => other !== variant && other.status === 'done' && !other.reference) : undefined;
      delete variant.reference;
      if (source) variant.reference = { variantId: source.id, aspectRatio: source.aspectRatio, instruction: generationProfile(key).referenceInstruction! };
      if (group === groups[key].at(-1) && variant.id === '16x9' && variant.attempts === 1) Object.assign(variant, { status: 'failed', error: { code: 'PROVIDER_ERROR', status: 500, message: 'The server had an error.' } });
      else { delete variant.error; Object.assign(variant, { status: 'done', durationMs: 41200, generator: { ...variant.generator, requestId: `req_${variant.id}` }, image: { file: `${variant.id}.image.png`, mimeType: 'image/png', ...variant.size, bytes: PIXEL.length } }); }
    }
    return group;
  };
  await page.route(url => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method(), body = (request.postData() ? JSON.parse(request.postData()!) : {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (method === 'POST') posts.push({ path: path.replace(API, ''), ...(request.postData() ? { body } : {}) });
    if (path === `${API}/runs` && method === 'GET') return json({ active: null, runs: [] });
    if (path === `${API}/templates`) return json({ templates: TEMPLATES, fitCheck: false });
    const generator = /\/(template-[abc])\/(generator|groups)(?:\/([^/]+))?(?:\/variants\/([^/]+)\/(generate|decompose|image))?$/.exec(path);
    if (generator) {
      const key = generator[1] as GenerationTemplateKey, profile = generationProfile(key), group = groups[key].find(item => item.id === generator[3]), variant = group?.variants.find(item => item.id === generator[4]);
      if (generator[2] === 'generator') return json({ templateKey: key, name: profile.name, version: profile.version, family: profile.family, sameAcrossRatios: profile.sameAcrossRatios, mayDiffer: profile.mayDiffer, skeleton: profile.skeleton, fields: profile.fields,
        defaults: profile.defaults, aspectRatios: GENERATION_ASPECT_RATIOS, imageSizes: GENERATION_IMAGE_SIZES, consistency: profile.consistency, framing: profile.framing, promptLimits: GENERATION_PROMPT_LIMITS, generator: { provider: 'openai', model: 'gpt-image-2' },
        ratioReference: Boolean(profile.referenceInstruction) });
      if (!generator[3]) return method === 'GET' ? json({ groups: groups[key] }) : json(newGroup(key, body), 202);
      if (!group) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      if (!generator[4]) return json(advance(key, group));
      if (!variant) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      if (generator[5] === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      if (generator[5] === 'generate') { Object.assign(variant, { status: 'queued', independent: body.independent === true }); return json(group, 202); }
      const now = new Date().toISOString(), settings = key === 'template-a' ? { separateHeldObject: body.separateHeldObject } : { templateOptions: body.templateOptions };
      lastRun = { id: `2026-09-30T15-10-0${counter}-000Z-ffee1${counter++}`, createdAt: now, stage: 'planning', active: true, templateKey: key, ...settings, promptSource: { mode: 'generated' },
        layerTarget: key === 'template-a' ? { templateKey: key, suggestedLayers: 6, targetLayers: body.separateHeldObject ? 6 : 5 } : { templateKey: key },
        origin: { kind: `${key}-generation`, generationId: group.id, variantId: variant.id, aspectRatio: variant.aspectRatio }, original: { file: 'original.png', ...variant.size }, input: { file: 'original.png', ...variant.size, orientationNormalized: false },
        seedream: { endpoint: 'fake' }, timings: {}, warnings: [] };
      variant.decompositions.push({ runId: lastRun.id, createdAt: now, ...settings, ...(key === 'template-a' ? { targetLayers: body.separateHeldObject ? 6 : 5 } : {}) });
      return json(lastRun, 202);
    }
    // A run is over as soon as it is read again: nothing is ever planned or sent.
    if (/\/runs\/[^/]+$/.test(path) && lastRun) return json(Object.assign(lastRun, { stage: 'failed', active: false, error: { code: 'FAKE_STOPPED', stage: 'planning', message: 'Stopped by the in-browser fake: nothing is planned or sent.' } }));
    if (/\/runs\/[^/]+\/files\//.test(path)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    unknown.push(`${method} ${path}`);
    return route.abort();
  });
  return { groups, posts, unknown, outside, pageErrors };
}

const card = (page: Page, ratio: string) => page.locator(`article[aria-label="${ratio} variant"]`);
const statuses = (page: Page) => page.locator('[data-testid^="status-"]').allInnerTexts();
/** The labels of the creative fields shown in a template's form, in order. */
const fieldLabels = (page: Page, key: string) => page.locator(`section[data-generator="${key}"] [data-testid="field-label"]`).allTextContents();
const openPanel = async (page: Page) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
};

/** What the user types for a complete creative: nothing for Templates A and C, which start from a default one; Template B's two required inputs. */
const TYPED: Record<GenerationTemplateKey, Record<string, string>> = { 'template-a': {}, 'template-b': { 'Main product': 'Lavender smartphone', 'Scene / visual style': 'Premium pastel studio with soft lavender and pale-gray spheres around the phone' }, 'template-c': {} };
const typedValues = (key: GenerationTemplateKey) => { const profile = GENERATION_PROFILES[key]; return profile.resolveFields(Object.fromEntries(Object.entries(TYPED[key]).map(([label, value]) => [profile.fields.find(field => field.label === label)!.key, value]))).values; };
const CASES: { key: GenerationTemplateKey; controls: string[]; choose: string; body: Record<string, unknown>; run: RegExp }[] = [
  { key: 'template-a', controls: ['Separate held object from subject'], choose: 'Separate held object from subject', body: { separateHeldObject: false }, run: /\(combined, target 5\)/ },
  { key: 'template-b', controls: ['Separate touching / overlapping independent objects'], choose: 'Separate touching / overlapping independent objects', body: { templateOptions: { separateTouchingIndependentObjects: true } },
    run: /\(Separate touching \/ overlapping independent objects: on\)/ },
  { key: 'template-c', controls: ['Separate individual people / human subjects', 'Separate repeated subject / showcase panels'], choose: 'Separate individual people / human subjects',
    body: { templateOptions: { separateHumanSubjects: true, separateRepeatedModules: false } }, run: /\(Separate individual people \/ human subjects: on, Separate repeated subject \/ showcase panels: off\)/ },
];
const ALL_CONTROLS = CASES.flatMap(item => item.controls);

for (const { key, controls, choose, body, run } of CASES) {
  const profile = GENERATION_PROFILES[key], name = profile.name, values = typedValues(key), base = profile.buildBasePrompt(values), plain = Boolean(profile.tagline);
  const generateAll = plain ? 'Generate 3 variants (OpenAI gpt-image-2, 3 paid calls)' : 'Generate 3 aspect-ratio variants (OpenAI gpt-image-2, 3 paid calls)';

  test(`${name}: one creative, three ratios, each decomposed with ${name}'s own controls (fake providers)`, async ({ page }) => {
    const api = await fakeExperimentApi(page);
    await openPanel(page);
    for (const other of GENERATION_TEMPLATE_KEYS) await expect(page.getByRole('button', { name: `Create ${GENERATION_PROFILES[other].name}` })).toBeVisible();
    await page.getByRole('button', { name: `Create ${name}` }).click();
    const form = page.locator(`section[data-generator="${key}"]`);
    // Template B has the short heading of a plain form; Templates A and C keep theirs.
    await expect(form.getByText(profile.tagline ?? `${name} test generator: one creative, three aspect ratios`, { exact: true })).toBeVisible();
    await expect(page.locator('section[data-generator]')).toHaveCount(1);

    // Only this template's fields, and its own prompt built from them.
    await expect.poll(() => fieldLabels(page, key)).toEqual(profile.fields.map(field => field.label));
    for (const [label, value] of Object.entries(TYPED[key])) await form.getByLabel(label, { exact: true }).fill(value);
    await expect(page.getByTestId('shared-prompt')).toHaveText(base);
    // How the ratios stay one creative, in the template's own words: by image for Template B, by description for A and C.
    if (plain) await expect(form.getByTestId('ratio-consistency')).toHaveText(`You describe the creative once. The first size is generated from the prompt; each further size is made from that image, so ${profile.sameAcrossRatios} stay the same and only the framing changes. They are the same creative, not pixel-identical copies.`);
    else { await expect(form).toContainText(`What stays the same: ${profile.sameAcrossRatios}.`); await expect(form).toContainText(profile.mayDiffer); }
    await expect(page.getByText('No creative generated yet.')).toBeVisible();

    // One creative → one group of three variants; only the definition and the ratios are sent, to this template's endpoint.
    await page.getByRole('button', { name: generateAll }).click();
    await expect(page.locator('article[data-variant]')).toHaveCount(3);
    expect(api.posts).toEqual([{ path: `/${key}/groups`, body: { fields: values, aspectRatios: ['1:1', '16:9', '4:5'] } }]);
    const group = api.groups[key][0];
    // One ratio fails; its siblings are kept, and only it can be generated again.
    await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Failed', 'Ready']);
    await expect(card(page, '16:9').getByRole('alert')).toContainText('PROVIDER_ERROR');
    await expect(card(page, '1:1').locator('img')).toHaveCount(1);
    await expect(card(page, '16:9').getByRole('button', { name: /^Decompose 16:9 image/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /again \(1 paid call\)/ })).toHaveCount(1);
    await card(page, '16:9').getByRole('button', { name: 'Generate 16:9 again (1 paid call)' }).click();
    await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Ready', 'Ready']);
    expect(api.posts.at(-1)).toEqual({ path: `/${key}/groups/${group.id}/variants/16x9/generate` });
    // The exact prompt of a ratio: this template's base, consistency sentence and framing.
    await card(page, '16:9').getByText(/^Prompt sent/).click();
    await expect(card(page, '16:9').locator('pre')).toHaveText(`${base} ${profile.consistency} ${profile.framing['16:9']}`);
    // Template B's further ratios say which image they were made from; the first one, and every ratio of A and C, came from the prompt alone.
    await expect(page.locator('[data-testid^="reference-"]')).toHaveText(plain ? ['Made from the 1:1 image of this creative.', 'Made from the 1:1 image of this creative.'] : []);
    if (plain) await expect(card(page, '16:9')).toContainText(`Sent with the 1:1 image attached, and this sentence added: “${profile.referenceInstruction}”`);

    // Every card has this template's decomposition controls and no other template's.
    for (const ratio of GENERATION_ASPECT_RATIOS) {
      expect((await card(page, ratio).locator('label').allInnerTexts()).map(text => text.trim())).toEqual(controls);
      for (const foreign of ALL_CONTROLS.filter(label => !controls.includes(label))) await expect(card(page, ratio)).not.toContainText(foreign);
      await expect(card(page, ratio).getByRole('button', { name: `Decompose ${ratio} image (${name}: OpenAI planner + 1 paid Seedream call)` })).toBeEnabled();
    }
    // Decompose one variant: that variant only, to this template's endpoint, with this template's settings only.
    await card(page, '4:5').getByRole('checkbox', { name: choose }).click();
    await card(page, '4:5').getByRole('button', { name: /^Decompose 4:5 image/ }).click();
    await expect(page.getByText(`Image: ${name} test generation`)).toContainText('its 4:5 variant');
    expect(api.posts.at(-1)).toEqual({ path: `/${key}/groups/${group.id}/variants/4x5/decompose`, body });
    await expect(page.getByText(new RegExp(`^Template: ${name} ·`))).toBeVisible();
    await expect(page.locator('label', { hasText: /^Template:/ }).locator('select')).toHaveValue(key);
    await expect(card(page, '4:5').getByRole('button', { name: run })).toBeVisible();
    await expect(card(page, '1:1').getByText('Decompositions of this image')).toHaveCount(0);
    await expect(card(page, '16:9').getByText('Decompositions of this image')).toHaveCount(0);

    // Nothing went to another template, to an unknown endpoint, or off this machine.
    expect(api.posts.every(post => post.path.startsWith(`/${key}/`))).toBe(true);
    expect(Object.fromEntries(Object.entries(api.groups).map(([template, list]) => [template, list.length]))).toEqual({ 'template-a': 0, 'template-b': 0, 'template-c': 0, [key]: 1 });
    expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
  });
}

test('switching generators starts each template from its own form and history; an edited prompt is a new creative (fake providers)', async ({ page }) => {
  const api = await fakeExperimentApi(page), b = GENERATION_PROFILES['template-b'], c = GENERATION_PROFILES['template-c'];
  await openPanel(page);
  // A Template C creative whose notes follow its fields and name Template C's own options.
  await page.getByRole('button', { name: 'Create Template C' }).click();
  await page.getByLabel(/^Repeated panels \/ modules/).fill('three square panels along the bottom, each showing a hand with a different bracelet');
  await page.getByLabel(/^Headline text/).fill('New Season');
  const notes = page.getByRole('list', { name: 'Notes on this creative' });
  await expect(notes).toContainText('"Separate repeated subject / showcase panels"');
  await expect(notes).toContainText('"Separate individual people / human subjects"');
  await expect(notes).toContainText('Generated lettering is often misspelt');
  await expect(notes).not.toContainText(/held object|touching/i);
  await page.getByRole('button', { name: /^Generate 3 aspect-ratio variants/ }).click();
  await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Failed', 'Ready']);
  // The shared prompt edited by hand, one ratio: a new creative; the first is not touched.
  await page.getByRole('button', { name: 'Edit shared prompt' }).click();
  const box = page.getByLabel('Shared creative prompt');
  await box.fill(`${await box.inputValue()} Everyone wears white trainers.`);
  await page.getByRole('checkbox', { name: /^16:9 \(/ }).uncheck();
  await page.getByRole('checkbox', { name: /^4:5 \(/ }).uncheck();
  await page.getByRole('button', { name: 'Generate 1 aspect-ratio variant (OpenAI gpt-image-2, 1 paid call)' }).click();
  await expect(page.getByText('prompt edited')).toBeVisible();
  await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Not generated', 'Not generated']);
  const created = api.posts.at(-1)!;
  expect(created.path).toBe('/template-c/groups');
  expect(created.body).toMatchObject({ aspectRatios: ['1:1'] });
  expect(String(created.body!.basePrompt)).toMatch(/Everyone wears white trainers\.$/);
  expect(created.body).not.toHaveProperty('prompt');
  expect(api.groups['template-c'].map(group => [group.promptEdited, group.variants.map(variant => variant.status)])).toEqual([[true, ['done', 'pending', 'pending']], [false, ['done', 'failed', 'done']]]);
  await expect(page.getByLabel('Generated creative').locator('option')).toHaveCount(2);

  // Template B: its own default form and an empty history. Nothing of Template C's creative carried over.
  await page.getByRole('button', { name: 'Create Template B' }).click();
  await expect(page.locator('section[data-generator]')).toHaveCount(1);
  await expect.poll(() => fieldLabels(page, 'template-b')).toEqual(b.fields.map(field => field.label));
  await expect(page.locator('section[data-generator="template-b"]').getByLabel('Main product', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('shared-prompt-empty')).toHaveText('The prompt appears here once Main product and Scene / visual style are filled in.');
  await expect(page.locator('section[data-generator="template-b"]')).not.toContainText('white trainers');
  await expect(page.getByText('No creative generated yet.')).toBeVisible();
  // Back to Template C: its two creatives are its history, and the form starts again from Template C's defaults.
  await page.getByRole('button', { name: 'Create Template C' }).click();
  await expect(page.getByLabel('Generated creative').locator('option')).toHaveCount(2);
  await expect(page.getByTestId('shared-prompt')).toHaveText(c.buildBasePrompt(c.defaults));
  expect(api.groups['template-a']).toEqual([]);
  expect(api.groups['template-b']).toEqual([]);
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('Template B is a three-input form: main product, scene / visual style, extra details; the rest is handled for the user (fake providers)', async ({ page }) => {
  const api = await fakeExperimentApi(page), b = GENERATION_PROFILES['template-b'];
  await openPanel(page);
  await page.getByRole('button', { name: 'Create Template B' }).click();
  const form = page.locator('section[data-generator="template-b"]'), generate = page.getByRole('button', { name: /^Generate \d variants? \(OpenAI gpt-image-2/ });
  const input = (label: string) => form.getByLabel(label, { exact: true });

  // The heading says what this is and what Template B does; three inputs are shown, the two advanced choices are folded away.
  await expect(form.getByText('Template B', { exact: true })).toBeVisible();
  await expect(form.getByTestId('generator-tagline')).toHaveText('Product-focused advertising creative');
  await expect(form).toContainText('Describe one product creative. Template B handles the composition, lighting and decomposition-friendly structure for you.');
  await expect.poll(() => fieldLabels(page, 'template-b')).toEqual(['Main product', 'Scene / visual style', 'Extra details', 'Product angle', 'Text in the image']);
  await expect(form.locator('input:not([type=checkbox]):visible, textarea:visible, select:visible')).toHaveCount(3);
  await expect(form.getByTestId('field-requirement')).toHaveText(['Required', 'Required', 'Optional']);
  await expect(form.getByTestId('advanced-options')).not.toHaveAttribute('open');
  await expect(form.getByTestId('advanced-options').locator('summary')).toHaveText('Advanced options');
  await expect(input('Product angle')).toBeHidden();
  // None of the prompt-engineering fields is asked for.
  for (const removed of ['Material', 'Intrinsic', 'orientation', 'pedestal', 'Secondary', 'Foreground', 'Composition', 'Lighting', 'palette', 'Product look', 'Background / scene', 'Extra objects'])
    expect((await fieldLabels(page, 'template-b')).some(label => label.toLowerCase().includes(removed.toLowerCase()))).toBe(false);

  // Each input starts empty and shows its placeholder, its helper and its examples.
  for (const field of b.fields.filter(item => !item.advanced)) {
    const box = form.locator(`[data-field="${field.key}"]`);
    await expect(input(field.label)).toHaveValue('');
    await expect(input(field.label)).toHaveAttribute('placeholder', field.placeholder!);
    await expect(input(field.label)).toHaveAttribute('aria-required', String(field.required));
    await expect(box).toContainText(field.help);
    await expect(box.getByTestId('field-example')).toHaveCount(field.examples!.length);
    for (const example of field.examples!) await expect(box).toContainText(example);
  }
  await expect(input('Main product')).toHaveAttribute('placeholder', 'e.g. lavender premium smartphone');
  await expect(form.locator('[data-field="sceneStyle"]')).toContainText('Describe the look and setting you want around the product.');

  // An untouched empty form shows no error; it says what is missing, and cannot be generated.
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(form.getByText('This field is required.')).toHaveCount(0);
  await expect(form.getByTestId('generate-hint')).toHaveText('To generate, fill in: Main product, Scene / visual style.');
  await expect(form.getByTestId('shared-prompt-empty')).toHaveText('The prompt appears here once Main product and Scene / visual style are filled in.');
  await expect(generate).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit shared prompt' })).toBeDisabled();

  // The good default experience: the two required inputs and nothing else.
  await input('Main product').fill('Lavender smartphone');
  await expect(form.getByTestId('generate-hint')).toHaveText('To generate, fill in: Scene / visual style.');
  await input('Scene / visual style').fill('Premium pastel studio with soft lavender spheres');
  const simple = b.buildBasePrompt(b.resolveFields({ mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender spheres' }).values);
  await expect(page.getByTestId('shared-prompt')).toHaveText(simple);
  for (const rule of ['featuring one Lavender smartphone as the single, clearly dominant hero', 'is a separate element, complete and clearly distinguishable from the hero', 'soft professional advertising lighting with gentle shadows and a balanced composition',
    'No people or hands, no extra copies of the hero, no unrelated props, no clutter, and no text or logos except what is on the hero itself']) expect(simple).toContain(rule);
  await expect(form.getByTestId('generate-hint')).toHaveCount(0);
  await expect(generate).toBeEnabled();
  // The prompt is secondary: built for the user, to look over.
  await expect(form.getByTestId('prompt-help')).toHaveText('Built automatically from your Template B inputs. You can review it before generation.');
  await expect(form.getByTestId('prompt-edited')).toHaveCount(0);
  // A required input emptied again is pointed out where it is; the optional one never is.
  await input('Scene / visual style').fill('');
  await expect(form.locator('[data-field="sceneStyle"]')).toContainText('This field is required.');
  await expect(input('Scene / visual style')).toHaveAttribute('aria-invalid', 'true');
  await expect(generate).toBeDisabled();
  await input('Extra details').fill('x');
  await input('Extra details').fill('');
  await expect(form.locator('[data-field="extraDetails"]')).not.toContainText('This field is required.');

  // CASE 1: the smartphone with its spheres and extra details.
  await input('Scene / visual style').fill('Premium pastel studio with soft lavender and pale-gray spheres around the phone');
  await input('Extra details').fill('Back facing viewer, no text');
  const phone = { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender and pale-gray spheres around the phone', extraDetails: 'Back facing viewer, no text', productAngle: 'auto', imageText: 'avoid' };
  const built = b.buildBasePrompt(phone);
  await expect(page.getByTestId('shared-prompt')).toHaveText(built);
  expect(built).toContain('Scene and visual style: Premium pastel studio with soft lavender and pale-gray spheres around the phone. Requested details: Back facing viewer, no text.');
  expect(built.length).toBeLessThan(1100);

  // Advanced options: one small choice changes one phrase, and the summary says something was changed.
  await form.getByTestId('advanced-options').locator('summary').click();
  await expect(input('Product angle')).toHaveValue('auto');
  await expect(input('Text in the image')).toHaveValue('avoid');
  await input('Product angle').selectOption('three-quarter');
  await expect(page.getByTestId('shared-prompt')).toContainText('large in the frame, in a three-quarter view;');
  await expect(form.getByTestId('advanced-options').locator('summary')).toHaveText('Advanced options (1 changed)');
  await input('Product angle').selectOption('auto');
  await expect(page.getByTestId('shared-prompt')).toHaveText(built);

  // Editing the prompt by hand is obvious, overrides the inputs, and can be undone: the rebuild is from the inputs, deterministically.
  await page.getByRole('button', { name: 'Edit shared prompt' }).click();
  const box = page.getByLabel('Shared creative prompt');
  await expect(box).toHaveValue(built);
  await box.fill(`${built} Late afternoon mood.`);
  await expect(form.getByTestId('prompt-edited')).toHaveText('Edited by hand');
  await expect(form.getByTestId('prompt-help')).toHaveText('Editing this prompt overrides the automatic prompt for this creative. What you type in the fields above is not used until you discard the edit.');
  await input('Main product').fill('Mint smartphone');
  await expect(box).toHaveValue(`${built} Late afternoon mood.`);
  await page.getByRole('button', { name: 'Discard edit (rebuild from the fields)' }).click();
  await expect(form.getByTestId('prompt-edited')).toHaveCount(0);
  await expect(page.getByTestId('shared-prompt')).toHaveText(b.buildBasePrompt({ ...phone, mainProduct: 'Mint smartphone' }));
  await input('Main product').fill('Lavender smartphone');
  await expect(page.getByTestId('shared-prompt')).toHaveText(built);

  // Sizes: the three ratios, chosen once for the one creative; then one group of three cards.
  await expect(form.getByText('Generate sizes', { exact: true })).toBeVisible();
  for (const ratio of ['1:1', '16:9', '4:5']) await expect(page.getByRole('checkbox', { name: new RegExp(`^${ratio} \\(`) })).toBeChecked();
  await page.getByRole('checkbox', { name: /^4:5 \(/ }).uncheck();
  await expect(page.getByRole('button', { name: 'Generate 2 variants (OpenAI gpt-image-2, 2 paid calls)' })).toBeEnabled();
  await page.getByRole('checkbox', { name: /^4:5 \(/ }).check();
  await page.getByRole('button', { name: 'Generate 3 variants (OpenAI gpt-image-2, 3 paid calls)' }).click();
  await expect(page.locator('article[data-variant]')).toHaveCount(3);
  // Only the inputs are sent; the server builds the prompt.
  expect(api.posts).toEqual([{ path: '/template-b/groups', body: { fields: phone, aspectRatios: ['1:1', '16:9', '4:5'] } }]);
  await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Failed', 'Ready']);
  // The failed ratio was attempted from the 1:1 image: it can be tried again that way, or from the prompt only.
  await expect(card(page, '16:9').getByTestId('reference-16x9')).toHaveText('Last attempt made from the 1:1 image of this creative.');
  await card(page, '16:9').getByRole('button', { name: 'Generate 16:9 from the prompt only (1 paid call)' }).click();
  await expect.poll(() => statuses(page), { timeout: 15_000 }).toEqual(['Ready', 'Ready', 'Ready']);
  expect(api.posts.at(-1)).toEqual({ path: `/template-b/groups/${api.groups['template-b'][0].id}/variants/16x9/generate`, body: { independent: true } });
  await expect(card(page, '16:9').getByTestId('reference-16x9')).toHaveCount(0);
  await expect(card(page, '4:5').getByTestId('reference-4x5')).toHaveText('Made from the 1:1 image of this creative.');
  // Every card still carries Template B's own decomposition option, and its own Decompose button.
  for (const ratio of ['1:1', '16:9', '4:5']) {
    expect((await card(page, ratio).locator('label').allInnerTexts()).map(text => text.trim())).toEqual(['Separate touching / overlapping independent objects']);
    await expect(card(page, ratio).getByRole('button', { name: `Decompose ${ratio} image (Template B: OpenAI planner + 1 paid Seedream call)` })).toBeEnabled();
  }

  // Templates A and C keep the form they had: all their fields, one flat grid, the asterisk for required, no advanced options.
  for (const key of ['template-a', 'template-c'] as const) {
    await page.getByRole('button', { name: `Create ${GENERATION_PROFILES[key].name}` }).click();
    const other = page.locator(`section[data-generator="${key}"]`);
    await expect.poll(() => fieldLabels(page, key)).toEqual(GENERATION_PROFILES[key].fields.map(field => field.label));
    await expect(other.getByText(`${GENERATION_PROFILES[key].name} test generator: one creative, three aspect ratios`)).toBeVisible();
    await expect(other.locator('textarea, select')).toHaveCount(0);
    for (const id of ['field-requirement', 'generator-tagline', 'advanced-options', 'prompt-help', 'generate-hint', 'ratio-consistency']) await expect(other.getByTestId(id)).toHaveCount(0);
    await expect(other).toContainText('* = required.');
    await expect(other.getByText('Generate now:', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate 3 aspect-ratio variants (OpenAI gpt-image-2, 3 paid calls)' })).toBeEnabled();
    await expect(page.getByTestId('shared-prompt')).toHaveText(GENERATION_PROFILES[key].buildBasePrompt(GENERATION_PROFILES[key].defaults));
  }
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});

test('Template B: a creative stored by an earlier form is listed as stored, and loads into the three inputs (fake providers)', async ({ page }) => {
  const api = await fakeExperimentApi(page), b = GENERATION_PROFILES['template-b'];
  // A version 1 record as the server would serve it: fourteen fields, its own prompts, one ratio generated, independent generation.
  const base = 'Create a clean, editorial product advertising image with one ceramic table lamp as the single, clearly dominant hero object: matte cream body with a linen shade and a brass switch.';
  const fields = { heroProduct: 'ceramic table lamp', heroDescription: 'matte cream body with a linen shade and a brass switch', material: 'glazed ceramic', intrinsicDetails: '', placement: 'upright, centred, three-quarter view', support: 'low round stone pedestal',
    secondaryObjects: '', decoration: 'two soft arch shapes behind the product', foregroundAccents: '', background: 'soft warm-beige studio backdrop with a gentle gradient', composition: '', lighting: '', palette: '', extraNotes: '' };
  api.groups['template-b'].push({ id: '2026-09-30T09-40-12-345Z-b1c2d3', templateKey: 'template-b', version: 'template-b-generation-v1', createdAt: '2026-09-30T09:40:12.345Z', updatedAt: '2026-09-30T09:41:30.000Z', fields, builtPrompt: base, basePrompt: base, promptEdited: false,
    aspectRatios: ['1:1', '16:9', '4:5'], variants: (['1:1', '16:9', '4:5'] as const).map(ratio => ({ id: ratio.replace(':', 'x'), aspectRatio: ratio, size: { width: 1024, height: 1024 }, status: ratio === '1:1' ? 'done' : 'pending', framing: b.framing[ratio],
      prompt: `${base} ${b.consistency} ${b.framing[ratio]}`, generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: ratio === '1:1' ? 1 : 0,
      decompositions: ratio === '1:1' ? [{ runId: '2026-09-30T09-50-00-000Z-0ldrun', createdAt: '2026-09-30T09:50:00.000Z', templateOptions: { separateTouchingIndependentObjects: true } }] : [],
      ...(ratio === '1:1' ? { image: { file: '1x1.image.png', mimeType: 'image/png', width: 1024, height: 1024, bytes: 1 } } : {}) })) });
  await openPanel(page);
  await page.getByRole('button', { name: 'Create Template B' }).click();
  const form = page.locator('section[data-generator="template-b"]');
  // It is in the history and shown as it was stored: its name, its prompt, its fourteen fields, its image, its decomposition link.
  await expect(page.getByLabel('Generated creative').locator('option')).toHaveText([/b1c2d3 — ceramic table lamp — 1:1 ready, 16:9 not generated, 4:5 not generated/]);
  await expect(page.getByText('Creative 2026-09-30T09-40-12-345Z-b1c2d3')).toBeVisible();
  await expect.poll(() => statuses(page)).toEqual(['Ready', 'Not generated', 'Not generated']);
  await expect(card(page, '1:1').getByRole('button', { name: /^Decompose 1:1 image \(Template B:/ })).toBeEnabled();
  await expect(card(page, '1:1').getByRole('button', { name: /0ldrun \(Separate touching \/ overlapping independent objects: on\)/ })).toBeVisible();
  await page.getByText(/^Shared creative prompt \(\d+ characters, built from the fields\)$/).click();
  await expect(page.locator('details', { hasText: /^Shared creative prompt \(/ }).locator('pre').first()).toHaveText(base);
  await page.getByText('Field values').click();
  await expect(page.locator('details', { hasText: 'Field values' }).locator('pre')).toContainText('"heroDescription": "matte cream body with a linen shade and a brass switch"');
  // Loading it fills today's three inputs from its fourteen fields; nothing is sent, and the stored record is not touched.
  await page.getByRole('button', { name: 'Load this creative into the form' }).click();
  await expect(form.getByLabel('Main product', { exact: true })).toHaveValue('ceramic table lamp');
  await expect(form.getByLabel('Scene / visual style', { exact: true })).toHaveValue('soft warm-beige studio backdrop with a gentle gradient; low round stone pedestal under the product; two soft arch shapes behind the product');
  await expect(form.getByLabel('Extra details', { exact: true })).toHaveValue('matte cream body with a linen shade and a brass switch; glazed ceramic; upright, centred, three-quarter view');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('shared-prompt')).toContainText('featuring one ceramic table lamp as the single, clearly dominant hero. Scene and visual style: soft warm-beige studio backdrop with a gentle gradient; low round stone pedestal under the product;');
  expect(api.posts).toEqual([]);
  expect(api.groups['template-b'][0].fields).toEqual(fields);
  expect([api.unknown, api.outside, api.pageErrors]).toEqual([[], [], []]);
});
