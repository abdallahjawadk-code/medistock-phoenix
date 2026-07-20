/**
 * PHARMA-OCR-A — safety, lifecycle and performance invariants.
 * Run: npm test -- --run
 *
 * The behavioural domain logic is covered by pharma-parsing and
 * matching-and-confidence. THIS file pins the properties that are structural:
 * what the code is allowed to import, call, and leave running. They are source
 * scans because that is the only way to prove a negative ("no RPC before
 * confirmation", "no image upload") across a whole module.
 *
 * Source is newline-normalized so a CRLF working copy matches CI's LF checkout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { validateImageFile, sniffImageType, ACCEPTED_IMAGE_TYPES, MIN_DIMENSION_PX } from '../image/validate';
import { assessQuality, laplacianVariance, toGrayscaleSample, blownHighlightRatio, estimateSkewDegrees } from '../image/quality';
import { preprocess, toGrayscale, normalizeContrast, DEFAULT_PREPROCESS, type RgbaImage } from '../image/preprocess';

const SRC = join(process.cwd(), 'src');
const OCR_DIR = join(SRC, 'features', 'inventory', 'ocr');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const readOcr = (rel: string) => read(join(OCR_DIR, rel));

/** Strip comments so "does not call X" scans see executable code only. */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const ALL_OCR_FILES = walk(OCR_DIR).filter(f => /\.tsx?$/.test(f) && !f.includes('__tests__'));

const flow = readOcr('OcrIntakeFlow.tsx');
const provider = readOcr('tesseract-provider.ts');
const workspace = readOcr('OcrReviewWorkspace.tsx');
const inventoryScreen = read(join(SRC, 'features', 'inventory', 'InventoryCenterScreen.tsx'));

// ─── The central safety property ─────────────────────────────────────────────

