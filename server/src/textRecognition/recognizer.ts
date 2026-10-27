/**
 * Local word recognition: tesseract.js with its English LSTM model from node_modules (@tesseract.js-data/eng). It runs in
 * this process and never opens a network connection: the model is read from disk, nothing is cached elsewhere, and no
 * AI provider is involved. It is injectable, so tests and the offline fixture use a deterministic fake.
 *
 * A region is read twice and the answers merged: as one block of text (PSM 6, keeps lines and reading order) and as
 * sparse text (PSM 11, finds words of very different sizes in one region, like a huge "EMI" between two smaller words).
 * Every word keeps the engine's own box; nothing here splits or invents a box.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

export interface RecognizedWord {
  text: string;
  /** 0..1. */
  confidence: number;
  /** Pixels of the image given, whole pixels (x1, y1 exclusive). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** The line's baseline under this word, in the same pixels, when the engine gave one. */
  baseline?: { x0: number; y0: number; x1: number; y1: number };
  mode: string;
}
export interface RecognizeInput {
  /** An image of one region (PNG). */
  image: Buffer;
  /** Where the image sits in the source, in source pixels (a fake recognizer answers by it). */
  region: { x: number; y: number; width: number; height: number };
  /** template: words of a protected region. artwork-check: any text an image model may have drawn. */
  purpose: 'template' | 'artwork-check';
}
export interface WordRecognizer {
  engine: { name: string; version: string; model: string; modes: string[] };
  recognize(input: RecognizeInput): Promise<RecognizedWord[]>;
  close?(): Promise<void>;
}

const require = createRequire(import.meta.url);
type TesseractWorker = { setParameters(p: Record<string, string>): Promise<unknown>; recognize(image: Buffer, options: object, output: object): Promise<{ data: TesseractPage }>; terminate(): Promise<unknown> };
type Bbox = { x0: number; y0: number; x1: number; y1: number };
type TesseractPage = { blocks: { paragraphs: { lines: { baseline?: Bbox & { has_baseline?: boolean }; words: { text: string; confidence: number; bbox: Bbox }[] }[] }[] }[] | null };

/** Smallest overlap (intersection over union) at which a word from one reading is the same word as one from the other. */
const SAME_WORD_IOU = 0.3;
const iou = (a: Bbox, b: Bbox) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
};
/** Both readings in one list: a word found by both is kept once, with the more confident reading. */
export function mergeReadings(...readings: RecognizedWord[][]): RecognizedWord[] {
  const out: RecognizedWord[] = [];
  for (const words of readings) for (const w of words) {
    const same = out.findIndex(o => iou(o.box, w.box) >= SAME_WORD_IOU);
    if (same < 0) out.push(w);
    else if (w.confidence > out[same].confidence) out[same] = w;
  }
  return out;
}
/** A reading worth keeping: some letter or digit, and not a near-certain misread (very low confidence). */
export const plausibleWord = (w: Pick<RecognizedWord, 'text' | 'confidence'>, minConfidence = 0.35) => /[\p{L}\p{N}]/u.test(w.text) && w.text.trim().length > 0 && w.confidence >= minConfidence;

/**
 * The tesseract recognizer. One worker, created on first use and stopped after a minute without work; calls run one at
 * a time (a worker reads one image at a time, and its page mode is per worker).
 */
