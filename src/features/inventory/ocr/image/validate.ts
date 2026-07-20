/**
 * PHARMA-OCR-A — input validation for document images.
 *
 * The file extension and the browser-reported MIME type are both attacker- and
 * accident-controlled, so neither is trusted. Acceptance is decided by sniffing
 * the actual magic bytes, then by real decoded dimensions.
 *
 * SVG is refused outright and deliberately: it is a scriptable document, not a
 * raster image, and rendering untrusted SVG in the page is an XSS surface. PDF
 * and handwriting are refused because this pipeline genuinely does not support
 * them — claiming otherwise would invite operators to trust a result we cannot
 * produce.
 */

export type AcceptedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export const ACCEPTED_IMAGE_TYPES: readonly AcceptedImageType[] = ['image/jpeg', 'image/png', 'image/webp'];

/** The `accept` attribute for file inputs. Never the sole gate — see validateImageFile. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',');

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Below this, text strokes are too few pixels for the engine to resolve reliably. */
export const MIN_DIMENSION_PX = 400;
/** Guards against decode-bomb images; also far beyond any useful document scan. */
export const MAX_DIMENSION_PX = 12000;
export const MAX_TOTAL_PIXELS = 40_000_000;

export type ImageRejectionReason =
  | 'empty_file'
  | 'file_too_large'
  | 'unsupported_type'
  | 'svg_rejected'
  | 'pdf_rejected'
  | 'signature_mismatch'
  | 'decode_failed'
  | 'too_small'
  | 'too_large_dimensions'
  | 'too_many_pixels';

export interface ImageValidationSuccess {
  ok: true;
  type: AcceptedImageType;
  width: number;
  height: number;
  bytes: number;
}

export interface ImageValidationFailure {
  ok: false;
  reason: ImageRejectionReason;
  /** Populated when known, so the message can name the actual value. */
  detail?: string;
}

export type ImageValidationResult = ImageValidationSuccess | ImageValidationFailure;

/**
 * Identify a raster type from magic bytes alone.
 * Returns null for anything not in the accepted set, including SVG and PDF,
 * which are reported separately by validateImageFile so the operator gets an
 * accurate reason rather than a generic refusal.
 */
export function sniffImageType(header: Uint8Array): AcceptedImageType | 'svg' | 'pdf' | null {
  // JPEG: FF D8 FF
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (header.length >= 8 && png.every((byte, index) => header[index] === byte)) {
    return 'image/png';
  }
  // WebP: 'RIFF' .... 'WEBP'
  if (header.length >= 12) {
    const riff = String.fromCharCode(...header.slice(0, 4));
    const webp = String.fromCharCode(...header.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  // PDF: '%PDF-'
  if (header.length >= 5 && String.fromCharCode(...header.slice(0, 5)) === '%PDF-') {
    return 'pdf';
  }
  // SVG: XML prolog or a root <svg, possibly after leading whitespace/BOM.
  const asText = String.fromCharCode(...header.slice(0, Math.min(header.length, 256)))
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  if (asText.startsWith('<svg') || (asText.startsWith('<?xml') && asText.includes('<svg'))) {
    return 'svg';
  }
  return null;
}

/** Decode just enough to learn real dimensions, always releasing the object URL. */
export async function readDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }
  } catch {
    return null;
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number } | null>(resolve => {
      const element = new Image();
      element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
      element.onerror = () => resolve(null);
      element.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Full acceptance decision for one candidate document image.
 * Order matters: cheap byte checks precede any decode, so an oversized or
 * hostile file is refused before it is handed to the platform decoder.
 */
export async function validateImageFile(file: Blob): Promise<ImageValidationResult> {
  if (file.size === 0) return { ok: false, reason: 'empty_file' };
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'file_too_large', detail: `${(file.size / 1024 / 1024).toFixed(1)} MB` };
  }

  const header = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const sniffed = sniffImageType(header);

  if (sniffed === 'svg') return { ok: false, reason: 'svg_rejected' };
  if (sniffed === 'pdf') return { ok: false, reason: 'pdf_rejected' };
  if (sniffed === null) return { ok: false, reason: 'unsupported_type' };

  // A declared type that disagrees with the bytes is reported as a mismatch
  // rather than silently accepted on the strength of the signature.
  const declared = file.type?.toLowerCase();
  if (declared && ACCEPTED_IMAGE_TYPES.includes(declared as AcceptedImageType) && declared !== sniffed) {
    return { ok: false, reason: 'signature_mismatch', detail: `declared ${declared}, actual ${sniffed}` };
  }

  const dimensions = await readDimensions(file);
  if (!dimensions) return { ok: false, reason: 'decode_failed' };

  const { width, height } = dimensions;
  if (width < MIN_DIMENSION_PX || height < MIN_DIMENSION_PX) {
    return { ok: false, reason: 'too_small', detail: `${width}×${height}` };
  }
  if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
    return { ok: false, reason: 'too_large_dimensions', detail: `${width}×${height}` };
  }
  if (width * height > MAX_TOTAL_PIXELS) {
    return { ok: false, reason: 'too_many_pixels', detail: `${width}×${height}` };
  }

  return { ok: true, type: sniffed, width, height, bytes: file.size };
}

/** i18n key for a rejection reason. */
export function rejectionMessageKey(reason: ImageRejectionReason): string {
  return `ocr_reject_${reason}`;
}
