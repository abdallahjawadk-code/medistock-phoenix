import { strict as assert } from "node:assert";
import {
  DISPATCH_SECRET_HEADER,
  timingSafeEqual,
  validateSchedulerAuth,
} from "./auth.ts";

const SECRET = "correct-horse-battery-staple-0123456789";

function headersWith(pairs: Array<[string, string]>): Headers {
  const h = new Headers();
  for (const [k, v] of pairs) h.append(k, v);
  return h;
}

Deno.test("validateSchedulerAuth: accepts the correct secret", () => {
  const result = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, SECRET]]),
    SECRET,
  );
  assert.equal(result.ok, true);
});

Deno.test("validateSchedulerAuth: rejects a missing header", () => {
  const result = validateSchedulerAuth(new Headers(), SECRET);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing");
});

Deno.test("validateSchedulerAuth: rejects an empty header value", () => {
  const result = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, ""]]),
    SECRET,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "empty");
});

Deno.test("validateSchedulerAuth: rejects a whitespace-only header value as empty", () => {
  const result = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, "   "]]),
    SECRET,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "empty");
});

Deno.test("validateSchedulerAuth: rejects an incorrect secret", () => {
  const result = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, "wrong-value"]]),
    SECRET,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "incorrect");
});

Deno.test("validateSchedulerAuth: rejects a duplicated/ambiguous header", () => {
  const headers = headersWith([
    [DISPATCH_SECRET_HEADER, SECRET],
    [DISPATCH_SECRET_HEADER, "a-second-value"],
  ]);
  // Sanity check on the platform contract this logic depends on: confirm the
  // Fetch Headers object really did coalesce two appended values into one
  // comma-joined string before our own code ever runs.
  assert.equal(
    headers.get(DISPATCH_SECRET_HEADER),
    `${SECRET}, a-second-value`,
  );

  const result = validateSchedulerAuth(headers, SECRET);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ambiguous");
});

Deno.test("validateSchedulerAuth: rejects a case-variant duplicated header the same way", () => {
  const headers = new Headers();
  headers.append(DISPATCH_SECRET_HEADER, SECRET);
  headers.append(DISPATCH_SECRET_HEADER.toUpperCase(), "a-second-value");
  const result = validateSchedulerAuth(headers, SECRET);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ambiguous");
});

Deno.test("timingSafeEqual: true only for exact matches, including edge cases", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

Deno.test("validateSchedulerAuth is deterministic for the same inputs", () => {
  const a = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, SECRET]]),
    SECRET,
  );
  const b = validateSchedulerAuth(
    headersWith([[DISPATCH_SECRET_HEADER, SECRET]]),
    SECRET,
  );
  assert.deepEqual(a, b);
});
