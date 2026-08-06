// Deno-native tests. Run with `deno test` from this directory (or repo
// root with a matching include path). No network, no Docker, no Postgres,
// no Supabase daemon required — every dependency is either a pure function
// or the `node:assert` built-in, which Deno resolves offline.
import { strict as assert } from "node:assert";
import {
  checkSecretKeyConfiguration,
  DISPATCH_SECRET_ENV_VAR,
  MINIMUM_SECRET_LENGTH,
  resolveDispatchSecret,
} from "./config.ts";

const GOOD_SECRET = "a".repeat(MINIMUM_SECRET_LENGTH);

function envOf(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

Deno.test("resolveDispatchSecret: missing env var fails closed", () => {
  const result = resolveDispatchSecret(envOf({}));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing");
});

Deno.test("resolveDispatchSecret: empty env var fails closed", () => {
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: "" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "empty");
});

Deno.test("resolveDispatchSecret: below minimum length fails closed", () => {
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: "short" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_short");
});

Deno.test("resolveDispatchSecret: a comma in the configured secret is rejected (would be indistinguishable from a duplicated header)", () => {
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: `${GOOD_SECRET},x` }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_format");
});

Deno.test("resolveDispatchSecret: accepts a sufficiently long, comma-free secret", () => {
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: GOOD_SECRET }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.secret, GOOD_SECRET);
});

Deno.test("resolveDispatchSecret: never reads the legacy service-role variable, and reads only its own", () => {
  const seen: string[] = [];
  resolveDispatchSecret((name) => {
    seen.push(name);
    return undefined;
  });
  assert.deepEqual(seen, [DISPATCH_SECRET_ENV_VAR]);
  assert.ok(!seen.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

Deno.test("resolveDispatchSecret is deterministic for the same input", () => {
  const env = envOf({ [DISPATCH_SECRET_ENV_VAR]: GOOD_SECRET });
  assert.deepEqual(resolveDispatchSecret(env), resolveDispatchSecret(env));
});

// The three tests below deliberately do NOT use GOOD_SECRET or any string
// derived from MINIMUM_SECRET_LENGTH — every length below is a hardcoded
// numeric literal (31 or 32) so a future change that weakens the exported
// constant is caught here, not silently absorbed by a self-adjusting
// fixture. Values are obviously synthetic ('x' repeated), never
// credential-like.

Deno.test("MINIMUM_SECRET_LENGTH is pinned at 32", () => {
  assert.equal(MINIMUM_SECRET_LENGTH, 32);
});

Deno.test("resolveDispatchSecret: a literal 31-character secret is rejected", () => {
  const literal31 = "x".repeat(31);
  assert.equal(literal31.length, 31); // sanity-check the literal, not the constant
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: literal31 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_short");
});

Deno.test("resolveDispatchSecret: a literal 32-character secret is accepted", () => {
  const literal32 = "x".repeat(32);
  assert.equal(literal32.length, 32); // sanity-check the literal, not the constant
  const result = resolveDispatchSecret(
    envOf({ [DISPATCH_SECRET_ENV_VAR]: literal32 }),
  );
  assert.equal(result.ok, true);
});

Deno.test("checkSecretKeyConfiguration: reports configured=true when SUPABASE_SECRET_KEYS alone is well-formed", () => {
  const env = envOf({
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_placeholder" }),
  });
  assert.equal(checkSecretKeyConfiguration(env).configured, true);
});

Deno.test("checkSecretKeyConfiguration: does NOT require SUPABASE_PUBLISHABLE_KEYS at all (deliberately decoupled)", () => {
  const seen: string[] = [];
  const status = checkSecretKeyConfiguration((name) => {
    seen.push(name);
    if (name === "SUPABASE_SECRET_KEYS") {
      return JSON.stringify({ default: "sb_secret_placeholder" });
    }
    return undefined;
  });
  assert.equal(status.configured, true);
  assert.ok(!seen.includes("SUPABASE_PUBLISHABLE_KEYS"));
});

Deno.test("checkSecretKeyConfiguration: reports configured=false without throwing when missing", () => {
  const status = checkSecretKeyConfiguration(envOf({}));
  assert.equal(status.configured, false);
  if (!status.configured) assert.equal(status.issue, "missing_env");
});

Deno.test("checkSecretKeyConfiguration: reports invalid_json for unparseable input", () => {
  const status = checkSecretKeyConfiguration(
    envOf({ SUPABASE_SECRET_KEYS: "{" }),
  );
  assert.equal(status.configured, false);
  if (!status.configured) assert.equal(status.issue, "invalid_json");
});

Deno.test('checkSecretKeyConfiguration: reports missing_default when the "default" key is absent', () => {
  const status = checkSecretKeyConfiguration(
    envOf({ SUPABASE_SECRET_KEYS: "{}" }),
  );
  assert.equal(status.configured, false);
  if (!status.configured) assert.equal(status.issue, "missing_default");
});

Deno.test("checkSecretKeyConfiguration: reports invalid_key_type for a wrong-class key", () => {
  const status = checkSecretKeyConfiguration(
    envOf({
      SUPABASE_SECRET_KEYS: JSON.stringify({
        default: "sb_publishable_wrong_class",
      }),
    }),
  );
  assert.equal(status.configured, false);
  if (!status.configured) assert.equal(status.issue, "invalid_key_type");
});

Deno.test("checkSecretKeyConfiguration: never instantiates a Supabase client (no such import exists in this module)", () => {
  // Structural guarantee, not a runtime one: see lib/static_guards_test.ts,
  // which asserts createClient(/.rpc( never appear anywhere in this
  // function's source. This test just documents the intent alongside the
  // behavioral tests above.
  assert.ok(typeof checkSecretKeyConfiguration === "function");
});
