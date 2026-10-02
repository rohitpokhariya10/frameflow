import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * The reusable-template system is local and deterministic. This guards that at the source: none of its files names an
 * AI provider, makes a request or addresses a server, and they import only local modules. It reads the shared module
 * (the templates folder, the shared CanvasElement model and its editor adapter) and the client feature folder.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = here, CLIENT = join(here, '../../../client/src/features/templates');
const sources = (folder: string) => readdirSync(folder).filter(file => /\.(ts|tsx|css)$/.test(file) && !/\.test\.ts$/.test(file)).map(file => ({ file, text: readFileSync(join(folder, file), 'utf8') }));
/** The element model every canvas shares, and its lossless adapter to the editor's format. */
const shared = () => [...sources(SHARED), ...['canvasElement.ts', 'canvasEditorAdapter.ts'].map(file => ({ file, text: readFileSync(join(here, '..', file), 'utf8') }))];
const FORBIDDEN = /openai|@fal-ai|\bfal\b|seedream|gemini|cloudflare|layerize|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\/|https?:\/\//i;
const imports = (text: string) => [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(match => match[1]);

it('the template source has no AI provider, no request and no server address in it', () => {
  const found = [...shared(), ...sources(CLIENT)].flatMap(({ file, text }) => text.split('\n').filter(line => FORBIDDEN.test(line) && !(file === 'diwaliAssets.ts' && line.includes('www.w3.org/2000/svg'))).map(line => `${file}: ${line.trim()}`));
  expect(found).toEqual([]);
  expect(shared().length).toBeGreaterThanOrEqual(9);
  expect(sources(CLIENT).length).toBeGreaterThanOrEqual(8);
});

it('the template source imports only local code: the shared module, React, Konva and the editor\'s canvas, store, asset and storage helpers', () => {
  const sharedAllowed = /^\.\/[a-zA-Z]+\.js$|^\.\.\/fonts\/catalog\.js$|^\.\.\/(index|text|canvasElement)\.js$|^\.\/designTemplates\/[a-zA-Z]+\.js$/;
  const clientAllowed = /^(react|lucide-react|@frameflow\/shared)$|^konva\/lib\/|^react-konva\/lib\/|^\.\/[a-zA-Z]+(\.css)?$|^\.\.\/\.\.\/(store|store\/(editorSlice|uiSlice)|lib\/assets\/runtimeAssets|lib\/persistence\/(schema|projectStorage)|components\/ui\/NumberField)$|^\.\.\/aiThemes\/AIThemePanel$|^\.\.\/fonts\/(FontPicker|useFonts)$|^\.\.\/canvas\/(DesignLayerNode|layerGeometry|viewport)$|^\.\.\/decomposition\/workspace\/workspace\.css$/;
  expect(shared().flatMap(({ file, text }) => imports(text).filter(name => !sharedAllowed.test(name)).map(name => `${file}: ${name}`))).toEqual([]);
  expect(sources(CLIENT).flatMap(({ file, text }) => imports(text).filter(name => !clientAllowed.test(name) && name !== '../editor/selectionKeyboard' && !(file === 'TemplateStudio.tsx' && name === '../referenceCreatives/ReferenceCreative')).map(name => `${file}: ${name}`))).toEqual([]);
});


it('the on-demand font module has only the approved public font endpoint and no provider/API client', () => {
  const fontSources = sources(join(CLIENT, '../fonts'));
  const provider = /openai|@fal-ai|\bfal\b|seedream|gemini|cloudflare|layerize|\/api\//i;
  expect(fontSources.flatMap(({file,text}) => text.split('\n').filter(line => provider.test(line)).map(line => `${file}: ${line}`))).toEqual([]);
  const urls = fontSources.flatMap(({text}) => [...text.matchAll(/https?:\/\/([^/\s]+)/g)].map(match => match[1]));
  expect(urls).toEqual(['fonts.googleapis.com']);
});