export function tesseractRecognizer(options: { idleMs?: number } = {}): WordRecognizer {
  const pkg = (name: string) => require(`${name}/package.json`) as { version: string };
  const modelDir = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  let worker: Promise<TesseractWorker> | undefined, idle: ReturnType<typeof setTimeout> | undefined, queue: Promise<unknown> = Promise.resolve();
  const start = async () => {
    const { createWorker } = await import('tesseract.js');
    // langPath on disk, no cache: the model is read from node_modules and never fetched or written anywhere else.
    return createWorker('eng', 1, { langPath: modelDir, gzip: true, cacheMethod: 'none', logger: () => undefined, errorHandler: () => undefined }) as unknown as Promise<TesseractWorker>;
  };
  const stop = async () => { const w = worker; worker = undefined; if (w) await (await w).terminate().catch(() => undefined); };
  const read = async (w: TesseractWorker, image: Buffer, psm: '6' | '11', scale: number): Promise<RecognizedWord[]> => {
    await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '0', user_defined_dpi: '300' });
    const { data } = await w.recognize(image, {}, { blocks: true, text: false, hocr: false, tsv: false });
    const out: RecognizedWord[] = [], s = (b: Bbox) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale });
    for (const block of data.blocks ?? []) for (const p of block.paragraphs) for (const line of p.lines) for (const word of line.words) {
      const baseline = line.baseline && line.baseline.has_baseline !== false && line.baseline.x1 > line.baseline.x0 ? s(line.baseline) : undefined;
      out.push({ text: word.text.trim(), confidence: Math.max(0, Math.min(1, word.confidence / 100)), box: s(word.bbox), ...(baseline ? { baseline } : {}), mode: psm === '6' ? 'block' : 'sparse' });
    }
    return out;
  };
  return {
    engine: { name: 'tesseract.js', version: pkg('tesseract.js').version, model: `eng ${pkg('@tesseract.js-data/eng').version} (4.0.0_best_int, LSTM)`, modes: ['block (PSM 6)', 'sparse (PSM 11)'] },
    recognize(input) {
      const job = queue.then(async () => {
        if (idle) clearTimeout(idle);
        worker ??= start();
        const w = await worker;
        // Grey, contrast-stretched, light text inverted to dark on light, and small text enlarged: what the model reads best.
        const { width = 0, height = 0 } = await sharp(input.image).metadata();
        const scale = Math.min(width, height) < 60 ? 3 : Math.min(width, height) < 140 ? 2 : 1;
        const grey = sharp(input.image).flatten({ background: '#ffffff' }).grayscale().normalise();
        const stats = await grey.clone().stats();
        const image = await (stats.channels[0].mean < 110 ? grey.negate({ alpha: false }) : grey).resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' }).png().toBuffer();
        const block = await read(w, image, '6', scale), sparse = await read(w, image, '11', scale);
        return mergeReadings(block, sparse).filter(word => plausibleWord(word));
      }).finally(() => { idle = setTimeout(() => { void stop(); }, options.idleMs ?? 60_000); idle.unref?.(); });
      queue = job.catch(() => undefined);
      return job;
    },
    close: async () => { if (idle) clearTimeout(idle); await queue; await stop(); },
  };
}

let local: WordRecognizer | undefined;
/** The process's one local recognizer (protected templates and the Studio's artwork check share its worker). */
export const localRecognizer = (): WordRecognizer => (local ??= tesseractRecognizer());

/**
 * MOCK recognizer for tests and the offline fixture. Words are given in SOURCE pixels; a template read returns those inside
 * the region asked for (in the region's own pixels). An artwork check reads `artworkText` only for images that carry the
 * marker colour (#ff00ff): the fake image model draws it when asked to simulate text drawn into artwork.
 */
export function fakeRecognizer(words: { text: string; confidence: number; box: { x: number; y: number; width: number; height: number }; baselineY?: number }[], options: { artworkText?: string[] } = {}): WordRecognizer & { calls: RecognizeInput[] } {
  const calls: RecognizeInput[] = [];
  return {
    calls,
    engine: { name: 'fake-recognizer', version: '1', model: 'offline fixture (no OCR)', modes: ['fixture'] },
    async recognize(input) {
      calls.push(input);
      const r = input.region;
      if (input.purpose === 'artwork-check') {
        const { data } = await sharp(input.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let marked = 0;
        for (let i = 0; i < data.length; i += 3) if (data[i] > 245 && data[i + 1] < 10 && data[i + 2] > 245) marked++;
        return marked >= 200 ? (options.artworkText ?? ['SALE']).map((text, i) => ({ text, confidence: 0.9, box: { x0: 10 + i * 60, y0: 10, x1: 60 + i * 60, y1: 40 }, mode: 'fixture' })) : [];
      }
      return words.filter(w => w.box.x >= r.x - 0.5 && w.box.y >= r.y - 0.5 && w.box.x + w.box.width <= r.x + r.width + 0.5 && w.box.y + w.box.height <= r.y + r.height + 0.5)
        .map(w => ({ text: w.text, confidence: w.confidence, mode: 'fixture',
          box: { x0: w.box.x - r.x, y0: w.box.y - r.y, x1: w.box.x + w.box.width - r.x, y1: w.box.y + w.box.height - r.y },
          ...(w.baselineY !== undefined ? { baseline: { x0: w.box.x - r.x, y0: w.baselineY - r.y, x1: w.box.x + w.box.width - r.x, y1: w.baselineY - r.y } } : {}) }));
    },
  };
}
