import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal data-loading hook for live Supabase reads.
 * - Tracks loading / error / data with no external deps.
 * - Surfaces a developer-safe error message to the UI and logs the raw
 *   error to the console (never swallows Supabase failures silently).
 * - `reload()` re-runs the loader (used by error-state retry buttons).
 *
 * The loader is re-run whenever any value in `deps` changes (same contract
 * as useEffect deps). Pass an inline arrow — it is only invoked through the
 * deps array, so the loader reference itself is deliberately not a dep.
 */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    loader()
      .then((result) => {
        if (active) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Developer-safe console log; user sees a friendly message only.
        console.error('[phoenix] data load failed:', err);
        const message = err instanceof Error ? err.message : 'Unexpected error';
        setError(message);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
