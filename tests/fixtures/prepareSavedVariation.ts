/**
 * Offline verification of a saved poster. Reads the original only; all analysis, reviews and logo replacements happen
 * in a fresh fixture beneath test-results. Prints the directory to pass as FRAMEFLOW_SAVED_VARIATION_FIXTURE.
 * Run: node --conditions=development --import tsx tests/fixtures/prepareSavedVariation.ts <template-directory>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import type { ProtectedTemplate } from '@frameflow/shared';
import { createProtectedTemplates } from '../../server/src/decomposition/protectedTemplates/service.js';
import { fileProtectedStore } from '../../server/src/decomposition/protectedTemplates/store.js';
import { tesseractRecognizer } from '../../server/src/textRecognition/recognizer.js';

globalThis.fetch = async () => { throw new Error('Network disabled in saved-poster verification.'); };
const sourceDir = resolve(process.argv[2] ?? 'artifacts/decomposition/protected-templates/pt-f02c645d8e82');
const original = JSON.parse(readFileSync(join(sourceDir, 'template.json'), 'utf8')) as ProtectedTemplate;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const before = Object.fromEntries(readdirSync(sourceDir).map(file => [file, hash(readFileSync(join(sourceDir, file)))]));
mkdirSync('test-results/recovery', { recursive: true });
const root = mkdtempSync(resolve('test-results/recovery/saved-poster-'));
cpSync(sourceDir, join(root, 'protected', original.id), { recursive: true, errorOnExist: true });
const store = fileProtectedStore(join(root, 'protected')), recognizer = tesseractRecognizer();
const service = createProtectedTemplates({ store, runsDir: join(root, 'runs'), isActiveRun: () => false,
  deps: () => { throw new Error('No provider is available in this verification.'); }, recognizer: () => recognizer });
try {
  let template = await service.analyseText(original.id, original.revision);
  const analysis = template.textAnalysis!;
  const headline = ['Easy', 'EMI', 'available.'].map(text => {
    const matches = analysis.words.filter(w => w.text === text);
    assert.equal(matches.length, 1, `One independent word for ${text}`);
    return matches[0];
  });
  const [easy, emi, available] = headline;
  assert.ok(easy.box.y + easy.box.height <= emi.box.y, 'Easy must not overlap EMI');
  assert.ok(emi.box.y + emi.box.height <= available.box.y, 'EMI must not overlap available.');
  const banks = analysis.logoSlots.filter(l => l.detection === 'tile-grid');
  assert.equal(banks.length, 10, 'All ten bank tiles');
  assert.equal(new Set(banks.map(l => l.id)).size, 10);
  const overlay = [...headline.map(w => ({ box: w.box, label: w.text, color: '#e00040' })),
    ...banks.map((l, i) => ({ box: l.box, label: `Bank ${i + 1}`, color: '#0055ff' }))];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${template.source.width}" height="${template.source.height}">${overlay.map(({ box: b, label, color }) =>
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="${color}" stroke-width="5"/><text x="${b.x}" y="${b.y - 8}" font-size="26" fill="${color}">${label}</text>`).join('')}</svg>`;
  const annotated = await sharp(readFileSync(join(sourceDir, original.source.inputFile))).rotate().composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  await sharp(annotated).resize({ width: 910 }).png().toFile(join(root, 'detected-boxes.png'));
  writeFileSync(join(root, 'analysis.json'), JSON.stringify(analysis, null, 2));
  // Reviews are confined to this test copy. Keep every original geometry and make the slots editable for the browser test.
  template = await service.correctText(template.id, template.revision, { expectedAnalysisRevision: analysis.revision,
    groups: analysis.groups, words: analysis.words.map(w => ({ ...w, locked: false, review: { status: 'approved' } })),
    logoSlots: analysis.logoSlots.map(l => ({ ...l, locked: false, review: { status: 'approved' } })) });
  // Replace each bank independently with its own crop: exact bytes, unchanged other slots, and unchanged original asset.
  for (const bank of banks) {
    const otherSlots = template.textAnalysis!.logoSlots.filter(l => l.id !== bank.id);
    const bytes = store.read(template.id, bank.original.file);
    template = await service.replaceLogo(template.id, template.revision, bank.id, bytes, `bank-${bank.order}.png`);
    assert.deepEqual(template.textAnalysis!.logoSlots.filter(l => l.id !== bank.id), otherSlots);
    const changed = template.textAnalysis!.logoSlots.find(l => l.id === bank.id)!;
    assert.equal(changed.replacement!.sha256, hash(bytes));
    assert.deepEqual(changed.original, bank.original);
  }
  for (const [file, sha] of Object.entries(before)) assert.equal(hash(readFileSync(join(sourceDir, file))), sha, `Original unchanged: ${file}`);
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ templateId: template.id, name: template.name, engine: recognizer.engine,
    headline: headline.map(w => ({ text: w.text, confidence: w.confidence, box: w.box })), words: analysis.words.length,
    bankSlots: banks.length, totalLogoSlots: analysis.logoSlots.length, independentReplacements: banks.length,
    originalFilesUnchanged: Object.keys(before).length, sourceDir }, null, 2));
  console.log(root);
} finally { await recognizer.close?.(); }
