/**
 * SMART-SCANNER — live camera capture with automatic code classification.
 *
 * Detects, WITHOUT ever creating a record or a movement from the code itself:
 *   • establishment QR  (public qid token / bare uuid / app URL with ?qid=)
 *       → routed to the establishment page by the caller;
 *   • movement/receipt QR (canonical movement payload)
 *       → routed to Movement History & Tracking by the caller;
 *   • medicine barcode / GS1 (EAN-13/EAN-8/Code128/DataMatrix)
 *       → handed to PhoenixMaterialResolver by the caller (GS1 AI(01) GTIN is
 *         unwrapped so the catalog barcode can match);
 *   • anything else → a safe "unknown code" message. Nothing is written.
 *
 * Uses the native BarcodeDetector when present; otherwise falls back to a
 * safe manual-entry field (no external scanning library — CSP forbids CDNs
 * and the repo policy forbids new network deps). The camera stream is always
 * stopped on close/unmount. Field-visibility rules stay the CALLER's:
 * warehouse surfaces search all four identity fields, the public outlet page
 * names only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { parseMovementQrPayload, type MovementDocumentKind } from '@/features/movement/movement-trace';

export type ScanClassification =
  | { kind: 'movement'; docKind: MovementDocumentKind; id: string }
  | { kind: 'establishment'; qid: string }
  | { kind: 'barcode'; value: string }
  | { kind: 'unknown'; raw: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure classifier — exported for behavioral tests. Never creates anything. */
export function classifyScanPayload(raw: string): ScanClassification {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'unknown', raw: text };

  const movement = parseMovementQrPayload(text);
  if (movement) return { kind: 'movement', docKind: movement.kind, id: movement.id };

  // Establishment QR: app URL carrying ?qid= (or legacy ?token=), or bare uuid.
  try {
    const url = new URL(text);
    const qid = url.searchParams.get('qid') ?? url.searchParams.get('token');
    if (qid) return { kind: 'establishment', qid };
  } catch { /* not a URL */ }
  if (UUID_RE.test(text)) return { kind: 'establishment', qid: text };

  // GS1: unwrap AI(01) GTIN-14 → the catalog's stored barcode digits.
  const gs1 = /^01(\d{14})/.exec(text.replace(/[()]/g, ''));
  if (gs1) return { kind: 'barcode', value: gs1[1].replace(/^0+/, '') };

  // Plain numeric barcode (EAN-8..GTIN-14).
  if (/^\d{8,14}$/.test(text)) return { kind: 'barcode', value: text };

  return { kind: 'unknown', raw: text };
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

/**
 * Decide what a single detector frame means, WITHOUT ever auto-selecting an
 * unsafe result. Pure and exported for tests:
 *   • more than one DISTINCT code  → 'ambiguous' (operator must isolate one);
 *   • exactly one code that classifies to 'unknown' → 'invalid';
 *   • exactly one recognised code  → 'hit' with its classification;
 *   • no code this frame           → 'none' (keep scanning).
 * Only a 'hit' is ever handed to the caller.
 */
export type FrameOutcome =
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'invalid'; raw: string }
  | { status: 'hit'; result: ScanClassification };

export function evaluateDetectedCodes(codes: Array<{ rawValue: string }>): FrameOutcome {
  const distinct = Array.from(new Set((codes ?? []).map(c => c?.rawValue).filter(Boolean)));
  if (distinct.length > 1) return { status: 'ambiguous' };
  const raw = distinct[0];
  if (!raw) return { status: 'none' };
  const result = classifyScanPayload(raw);
  if (result.kind === 'unknown') return { status: 'invalid', raw };
  return { status: 'hit', result };
}

function createDetector(): DetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: new (opts: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'data_matrix'] });
  } catch {
    return null;
  }
}

/**
 * Every distinct state the scanner can be in. Camera auto-detection NEVER
 * auto-selects on 'invalid' (a code that classifies as unknown) or 'ambiguous'
 * (more than one distinct code in a frame) — the operator must act. Manual
 * paste remains available in every non-scanning state.
 */
export type ScanPhase =
  | 'loading'      // acquiring the camera
  | 'scanning'     // live detection running
  | 'unsupported'  // no BarcodeDetector / getUserMedia on this device
  | 'denied'       // camera permission refused
  | 'offline'      // navigator reports no connectivity
  | 'invalid'      // a code was read but did not classify to anything actionable
  | 'ambiguous';   // multiple distinct codes in one frame — never auto-select

const TICK_MS = 220;

