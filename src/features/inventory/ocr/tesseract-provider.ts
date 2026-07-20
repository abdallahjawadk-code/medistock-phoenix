import {
  OcrCancelledError, OcrUnavailableError,
  type OcrProvider, type OcrProviderOptions, type OcrLanguage,
  type OcrDocumentResult, type OcrWord, type OcrLine,
} from './types';

/**
 * PHARMA-OCR-A — browser-local Tesseract provider.
 *
 * Everything runs on this device. The image never leaves the browser: there is
 * no fetch/XHR/WebSocket of image data anywhere in this file, and every asset
 * (worker script, WASM core, trained data) is served from OUR origin under
 * /assets/ocr/ — see scripts/ocr-assets.mjs. No CDN.
 *
 * The `tesseract.js` import is DYNAMIC and lives only inside initialize(), so
 * the engine and its WASM are absent from the Login and Inventory Center
 * entry chunks. Nothing here is imported at module scope by any screen; the
 * flow reaches it exclusively through createTesseractProvider() being called
 * after the operator explicitly chooses OCR.
 */

const ASSET_BASE = '/assets/ocr';

/** Tesseract reports 0–1 within a phase; we surface phases separately. */
interface TesseractLogMessage {
  status: string;
  progress: number;
}

type TesseractWorker = {
  recognize(image: Blob): Promise<{ data: TesseractPage }>;
  terminate(): Promise<unknown>;
};

interface TesseractBbox { x0: number; y0: number; x1: number; y1: number }
interface TesseractWord { text: string; confidence: number; bbox: TesseractBbox }
interface TesseractLine { text: string; confidence: number; bbox: TesseractBbox; words: TesseractWord[] }
interface TesseractParagraph { lines: TesseractLine[] }
interface TesseractBlock { paragraphs: TesseractParagraph[] }
interface TesseractPage { blocks: TesseractBlock[] | null; text: string }

/**
 * Map a Tesseract status string onto our phase vocabulary. Unknown statuses
 * degrade to 'preparing' rather than inventing a phase.
 */
function toPhase(status: string): 'loading-engine' | 'loading-language' | 'preparing' | 'recognizing' {
  if (status.includes('loading tesseract core') || status.includes('initializing tesseract')) return 'loading-engine';
  if (status.includes('loading language') || status.includes('initializing api')) return 'loading-language';
  if (status.includes('recognizing')) return 'recognizing';
  return 'preparing';
}

export class TesseractOcrProvider implements OcrProvider {
  readonly id = 'tesseract-local-v7';

  private worker: TesseractWorker | null = null;
  private language: OcrLanguage | null = null;
  private disposed = false;

  constructor(private readonly options: OcrProviderOptions = {}) {}

  async initialize(language: OcrLanguage): Promise<void> {
    if (this.disposed) throw new OcrUnavailableError('provider_disposed');

    // Fail fast and clearly when the platform cannot run the engine at all —
    // the caller falls back to manual entry rather than showing a dead spinner.
    if (typeof WebAssembly === 'undefined') {
      throw new OcrUnavailableError('no_webassembly');
    }

    // Re-initializing for a different language must not leak the old worker.
    if (this.worker && this.language !== language) {
      await this.dispose();
      this.disposed = false;
    }
    if (this.worker && this.language === language) return;

    let createWorker: typeof import('tesseract.js').createWorker;
    try {
      // Dynamic import — this is the code-splitting boundary that keeps the
      // engine out of every critical chunk.
      ({ createWorker } = await import('tesseract.js'));
    } catch (cause) {
      throw new OcrUnavailableError(`engine_import_failed:${String(cause)}`);
    }

    try {
      this.worker = (await createWorker(language, 1, {
        workerPath: `${ASSET_BASE}/worker.min.js`,
        corePath: `${ASSET_BASE}/`,
        langPath: ASSET_BASE,
        // Our vendored traineddata is uncompressed; without this Tesseract
        // would request a .gz that we deliberately do not serve.
        gzip: false,
        // Keep the worker a same-origin script rather than a blob: URL, so a
        // strict CSP without blob: worker-src still runs.
        workerBlobURL: false,
        logger: (message: TesseractLogMessage) => {
          this.options.onProgress?.({
            phase: toPhase(message.status ?? ''),
            ratio: typeof message.progress === 'number' ? message.progress : null,
          });
        },
      })) as unknown as TesseractWorker;
      this.language = language;
    } catch (cause) {
      // A half-built worker must never survive a failed initialize().
      await this.dispose();
      throw new OcrUnavailableError(`worker_init_failed:${String(cause)}`);
    }
  }

  async recognize(image: Blob, signal: AbortSignal): Promise<OcrDocumentResult> {
    if (!this.worker || !this.language) throw new OcrUnavailableError('not_initialized');
    if (signal.aborted) throw new OcrCancelledError();

    const startedAt = Date.now();

    // Tesseract.js offers no mid-recognition abort, so cancellation is honoured
    // by terminating the worker outright and rejecting. That is also the only
    // way to guarantee no thread survives a cancel — the alternative (ignoring
    // a late result) would leak the worker.
    let onAbort: (() => void) | null = null;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void this.dispose();
        reject(new OcrCancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const { data } = await Promise.race([this.worker.recognize(image), cancellation]);
      if (signal.aborted) throw new OcrCancelledError();

      const dimensions = await readImageDimensions(image);
      const lines = flattenLines(data);

      this.options.onProgress?.({ phase: 'done', ratio: 1 });

      return {
        text: data.text ?? '',
        lines,
        words: lines.flatMap(line => line.words),
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        language: this.language,
        durationMs: Date.now() - startedAt,
        providerId: this.id,
      };
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.language = null;
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      // A worker that is already gone is the desired end state; swallowing here
      // keeps dispose() safe to call from unmount, cancel and error paths alike.
    }
  }
}

/** Blocks → paragraphs → lines → words, preserving every bounding box. */
function flattenLines(page: TesseractPage): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words: OcrWord[] = (line.words ?? []).map(word => ({
          text: word.text,
          box: { ...word.bbox },
          confidence: word.confidence,
          language: null,
        }));
        out.push({
          text: line.text,
          box: { ...line.bbox },
          confidence: line.confidence,
          words,
        });
      }
    }
  }
  return out;
}

/**
 * Read intrinsic dimensions so the review overlay can scale boxes to the
 * rendered image. The object URL is revoked on every path — success, decode
 * failure, and unsupported-platform — so repeated scans cannot leak blobs.
 */
async function readImageDimensions(image: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(image);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(image);
  try {
    return await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
      element.onerror = () => reject(new OcrUnavailableError('image_decode_failed'));
      element.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The only way the app obtains a provider. Kept as a factory so the future
 * server-side Document-AI provider can be selected here without any caller
 * changing — no external API, secret or backend exists today.
 */
export function createTesseractProvider(options: OcrProviderOptions = {}): OcrProvider {
  return new TesseractOcrProvider(options);
}
