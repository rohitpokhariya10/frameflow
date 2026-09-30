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
  error?: Record<string, unknown>; image?: Record<string, unknown>; durationMs?: number };
type Group = { id: string; templateKey: GenerationTemplateKey; promptEdited: boolean; variants: Variant[] } & Record<string, unknown>;
type Post = { path: string; body?: Record<string, unknown> };

/** Installs the fake experiment API on the page. Generating "finishes" when the group is next read; the first creative of each template has its 16:9 fail once. */
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
      ...(key === 'template-a' ? { structure: { visibleBorder: hasVisibleBorder(values as TemplateAFieldValues), heldObject: hasHeldObject(values as TemplateAFieldValues) } } : {}), ...(notes.length ? { notes } : {}), aspectRatios: [...GENERATION_ASPECT_RATIOS],
      variants: GENERATION_ASPECT_RATIOS.map(ratio => ({ id: generationVariantId(ratio), aspectRatio: ratio, size: GENERATION_IMAGE_SIZES[ratio], status: wanted.includes(ratio) ? 'queued' : 'pending', framing: profile.framing[ratio],
        prompt: buildGenerationVariantPrompt(profile, base.basePrompt, ratio), generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 0, decompositions: [] })) };
    groups[key].unshift(group);
    return group;
  };
  const advance = (key: GenerationTemplateKey, group: Group) => {
    for (const variant of group.variants) {
      if (variant.status !== 'queued') continue;
      variant.attempts += 1;
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
        defaults: profile.defaults, aspectRatios: GENERATION_ASPECT_RATIOS, imageSizes: GENERATION_IMAGE_SIZES, consistency: profile.consistency, framing: profile.framing, promptLimits: GENERATION_PROMPT_LIMITS, generator: { provider: 'openai', model: 'gpt-image-2' } });
      if (!generator[3]) return method === 'GET' ? json({ groups: groups[key] }) : json(newGroup(key, body), 202);
      if (!group) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      if (!generator[4]) return json(advance(key, group));
      if (!variant) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      if (generator[5] === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      if (generator[5] === 'generate') { variant.status = 'queued'; return json(group, 202); }
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
const fieldLabels = (page: Page, key: string) => page.locator(`section[data-generator="${key}"] label:has(input:not([type=checkbox])) > span:first-child`)
  .evaluateAll(nodes => nodes.map(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').replace(/\*/, '').trim()));
const openPanel = async (page: Page) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
};

const CASES: { key: GenerationTemplateKey; controls: string[]; choose: string; body: Record<string, unknown>; run: RegExp }[] = [
  { key: 'template-a', controls: ['Separate held object from subject'], choose: 'Separate held object from subject', body: { separateHeldObject: false }, run: /\(combined, target 5\)/ },
  { key: 'template-b', controls: ['Separate touching / overlapping independent objects'], choose: 'Separate touching / overlapping independent objects', body: { templateOptions: { separateTouchingIndependentObjects: true } },
    run: /\(Separate touching \/ overlapping independent objects: on\)/ },
  { key: 'template-c', controls: ['Separate individual people / human subjects', 'Separate repeated subject / showcase panels'], choose: 'Separate individual people / human subjects',
    body: { templateOptions: { separateHumanSubjects: true, separateRepeatedModules: false } }, run: /\(Separate individual people \/ human subjects: on, Separate repeated subject \/ showcase panels: off\)/ },
];
const ALL_CONTROLS = CASES.flatMap(item => item.controls);

for (const { key, controls, choose, body, run } of CASES) {
  const profile = GENERATION_PROFILES[key], name = profile.name, base = profile.buildBasePrompt(profile.defaults);

  test(`${name}: one creative, three ratios, each decomposed with ${name}'s own controls (fake providers)`, async ({ page }) => {
    const api = await fakeExperimentApi(page);
    await openPanel(page);
    for (const other of GENERATION_TEMPLATE_KEYS) await expect(page.getByRole('button', { name: `Create ${GENERATION_PROFILES[other].name}` })).toBeVisible();
    await page.getByRole('button', { name: `Create ${name}` }).click();
    const form = page.locator(`section[data-generator="${key}"]`);
    await expect(form.getByText(`${name} test generator: one creative, three aspect ratios`)).toBeVisible();
    await expect(page.locator('section[data-generator]')).toHaveCount(1);

    // Only this template's fields, and its own prompt built from them.
    await expect.poll(() => fieldLabels(page, key)).toEqual(profile.fields.map(field => field.label));
    await expect(page.getByTestId('shared-prompt')).toHaveText(base);
    await expect(form).toContainText(`What stays the same: ${profile.sameAcrossRatios}.`);
    await expect(form).toContainText(profile.mayDiffer);
    await expect(page.getByText('No creative generated yet.')).toBeVisible();

    // One creative → one group of three variants; only the definition and the ratios are sent, to this template's endpoint.
    await page.getByRole('button', { name: 'Generate 3 aspect-ratio variants (OpenAI gpt-image-2, 3 paid calls)' }).click();
    await expect(page.locator('article[data-variant]')).toHaveCount(3);
    expect(api.posts).toEqual([{ path: `/${key}/groups`, body: { fields: profile.defaults, aspectRatios: ['1:1', '16:9', '4:5'] } }]);
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
  await expect(page.getByTestId('shared-prompt')).toHaveText(b.buildBasePrompt(b.defaults));
  await expect.poll(() => fieldLabels(page, 'template-b')).toEqual(b.fields.map(field => field.label));
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