interface Props {
  lang: 'ar' | 'en';
  onScan: (result: ScanClassification) => void;
  onClose: () => void;
}

export function SmartScanner({ lang, onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);
  const detectorRef = useRef<DetectorLike | null>(null);
  const [phase, setPhase] = useState<ScanPhase>('loading');
  const [manual, setManual] = useState('');

  const stopCamera = useCallback(() => {
    stopRef.current = true;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    stopRef.current = false;
    const detector = detectorRef.current ?? (detectorRef.current = createDetector());

    // Capability + connectivity gates — each is its own honest state.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setPhase('offline'); return; }
    if (!detector || !navigator.mediaDevices?.getUserMedia) { setPhase('unsupported'); return; }

    setPhase('loading');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      setPhase('denied');
      return;
    }
    if (stopRef.current) { stream.getTracks().forEach(x => x.stop()); return; }
    streamRef.current = stream;

    const video = videoRef.current;
    if (!video) { stream.getTracks().forEach(x => x.stop()); return; }
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay can reject; detection still runs */ }
    setPhase('scanning');

    const tick = async () => {
      if (stopRef.current) return;
      try {
        const outcome = evaluateDetectedCodes(await detector.detect(video));
        if (outcome.status === 'ambiguous') { stopCamera(); setPhase('ambiguous'); return; }
        if (outcome.status === 'invalid')   { stopCamera(); setPhase('invalid'); return; }
        if (outcome.status === 'hit')       { stopCamera(); onScan(outcome.result); return; }
        // 'none' — keep scanning.
      } catch { /* one bad frame never kills the loop */ }
      setTimeout(() => { void tick(); }, TICK_MS);
    };
    void tick();
  }, [onScan, stopCamera]);

  useEffect(() => {
    void start();
    return () => { stopCamera(); };
  }, [start, stopCamera]);

  const retry = useCallback(() => { stopCamera(); setManual(''); void start(); }, [start, stopCamera]);

  const submitManual = () => {
    const value = manual.trim();
    if (!value) return;
    // Manual entry is an explicit operator action; the caller still decides how
    // to treat an unknown payload, but a recognised one routes immediately.
    onScan(classifyScanPayload(value));
  };

  const showManual = phase !== 'scanning' && phase !== 'loading';
  const showRetry = phase === 'denied' || phase === 'offline' || phase === 'invalid' || phase === 'ambiguous';

  const noteFor: Partial<Record<ScanPhase, { key: string; tone: string }>> = {
    loading:     { key: 'scan_starting',      tone: 'var(--t2)' },
    scanning:    { key: 'scan_scanning_hint', tone: 'var(--t2)' },
    unsupported: { key: 'scan_unsupported',   tone: 'var(--warn)' },
    denied:      { key: 'scan_camera_denied', tone: 'var(--warn)' },
    offline:     { key: 'scan_offline',       tone: 'var(--warn)' },
    invalid:     { key: 'scan_invalid_code',  tone: 'var(--warn)' },
    ambiguous:   { key: 'scan_ambiguous',     tone: 'var(--warn)' },
  };
  const note = noteFor[phase];

  return (
    <div data-testid="smart-scanner" data-scan-phase={phase} style={{ display: 'grid', gap: '10px' }}>
      {(phase === 'loading' || phase === 'scanning') && (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', maxHeight: '300px', borderRadius: 'var(--r3)', background: '#000', objectFit: 'cover' }}
        />
      )}

      {note && (
        <p role="status" style={{ fontSize: '12px', color: note.tone }} dir="auto">{t(note.key, lang)}</p>
      )}

      {showManual && (
        <div style={{ display: 'grid', gap: '8px' }}>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)' }} dir="auto">{t('scan_fallback_hint', lang)}</p>
          <input
            type="text"
            dir="ltr"
            value={manual}
            onChange={e => setManual(e.target.value)}
            placeholder={t('scan_fallback_placeholder', lang)}
            aria-label={t('scan_fallback_placeholder', lang)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }}
          />
          <PhoenixButton size="sm" disabled={!manual.trim()} onClick={submitManual}>
            {t('scan_fallback_submit', lang)}
          </PhoenixButton>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        {showRetry && (
          <PhoenixButton variant="secondary" size="sm" onClick={retry}>
            {t('scan_retry', lang)}
          </PhoenixButton>
        )}
        <PhoenixButton variant="ghost" size="sm" onClick={() => { stopCamera(); onClose(); }}>
          {t('scan_close', lang)}
        </PhoenixButton>
      </div>
    </div>
  );
}