describe('OCR never writes stock on its own', () => {
  it('exactly one intake RPC call exists in the whole OCR module', () => {
    const calls = ALL_OCR_FILES.flatMap(file =>
      [...codeOnly(read(file)).matchAll(/receiveWarehouseStock\s*\(/g)].map(() => file),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('OcrIntakeFlow');
  });

  it('that call lives in confirmAndSubmit and is guarded by canSubmit', () => {
    const submit = flow.slice(flow.indexOf('const confirmAndSubmit'), flow.indexOf('// ── Render'));
    expect(submit).toContain('if (!canSubmit) return;');
    expect(submit).toContain('await receiveWarehouseStock(payload)');
    // The guard must precede the call, not follow it.
    expect(submit.indexOf('if (!canSubmit) return;')).toBeLessThan(submit.indexOf('receiveWarehouseStock(payload)'));
  });

  it('canSubmit requires the preview stage, no blocking warning, and every confirmation', () => {
    // Warehouse is confirmed separately at the preview — see the
    // critical-field suite below — so it is part of the submit gate too.
    expect(flow).toContain("const canSubmit = stage === 'preview' && canReachPreview && canSubmitIntake && warehouseConfirmed;");
    expect(flow).toContain('const canReachPreview = !hasBlockingWarning && outstandingConfirmations.length === 0 && quantityValid;');
  });

  it('OCR uses the SAME intake service as manual entry — no OCR-specific write path', () => {
    expect(flow).toContain("from '../warehouse-intake.service'");
    expect(codeOnly(flow)).not.toContain('supabase.rpc');
    expect(codeOnly(flow)).not.toContain('phoenix_');
  });

  it('no OCR file calls supabase directly at all', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      expect(source, file).not.toContain('supabase.rpc(');
      expect(source, file).not.toMatch(/\.from\(['"][a-z_]+['"]\)/);
      expect(source, file).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    }
  });

  it('OCR never selects an availability condition', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      expect(source, file).not.toContain("'low_stock'");
      expect(source, file).not.toContain("'surplus'");
      expect(source, file).not.toContain('AvailabilityCondition');
    }
  });

  it('OCR never chooses the warehouse — it receives an already-authorized one', () => {
    expect(flow).toContain('warehouseId, catalog, existingBatches, canSubmitIntake');
    // No warehouse picker, and no scope RPC, anywhere in the flow.
    expect(codeOnly(flow)).not.toContain('setWarehouseId');
    expect(codeOnly(flow)).not.toContain('assign_profile_scope');
  });

  it('the operator permission gate is passed through, not recomputed or bypassed', () => {
    expect(flow).toContain('canSubmitIntake');
    expect(inventoryScreen).toContain('canSubmitIntake={canSubmit}');
  });

  it('entry method is recorded via the existing notes contract — no schema field', () => {
    expect(flow).toContain("notes: [values.notes,");
    expect(flow).toContain('ocr_entry_method_note');
    // No RPC parameter and no payload key for an entry-method column — the
    // marker rides inside the existing free-text `notes` value. (The i18n key
    // `ocr_entry_method_note` naming the note is not itself a schema field.)
    expect(codeOnly(flow)).not.toContain('p_entry_method');
    expect(codeOnly(flow)).not.toMatch(/\bentry_method\s*:/);
    expect(codeOnly(flow)).not.toMatch(/\bentryMethod\s*:/);
  });
});

// ─── Beta labelling and critical-field confirmation ──────────────────────────

describe('OCR is labelled a Beta requiring human review', () => {
  const strings = read(join(SRC, 'shared', 'i18n', 'strings.ts'));

  it('carries the exact mandated Arabic and English banner text', () => {
    expect(strings).toContain('مساعد OCR تجريبي — يتطلب مراجعة بشرية');
    expect(strings).toContain('OCR Assistant Beta — Human review required');
  });

  it('renders the banner OUTSIDE the stage switch, so no stage can hide it', () => {
    expect(flow).toContain("data-testid=\"ocr-beta-banner\"");
    expect(flow).toContain("t('ocr_beta_banner', lang)");
    // The banner sits before the first stage-conditional block.
    expect(flow.indexOf('ocr-beta-banner')).toBeLessThan(flow.indexOf("{stage === 'capture' &&"));
  });

  it('the entry point and heading both say Beta', () => {
    expect(strings).toContain("ocr_open:               { ar: 'قراءة مستند بالكاميرا (تجريبي)'");
    expect(strings).toMatch(/ocr_title:.*OCR Assistant Beta/);
  });

  it('never advertises OCR as accurate, automatic, professional or production-ready', () => {
    const ocrStrings = strings.slice(strings.indexOf('ocr_beta_banner'), strings.indexOf('ocr_reject_empty_file'));
    for (const banned of ['production-ready', 'production ready', 'fully automatic', 'highly accurate', 'professional-grade']) {
      expect(ocrStrings.toLowerCase(), `banned marketing claim: ${banned}`).not.toContain(banned);
    }
  });
});

describe('Every critical field starts unconfirmed', () => {
  it('the required-confirmation set covers the mandated critical fields', () => {
    const confidence = readOcr('confidence.ts');
    for (const field of ['scientificName', 'nationalCode', 'batchNumber', 'expiryDate', 'quantity', 'unitPrice']) {
      expect(confidence, `missing required confirmation: ${field}`).toContain(`'${field}'`);
    }
  });

  it('warehouse gets its own explicit confirmation at the final preview', () => {
    expect(flow).toContain('const [warehouseConfirmed, setWarehouseConfirmed] = useState(false);');
    expect(flow).toContain('&& warehouseConfirmed;');
    expect(flow).toContain("t('ocr_confirm_warehouse', lang)");
  });

  it('returning to review clears the warehouse confirmation', () => {
    expect(flow).toContain('onClick={() => { setWarehouseConfirmed(false); setStage(\'review\'); }}');
  });

  it('no confirmation is ever pre-ticked, including after a unique catalog match', () => {
    expect(flow).toContain('setConfirmed({});');
    expect(flow).toContain('confirmed: false,');
    expect(flow).not.toMatch(/confirmed:\s*true/);
    expect(flow).not.toMatch(/useState\(true\)[^\n]*[Cc]onfirm/);
  });

  it('an ambiguous or no-match material is a BLOCKING warning, never pre-accepted', () => {
    expect(flow).toContain("severity: 'blocking', message: t('ocr_warn_no_match', lang)");
    expect(flow).toContain("severity: 'blocking', message: t('ocr_warn_ambiguous_match', lang)");
    expect(flow).toContain('const hasBlockingWarning = warnings.some');
  });

  it('a duplicate or conflicting batch identity blocks automatic acceptance', () => {
    expect(flow).toContain("severity: 'blocking',");
    expect(flow).toContain('assessBatchIdentity(');
    const duplicate = readOcr('match/duplicate-identity.ts');
    expect(duplicate).toContain('blocksAutomaticAccept: findings.length > 0');
  });
});

// ─── No image ever leaves the device ─────────────────────────────────────────

describe('The document never leaves the browser', () => {
  it('no OCR file performs any network call', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toContain('XMLHttpRequest');
      expect(source, file).not.toContain('WebSocket');
      expect(source, file).not.toContain('navigator.sendBeacon');
      expect(source, file).not.toContain('FormData');
    }
  });

  it('every engine asset is same-origin — no CDN host appears anywhere', () => {
    for (const file of ALL_OCR_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/https?:\/\/(?!localhost)/);
      expect(source, file).not.toContain('unpkg');
      expect(source, file).not.toContain('jsdelivr');
      expect(source, file).not.toContain('cdn.');
    }
    expect(provider).toContain("const ASSET_BASE = '/assets/ocr'");
  });

  it('the worker is a same-origin script, not a blob URL, so a strict CSP still runs it', () => {
    expect(provider).toContain('workerBlobURL: false');
  });

  it('document text is never logged to console or analytics', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      expect(source, file).not.toMatch(/console\.(log|info|debug|warn|error)/);
      expect(source, file).not.toContain('analytics');
      expect(source, file).not.toContain('gtag');
    }
  });

  it('no OCR file persists an image to storage', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      expect(source, file).not.toContain('localStorage');
      expect(source, file).not.toContain('sessionStorage');
      expect(source, file).not.toContain('indexedDB');
    }
  });
});

