/**
 * CN-2B — the PROVISIONAL browser preview.
 *
 * Runs the frozen CN-2A parser core inside a Web Worker, off the main thread.
 * Whatever it produces is provisional and is labelled as such everywhere it is
 * shown: it becomes authoritative only when the Node 22 replay reproduces it
 * field for field and the database recomputes an agreeing digest.
 *
 * The host owns the timeout, exactly as `worker.ts` documents: a Worker cannot
 * reliably interrupt its own synchronous loop, so termination lives here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveParseResult, FileParseResult } from './import/contract.ts';

export type PreviewKind = 'file' | 'archive';

export interface PreviewOutcome {
  kind: PreviewKind;
  result: FileParseResult | ArchiveParseResult;
  /** Exact JSON handed to staging — byte-identical to what Node will compare against. */
  json: string;
}

export type PreviewState =
  | { phase: 'idle' }
  | { phase: 'parsing'; filename: string }
  | { phase: 'ready'; filename: string; outcome: PreviewOutcome }
  | { phase: 'failed'; filename: string; reason: string };

/** ZIP archives are the multi-workbook container; everything else is a single workbook. */
export function detectContainerKind(file: File): PreviewKind {
  return /\.zip$/i.test(file.name) ? 'archive' : 'file';
}

const PREVIEW_TIMEOUT_MS = 30_000;

export function useCentralNeedsPreview() {
  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, []);

  useEffect(() => teardown, [teardown]);

  const reset = useCallback(() => {
    teardown();
    setState({ phase: 'idle' });
  }, [teardown]);

  const parse = useCallback(
    async (file: File) => {
      teardown();
      const kind = detectContainerKind(file);
      setState({ phase: 'parsing', filename: file.name });

      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        setState({ phase: 'failed', filename: file.name, reason: 'file_unreadable' });
        return;
      }

      const worker = new Worker(new URL('./import/worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const requestId = crypto.randomUUID();

      timerRef.current = setTimeout(() => {
        teardown();
        setState({ phase: 'failed', filename: file.name, reason: 'preview_timeout' });
      }, PREVIEW_TIMEOUT_MS);

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; requestId: string; result?: unknown; message?: string };
        if (msg.requestId !== requestId) return;
        teardown();
        if (msg.type === 'result') {
          const result = msg.result as FileParseResult | ArchiveParseResult;
          setState({
            phase: 'ready',
            filename: file.name,
            outcome: { kind, result, json: JSON.stringify(result) },
          });
        } else {
          setState({ phase: 'failed', filename: file.name, reason: msg.message ?? 'preview_failed' });
        }
      };

      worker.onerror = () => {
        teardown();
        setState({ phase: 'failed', filename: file.name, reason: 'preview_worker_error' });
      };

      worker.postMessage(
        {
          type: kind === 'archive' ? 'parseArchive' : 'parseWorkbook',
          requestId,
          bytes,
          filename: file.name,
        },
        [bytes],
      );
    },
    [teardown],
  );

  return { state, parse, reset };
}
