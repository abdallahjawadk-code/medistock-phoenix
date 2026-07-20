/**
 * PHARMA-OCR-A — the provider-neutral OCR contract.
 *
 * Nothing in this file imports an OCR engine. The Tesseract implementation, a
 * future server-side Document-AI provider, and the test doubles all satisfy
 * this same interface, so the pharmaceutical parsing, matching, confidence and
 * review layers above it never learn which engine produced a result.
 *
 * Bounding boxes are load-bearing, not decorative: the review workspace has to
 * highlight the exact image region a field came from, so no layer downstream is
 * permitted to drop them.
 */

export type OcrLanguage = 'ara' | 'eng' | 'ara+eng';

/** Pixel-space rectangle in the coordinate system of the image sent to recognize(). */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  box: OcrBox;
  /** Engine-reported confidence, 0–100. This is RAW evidence, never a field verdict. */
  confidence: number;
  /** Engine-detected script/language for this word when available. */
  language?: string | null;
}

export interface OcrLine {
  text: string;
  box: OcrBox;
  confidence: number;
  words: OcrWord[];
}

export interface OcrDocumentResult {
  /** Full recognized text, engine-ordered. */
  text: string;
  lines: OcrLine[];
  /** Flattened word list — the parser's primary input. */
  words: OcrWord[];
  /** Dimensions of the image that produced these boxes, for overlay scaling. */
  imageWidth: number;
  imageHeight: number;
  language: OcrLanguage;
  /** Wall-clock recognition time, for the performance gate. */
  durationMs: number;
  /** Provider identity, surfaced in the review UI so results are explainable. */
  providerId: string;
}

/** Progress phases a provider reports while working. */
export type OcrProgressPhase =
  | 'loading-engine'
  | 'loading-language'
  | 'preparing'
  | 'recognizing'
  | 'done';

export interface OcrProgress {
  phase: OcrProgressPhase;
  /** 0–1, or null when the phase is genuinely indeterminate. Never faked. */
  ratio: number | null;
}

export interface OcrProviderOptions {
  onProgress?: (progress: OcrProgress) => void;
}

/**
 * A recognition engine. Implementations MUST:
 *  - honour `signal` and stop work promptly on abort;
 *  - leave no worker/thread alive after dispose();
 *  - never transmit the image or its text off-device.
 */
export interface OcrProvider {
  readonly id: string;
  initialize(language: OcrLanguage): Promise<void>;
  recognize(image: Blob, signal: AbortSignal): Promise<OcrDocumentResult>;
  dispose(): Promise<void>;
}

/** Raised when the operator cancels; callers treat it as a non-error outcome. */
export class OcrCancelledError extends Error {
  constructor() {
    super('ocr_cancelled');
    this.name = 'OcrCancelledError';
  }
}

/**
 * Raised when the engine cannot start at all — no WebAssembly, asset 404, worker
 * blocked by CSP. The UI must fall back to manual entry rather than dead-end.
 */
export class OcrUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`ocr_unavailable:${reason}`);
    this.name = 'OcrUnavailableError';
  }
}