// ─── Lazy loading and lifecycle ──────────────────────────────────────────────

describe('Lazy loading keeps OCR out of the critical bundle', () => {
  it('the engine is imported dynamically, inside initialize()', () => {
    expect(provider).toContain("await import('tesseract.js')");
    // No static import of the engine anywhere.
    for (const file of ALL_OCR_FILES) {
      expect(read(file), file).not.toMatch(/^import .*from 'tesseract\.js'/m);
    }
  });

  it('the OCR flow itself is lazily imported by the Inventory Center', () => {
    expect(inventoryScreen).toContain('lazy(() =>');
    expect(inventoryScreen).toContain("import('./ocr/OcrIntakeFlow')");
    expect(inventoryScreen).not.toMatch(/^import .*OcrIntakeFlow.*from/m);
  });

  it('the provider module is only reached through a dynamic import', () => {
    expect(flow).toContain("await import('./tesseract-provider')");
    expect(flow).not.toMatch(/^import .*tesseract-provider/m);
  });

  it('recognition runs off the main thread via a worker', () => {
    expect(provider).toContain('workerPath');
    expect(provider).toContain('worker.terminate()');
  });
});

describe('Worker and memory lifecycle', () => {
  it('dispose() clears the handle before terminating, so it is re-entrant', () => {
    const dispose = provider.slice(provider.indexOf('async dispose()'), provider.indexOf('/** Blocks → paragraphs'));
    expect(dispose).toContain('this.worker = null;');
    expect(dispose.indexOf('this.worker = null;')).toBeLessThan(dispose.indexOf('worker.terminate()'));
  });

  it('cancellation terminates the worker rather than orphaning it', () => {
    expect(provider).toContain('void this.dispose();');
    expect(provider).toContain('reject(new OcrCancelledError());');
  });

  it('a failed initialize() does not leave a half-built worker alive', () => {
    const initialize = provider.slice(provider.indexOf('async initialize('), provider.indexOf('async recognize('));
    expect(initialize).toContain('await this.dispose();');
    expect(initialize).toContain('worker_init_failed');
  });

  it('the flow disposes the provider on every recognition outcome via finally', () => {
    const recognition = flow.slice(flow.indexOf('const startRecognition'), flow.indexOf('// ── Stage 4'));
    expect(recognition).toContain('} finally {');
    expect(recognition).toContain('await teardownProvider();');
  });

  it('unmount tears down the worker and revokes the object URL', () => {
    expect(flow).toContain('useEffect(() => () => {');
    expect(flow).toContain('void teardownProvider();');
    expect(flow).toContain('if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);');
  });

  it('every createObjectURL in the OCR module has a matching revokeObjectURL', () => {
    for (const file of ALL_OCR_FILES) {
      const source = codeOnly(read(file));
      const created = (source.match(/URL\.createObjectURL/g) ?? []).length;
      const revoked = (source.match(/URL\.revokeObjectURL/g) ?? []).length;
      expect(revoked, `${file}: ${created} created vs ${revoked} revoked`).toBeGreaterThanOrEqual(created);
    }
  });

  it('replacing an image releases the previous one before allocating the next', () => {
    const onFile = flow.slice(flow.indexOf('const onFileSelected'), flow.indexOf('// ── Stage 2'));
    expect(onFile).toContain('releaseImage();');
    expect(onFile.indexOf('releaseImage();')).toBeLessThan(onFile.indexOf('URL.createObjectURL(file)'));
  });

  it('a successful submit releases the image rather than holding it', () => {
    expect(flow).toContain('releaseImage();\n      setRequestId(newRequestId());');
  });

  it('the intake request id is reused across a failed submit so a retry cannot double-post', () => {
    const submit = flow.slice(flow.indexOf('const confirmAndSubmit'), flow.indexOf('// ── Render'));
    // A new id is minted ONLY on the success path.
    const successBranch = submit.slice(submit.indexOf('if (result.ok)'), submit.indexOf('} else {'));
    const failureBranch = submit.slice(submit.indexOf('} else {'));
    expect(successBranch).toContain('setRequestId(newRequestId())');
    expect(failureBranch).not.toContain('setRequestId(newRequestId())');
  });
});

