/**
 * CN-2A — browser Web Worker adapter.
 *
 * The provisional/untrusted client-side preview path. Runs the identical
 * shared parser core (`parser-core.ts`/`archive-core.ts`) used by the Node 22
 * replay adapter, differing only in the injected DEFLATE decompression
 * function (see contract.ts "Runtime parity"). Nothing in this file touches
 * the DOM, evaluates a formula, or renders HTML — `cellHTML:false` is fixed
 * in `parser-core.ts` regardless of caller.
 *
 * Message protocol (structured-cloneable, no functions/class instances):
 *   -> { type: 'parseWorkbook'; requestId: string; bytes: ArrayBuffer; filename: string; limits?: ParserLimits }
 *   -> { type: 'parseArchive';  requestId: string; bytes: ArrayBuffer; filename: string; limits?: ParserLimits }
 *   <- { type: 'result'; requestId: string; result: FileParseResult | ArchiveParseResult }
 *   <- { type: 'error';  requestId: string; message: string }
 *   <- { type: 'timeout'; requestId: string }
 *
 * Bounded execution: the host page is responsible for `worker.terminate()`
 * on its own timer (Workers cannot reliably self-interrupt a hung synchronous
 * loop) — `parser-core.ts`'s row/column/cell-count limits exist precisely so
 * a well-formed-but-hostile input cannot produce an unbounded loop in the
 * first place, making termination a last resort rather than the only guard.
 */
import type { ArchiveParseResult, FileParseResult, ParserLimits } from './contract.ts';
import { parseWorkbookBytes } from './parser-core.ts';
import { parseArchiveBytes } from './archive-core.ts';
import { browserInflate } from './browser-inflate.ts';

interface ParseWorkbookRequest {
  type: 'parseWorkbook';
  requestId: string;
  bytes: ArrayBuffer;
  filename: string;
  limits?: ParserLimits;
}

interface ParseArchiveRequest {
  type: 'parseArchive';
  requestId: string;
  bytes: ArrayBuffer;
  filename: string;
  limits?: ParserLimits;
}

type WorkerRequest = ParseWorkbookRequest | ParseArchiveRequest;

type WorkerResponse =
  | { type: 'result'; requestId: string; result: FileParseResult | ArchiveParseResult }
  | { type: 'error'; requestId: string; message: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'parseWorkbook') {
      const result = await parseWorkbookBytes(new Uint8Array(msg.bytes), msg.filename, { runtime: 'browser_worker', limits: msg.limits });
      const response: WorkerResponse = { type: 'result', requestId: msg.requestId, result };
      (self as unknown as Worker).postMessage(response);
    } else if (msg.type === 'parseArchive') {
      const result = await parseArchiveBytes(new Uint8Array(msg.bytes), msg.filename, {
        runtime: 'browser_worker',
        limits: msg.limits,
        inflate: browserInflate,
      });
      const response: WorkerResponse = { type: 'result', requestId: msg.requestId, result };
      (self as unknown as Worker).postMessage(response);
    }
  } catch (err) {
    const response: WorkerResponse = { type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};
