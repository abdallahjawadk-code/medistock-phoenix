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

function createDetector(): DetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: new (opts: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'data_matrix'] });
  } catch {
    return null;
  }
}

interface Props {
  lang: 'ar' | 'en';
  onScan: (result: ScanClassification) => void;
  onClose: () => void;
}

export function SmartScanner({ lang, onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);
  const [phase, setPhase] = useState<'starting' | 'scanning' | 'fallback' | 'denied'>('starting');
  const [manual, setManual] = useState('');

  const stopCamera = useCallback(() => {
    stopRef.current = true;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    const detector = createDetector();
    let cancelled = false;

    async function start() {
      if (!detector || !navigator.mediaDevices?.getUserMedia) {
        setPhase('fallback');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(x => x.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setPhase('scanning');

        const tick = async () => {
          if (stopRef.current || cancelled) return;
          try {
            const codes = await detector.detect(video);
            const raw = codes[0]?.rawValue;
            if (raw) {
              stopCamera();
              onScan(classifyScanPayload(raw));
              return;
            }
          } catch { /* one bad frame never kills the loop */ }
          setTimeout(tick, 220);
        };
        void tick();
      } catch {
        setPhase('denied');
      }
    }
    void start();
    return () => { cancelled = true; stopCamera(); };
  }, [onScan, stopCamera]);

  return (
    <div data-testid="smart-scanner" style={{ display: 'grid', gap: '10px' }}>
      {(phase === 'starting' || phase === 'scanning') && (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', maxHeight: '300px', borderRadius: 'var(--r3)', background: '#000', objectFit: 'cover' }}
        />
      )}

      {phase === 'denied' && (
        <p style={{ fontSize: '12px', color: 'var(--warn)' }} dir="auto">{t('scan_camera_denied', lang)}</p>
      )}

      {(phase === 'fallback' || phase === 'denied') && (
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
          <PhoenixButton size="sm" disabled={!manual.trim()} onClick={() => onScan(classifyScanPayload(manual))}>
            {t('scan_fallback_submit', lang)}
          </PhoenixButton>
        </div>
      )}

      <PhoenixButton variant="ghost" size="sm" onClick={() => { stopCamera(); onClose(); }}>
        {t('scan_close', lang)}
      </PhoenixButton>
    </div>
  );
}
