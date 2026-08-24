/**
 * BOUNDED DEADLINES FOR COLD-START NETWORK READS.
 *
 * WHY THIS EXISTS. The auth bootstrap wrapped every network read in try/catch:
 *
 *     try { return await getSessionResult(); } catch { return { status: 'failed' }; }
 *
 * That converts a REJECTION into a stated failure. It does nothing for a promise
 * that never settles — `await` never returns, `.then()` never fires, and the app
 * keeps rendering the full-screen loading emblem forever. A dropped request on a
 * cold mobile launch is exactly that shape: not an error, just silence. Users
 * observed it on Android and could only escape by reloading the page.
 *
 * A deadline is therefore not a retry policy and not an optimisation. It is the
 * difference between "we do not know yet" and "we will never know", which is the
 * distinction the state machine needs in order to offer the operator a retry.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *   - It does not cancel the underlying request. `Promise.race` cannot; the
 *     request may still answer later. Callers MUST therefore re-check their
 *     generation guards before applying any result — see AppContext's
 *     authGenerationRef / profileRequestRef.
 *   - It does not reload the page, sign the user out, clear storage, or retry.
 *     Every one of those would either destroy state or hide the failure.
 *   - It does not turn a timeout into "no session". Silence is not proof that
 *     nobody is signed in.
 */

/**
 * The initial session read. Generous on purpose: a cold Android launch on a
 * congested mobile network legitimately spends several seconds on DNS, TLS and
 * the first Supabase round-trip, and a false failure here would be worse than
 * the spinner it replaces — it would tell an operator their session is
 * unreachable while it is merely slow. Twelve seconds is far longer than a
 * healthy start and far shorter than "forever".
 */
export const AUTH_BOOTSTRAP_DEADLINE_MS = 12_000;

/**
 * The profile + permissions pipeline, which runs after a session already
 * resolved. The same budget applies: by this point one round-trip has already
 * succeeded, so exceeding it again means the connection has genuinely stopped
 * answering rather than that it started slowly.
 */
export const AUTH_PROFILE_DEADLINE_MS = 12_000;

/**
 * Returned instead of a value when the operation outlived its deadline. A unique
 * symbol so it can never be confused with a legitimate result — including
 * `null`, `undefined`, or a `{ status: 'failed' }` the service itself produced.
 */
export const DEADLINE_EXCEEDED = Symbol('phoenix.deadline.exceeded');
export type DeadlineExceeded = typeof DEADLINE_EXCEEDED;

/** Narrowing helper, so callers read as a decision rather than a comparison. */
export function isDeadlineExceeded<T>(v: T | DeadlineExceeded): v is DeadlineExceeded {
  return v === DEADLINE_EXCEEDED;
}

/**
 * Resolve `operation`, or resolve to {@link DEADLINE_EXCEEDED} once `ms` have
 * passed — whichever happens first.
 *
 * A rejection is left to propagate: callers already convert rejection into a
 * stated failure, and swallowing it here would erase the distinction between
 * "the server said no" and "the server said nothing".
 *
 * The timer is always cleared, so a fast operation leaves no pending handle
 * behind to keep a test environment or a mobile runtime awake.
 */
export function withDeadline<T>(operation: Promise<T>, ms: number): Promise<T | DeadlineExceeded> {
  return new Promise<T | DeadlineExceeded>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(DEADLINE_EXCEEDED);
    }, ms);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