// ─── Failure behaviour ───────────────────────────────────────────────────────

describe('Failure keeps the operator working', () => {
  it('an unavailable engine routes to manual entry rather than a dead end', () => {
    expect(flow).toContain('OcrUnavailableError');
    expect(flow).toContain("setErrorKey('ocr_err_unavailable')");
    expect(flow).toContain('ocr_use_manual_entry');
  });

  it('missing WebAssembly is detected up front', () => {
    expect(provider).toContain("typeof WebAssembly === 'undefined'");
    expect(provider).toContain('no_webassembly');
  });

  it('cancel and failure both return to the quality stage, preserving the image', () => {
    const recognition = flow.slice(flow.indexOf('const startRecognition'), flow.indexOf('// ── Stage 4'));
    // Neither path calls releaseImage — corrections and preview survive.
    expect(recognition).not.toContain('releaseImage()');
    expect(recognition).toContain("setStage('quality')");
  });

  it('a failed submit returns to preview with corrections intact', () => {
    const submit = flow.slice(flow.indexOf('const confirmAndSubmit'), flow.indexOf('// ── Render'));
    const failureBranch = submit.slice(submit.indexOf('} else {'));
    expect(failureBranch).toContain("setStage('preview')");
    expect(failureBranch).not.toContain('setValues({})');
  });
});

// ─── Review UI requirements ──────────────────────────────────────────────────

describe('Review workspace', () => {
  it('links image regions and fields in both directions', () => {
    expect(workspace).toContain('onClick={() => focusField(overlay.field)}');
    expect(workspace).toContain('onFocus={() => setActiveField(field.field)}');
  });

  it('keeps the original OCR reading visible beside the edited value', () => {
    expect(workspace).toContain('ocr_original_reading');
    expect(workspace).toContain('field.originalOcrValue');
  });

  it('groups warnings separately from ordinary fields', () => {
    expect(workspace).toContain("warnings.filter(w => w.severity === 'blocking')");
    expect(workspace).toContain("warnings.filter(w => w.severity === 'advisory')");
  });

  it('honours 44px touch targets on every interactive control', () => {
    expect(workspace).toContain("minWidth: '44px'");
    expect(workspace).toContain("minHeight: '44px'");
  });

  it('respects document direction for RTL/LTR', () => {
    expect(workspace).toContain('dir={dir}');
    expect(workspace).toContain('paddingInlineStart');
  });

  it('editing a value clears its prior confirmation', () => {
    const onChange = flow.slice(flow.indexOf('const onChangeField'), flow.indexOf('const onToggleConfirm'));
    expect(onChange).toContain('[field]: false');
  });

  it('a unique catalog match fills identity fields but never pre-confirms them', () => {
    expect(flow).toContain('setConfirmed({});');
    expect(flow).toContain('confirmed: false,');
  });
});

// ─── Input validation (behavioural) ──────────────────────────────────────────

const bytesToBlob = (bytes: number[], type = ''): Blob => new Blob([new Uint8Array(bytes)], { type });

