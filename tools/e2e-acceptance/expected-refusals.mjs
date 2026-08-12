/**
 * EXPECTED DOMAIN REFUSALS — a scoped allowance for deliberately-provoked 4xx.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Some acceptance steps must prove that the server REFUSES something: proving a
 * business rule fires is as much a part of acceptance as proving the happy path
 * works. A canonical RPC refusal arrives as HTTP 400 carrying the rule's own
 * SQLSTATE and message, and the browser logs every 4xx resource with a generic
 * line — "Failed to load resource: the server responded with a status of 400".
 * That generic line carries no message and no SQLSTATE, so without help the
 * session's "no console errors" gate cannot tell a rule firing as designed from
 * a real regression.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ALLOWANCE IS SCOPED, NOT A WHITELIST
 * ─────────────────────────────────────────────────────────────────────────────
 * A page-lifetime registration would keep suppressing that generic console line
 * for the named RPC long after the negative proof finished, so a LATER,
 * unrelated 4xx from the same RPC would vanish from the gate purely because the
 * URL matched. Registrations are therefore a WINDOW: `expectRefusal` opens one
 * and returns a handle, and `close()` ends it. Only ACTIVE registrations can
 * suppress anything, so after `close()` the same RPC is fully policed again.
 *
 * FAIL-CLOSED PROPERTIES, all enforced here rather than by convention:
 *   • only a 4xx is ever suppressible — a 5xx NEVER is, at any time;
 *   • only the exact registered RPC, matched on the /rpc/<name> path segment;
 *   • a refusal is only RECORDED when the response body carries the exact
 *     expected message, so a different failure of the same RPC never counts as
 *     the proof the step is asserting;
 *   • the recorded evidence is per-registration, so a step asserts that ITS
 *     refusal happened rather than that some refusal happened somewhere.
 *
 * Pure: no Playwright, no network, no globals. Handed strings, returns data —
 * which is what makes the sibling unit test able to prove the window actually
 * closes.
 */

/** Extracts the RPC name from a Supabase REST `/rpc/<name>` URL. */
export function rpcNameFromUrl(url) {
  const s = String(url ?? '');
  if (!s.includes('/rpc/')) return null;
  return s.replace(/^.*\/rpc\//, '').split(/[?#]/)[0] || null;
}

/** True for the browser's generic "failed to load resource … 4xx" console line. */
export function isGeneric4xxConsoleLine(text) {
  return /status of 4\d{2}/.test(String(text ?? ''));
}

export function createExpectedRefusalRegistry() {
  /** @type {{rpc: string, message: string, active: boolean, seen: object[]}[]} */
  const registrations = [];

  /**
   * Opens a refusal window for ONE rpc and ONE exact message.
   * Returns a handle: `observed()` for the evidence, `close()` to end it.
   */
  function expectRefusal(rpc, message) {
    if (!rpc || !message) {
      throw new Error('expectRefusal requires an RPC name and the exact expected error message');
    }
    const entry = { rpc, message, active: true, seen: [] };
    registrations.push(entry);
    return {
      rpc,
      message,
      observed: () => [...entry.seen],
      close: () => { entry.active = false; },
      isActive: () => entry.active,
    };
  }

  /**
   * Whether the browser's generic 4xx console line may be dropped.
   * Requires an ACTIVE registration for that exact RPC. 5xx lines never match
   * the generic-4xx test, so they can never be suppressed here.
   */
  function suppressesConsoleError(text, url) {
    if (!isGeneric4xxConsoleLine(text)) return false;
    const rpc = rpcNameFromUrl(url);
    if (!rpc) return false;
    return registrations.some(r => r.active && r.rpc === rpc);
  }

  /**
   * Records a response against any ACTIVE registration it exactly matches.
   * Returns the recorded evidence, or null when nothing matched — which is the
   * case for a 5xx, a different RPC, a different message, or a closed window.
   */
  function recordResponse({ url, status, body }) {
    if (!(Number(status) >= 400 && Number(status) < 500)) return null;
    const rpc = rpcNameFromUrl(url);
    if (!rpc) return null;
    const text = String(body ?? '');
    let recorded = null;
    for (const r of registrations) {
      if (!r.active || r.rpc !== rpc || !text.includes(r.message)) continue;
      recorded = { rpc, message: r.message, status: Number(status), body: text.slice(0, 300) };
      r.seen.push(recorded);
    }
    return recorded;
  }

  /** Registrations still open — a step may assert it left none behind. */
  function activeRegistrations() {
    return registrations.filter(r => r.active).map(r => ({ rpc: r.rpc, message: r.message }));
  }

  return { expectRefusal, suppressesConsoleError, recordResponse, activeRegistrations };
}