describe('Image input validation', () => {
  it('identifies JPEG, PNG and WebP from magic bytes', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    const webp = new Uint8Array(12);
    webp.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
    webp.set([...'WEBP'].map(c => c.charCodeAt(0)), 8);
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('detects SVG and PDF so they can be refused with an accurate reason', () => {
    const svg = new Uint8Array([...'<svg xmlns="http://www.w3.org/2000/svg">'].map(c => c.charCodeAt(0)));
    expect(sniffImageType(svg)).toBe('svg');
    const pdf = new Uint8Array([...'%PDF-1.7'].map(c => c.charCodeAt(0)));
    expect(sniffImageType(pdf)).toBe('pdf');
  });

  it('refuses an SVG even when it is disguised with an image MIME type', async () => {
    const svgBytes = [...'<svg xmlns="x"></svg>'].map(c => c.charCodeAt(0));
    const result = await validateImageFile(bytesToBlob(svgBytes, 'image/png'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('svg_rejected');
  });

  it('refuses a PDF regardless of declared type', async () => {
    const pdfBytes = [...'%PDF-1.7 rest'].map(c => c.charCodeAt(0));
    const result = await validateImageFile(bytesToBlob(pdfBytes, 'image/jpeg'));
    expect(result.ok === false && result.reason).toBe('pdf_rejected');
  });

  it('refuses an empty file and an unknown signature', async () => {
    expect((await validateImageFile(bytesToBlob([]))).ok).toBe(false);
    const junk = await validateImageFile(bytesToBlob([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(junk.ok === false && junk.reason).toBe('unsupported_type');
  });

  it('accepts exactly three raster types and nothing else', () => {
    expect([...ACCEPTED_IMAGE_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('enforces a minimum dimension so unreadable thumbnails are refused', () => {
    expect(MIN_DIMENSION_PX).toBeGreaterThanOrEqual(300);
  });
});

// ─── Quality metrics (behavioural) ───────────────────────────────────────────

/** Build a synthetic RGBA buffer via a per-pixel luma function. */
function makeImage(width: number, height: number, luma: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = luma(x, y);
      const index = (y * width + x) * 4;
      data[index] = value; data[index + 1] = value; data[index + 2] = value; data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('Quality metrics measure real pixel statistics', () => {
  it('a sharp striped pattern scores far higher than a flat one', () => {
    const sharp = makeImage(200, 200, x => (x % 4 < 2 ? 0 : 255));
    const flat = makeImage(200, 200, () => 128);
    const sharpScore = laplacianVariance(toGrayscaleSample(sharp.data, 200, 200));
    const flatScore = laplacianVariance(toGrayscaleSample(flat.data, 200, 200));
    expect(sharpScore).toBeGreaterThan(flatScore);
    expect(flatScore).toBeLessThan(1);
  });

  it('detects blown highlights', () => {
    const blown = makeImage(100, 100, (x, y) => (y < 60 ? 255 : 20));
    expect(blownHighlightRatio(toGrayscaleSample(blown.data, 100, 100))).toBeGreaterThan(0.5);
  });

  it('flags a dark image as poor and a clean one as good', () => {
    const dark = makeImage(1000, 1000, (x) => (x % 4 < 2 ? 0 : 40));
    expect(assessQuality(dark.data, 1000, 1000).findings.some(f => f.issue === 'too_dark')).toBe(true);
    expect(assessQuality(dark.data, 1000, 1000).verdict).toBe('poor');
  });

  it('flags a low-resolution capture', () => {
    const small = makeImage(500, 500, x => (x % 4 < 2 ? 0 : 255));
    expect(assessQuality(small.data, 500, 500).findings.some(f => f.issue === 'low_resolution')).toBe(true);
  });

  it('every finding reports the measured value alongside its threshold', () => {
    const dark = makeImage(600, 600, () => 10);
    for (const finding of assessQuality(dark.data, 600, 600).findings) {
      expect(typeof finding.measured).toBe('number');
      expect(typeof finding.threshold).toBe('number');
    }
  });

  it('returns null skew rather than a fabricated zero when nothing is measurable', () => {
    const flat = makeImage(100, 100, () => 128);
    expect(estimateSkewDegrees(toGrayscaleSample(flat.data, 100, 100))).toBeNull();
  });
});

describe('Preprocessing is non-destructive', () => {
  it('never mutates the input buffer', () => {
    const original = makeImage(40, 40, (x, y) => (x + y) % 256);
    const snapshot = new Uint8ClampedArray(original.data);
    preprocess(original, DEFAULT_PREPROCESS);
    expect(Array.from(original.data)).toEqual(Array.from(snapshot));
  });

  it('each step returns a new buffer', () => {
    const original = makeImage(20, 20, () => 100);
    expect(toGrayscale(original).data).not.toBe(original.data);
    expect(normalizeContrast(original).data).not.toBe(original.data);
  });

  it('contrast normalization expands a compressed range', () => {
    const flatish = makeImage(60, 60, (x) => 120 + (x % 8));
    const normalized = normalizeContrast(toGrayscale(flatish));
    const values = [];
    for (let i = 0; i < normalized.data.length; i += 4) values.push(normalized.data[i]);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(100);
  });

  it('adaptive thresholding is OFF by default because it harms uneven phone captures', () => {
    expect(DEFAULT_PREPROCESS.adaptiveThreshold).toBe(false);
  });

  it('deskew is off unless an angle was actually measured', () => {
    expect(DEFAULT_PREPROCESS.deskewDegrees).toBeNull();
  });
});
