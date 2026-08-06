// Offline tests for lib/runtime-config.ts (D3-2D).
//
// Pure and permissionless: no environment, network, filesystem, subprocess,
// FFI, or system access. Every value is synthetic.
import { strict as assert } from "node:assert";

import {
  BATCH_SIZE_ENV_VAR,
  CONSUMER_KEY_ENV_VAR,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DISPATCH_ENABLED_ALLOWED_VALUE,
  DISPATCH_ENABLED_ENV_VAR,
  isDispatchEnabled,
  MAX_BATCH_SIZE,
  MAX_DISPATCH_TIMEOUT_MS,
  resolveRuntimeConfig,
  SECRET_KEYS_ENV_VAR,
  SUPABASE_URL_ENV_VAR,
  TIMEOUT_MS_ENV_VAR,
} from "./runtime-config.ts";
import { MAX_TIMEOUT_MS } from "./supabase-rpc-adapter.ts";

const URL_OK = "https://probe-nonprod-d3-2d.example.invalid";
const KEY_OK = "sb_secret_probe_nonprod_value_not_real";
const CONSUMER_OK = "probe_nonprod_d3_2_v1-runtime";

const envOf = (
  overrides: Record<string, string | undefined> = {},
): (name: string) => string | undefined => {
  const base: Record<string, string | undefined> = {
    [SUPABASE_URL_ENV_VAR]: URL_OK,
    [SECRET_KEYS_ENV_VAR]: JSON.stringify({ default: KEY_OK }),
    [CONSUMER_KEY_ENV_VAR]: CONSUMER_OK,
    ...overrides,
  };
  return (name: string) => base[name];
};

// ── Activation: exact allow-value only ──────────────────────────────────────

Deno.test("dispatch is disabled by default — an absent flag never enables it", () => {
  assert.equal(isDispatchEnabled(() => undefined), false);
});

Deno.test('only the exact string "true" enables dispatch', () => {
  assert.equal(DISPATCH_ENABLED_ALLOWED_VALUE, "true");
  assert.equal(
    isDispatchEnabled((n) =>
      n === DISPATCH_ENABLED_ENV_VAR ? "true" : undefined
    ),
    true,
  );
});

Deno.test("every near-miss activation value leaves dispatch disabled", () => {
  const rejected = [
    "",
    " ",
    "true ",
    " true",
    "true\n",
    "true\t",
    "True",
    "TRUE",
    "tRuE",
    "1",
    "yes",
    "on",
    "enabled",
    "y",
    "0",
    "false",
    "null",
    "undefined",
    '"true"',
    "true,true",
  ];
  for (const value of rejected) {
    assert.equal(
      isDispatchEnabled((n) =>
        n === DISPATCH_ENABLED_ENV_VAR ? value : undefined
      ),
      false,
      `${JSON.stringify(value)} must not enable dispatch`,
    );
  }
});

Deno.test("activation reads its own variable and no other", () => {
  const seen: string[] = [];
  isDispatchEnabled((n) => {
    seen.push(n);
    return undefined;
  });
  assert.deepEqual(seen, [DISPATCH_ENABLED_ENV_VAR]);
});

// ── Runtime configuration ───────────────────────────────────────────────────

Deno.test("a complete configuration resolves with the documented defaults", () => {
  const result = resolveRuntimeConfig(envOf());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.config, {
    supabaseUrl: URL_OK,
    secretKey: KEY_OK,
    consumerKey: CONSUMER_OK,
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_DISPATCH_TIMEOUT_MS,
  });
});

Deno.test("the timeout ceiling matches the adapter's own ceiling exactly", () => {
  assert.equal(MAX_DISPATCH_TIMEOUT_MS, MAX_TIMEOUT_MS);
});

Deno.test("every invalid configuration fails closed with a field reason", () => {
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    [
      "url missing",
      { [SUPABASE_URL_ENV_VAR]: undefined },
      "supabase_url_missing",
    ],
    ["url empty", { [SUPABASE_URL_ENV_VAR]: "" }, "supabase_url_missing"],
    [
      "url unparseable",
      { [SUPABASE_URL_ENV_VAR]: "not a url" },
      "supabase_url_invalid",
    ],
    [
      "url not https",
      { [SUPABASE_URL_ENV_VAR]: "http://insecure.example.invalid" },
      "supabase_url_invalid",
    ],
    [
      "keys missing",
      { [SECRET_KEYS_ENV_VAR]: undefined },
      "secret_keys_missing",
    ],
    ["keys empty", { [SECRET_KEYS_ENV_VAR]: "" }, "secret_keys_missing"],
    [
      "keys not json",
      { [SECRET_KEYS_ENV_VAR]: "{" },
      "secret_keys_invalid_json",
    ],
    ["keys array", { [SECRET_KEYS_ENV_VAR]: "[]" }, "secret_keys_invalid_json"],
    [
      "keys null",
      { [SECRET_KEYS_ENV_VAR]: "null" },
      "secret_keys_invalid_json",
    ],
    [
      "keys no default",
      { [SECRET_KEYS_ENV_VAR]: JSON.stringify({ other: KEY_OK }) },
      "secret_keys_missing_default",
    ],
    [
      "keys wrong class",
      {
        [SECRET_KEYS_ENV_VAR]: JSON.stringify({ default: "sb_publishable_x" }),
      },
      "secret_keys_invalid_key_type",
    ],
    [
      "keys untrimmed",
      { [SECRET_KEYS_ENV_VAR]: JSON.stringify({ default: ` ${KEY_OK}` }) },
      "secret_keys_invalid_key_type",
    ],
    [
      "consumer missing",
      { [CONSUMER_KEY_ENV_VAR]: undefined },
      "consumer_key_missing",
    ],
    ["consumer empty", { [CONSUMER_KEY_ENV_VAR]: "" }, "consumer_key_missing"],
    [
      "consumer uppercase",
      { [CONSUMER_KEY_ENV_VAR]: "Probe" },
      "consumer_key_invalid",
    ],
    [
      "consumer spaced",
      { [CONSUMER_KEY_ENV_VAR]: "a b" },
      "consumer_key_invalid",
    ],
    [
      "consumer too short",
      { [CONSUMER_KEY_ENV_VAR]: "ab" },
      "consumer_key_invalid",
    ],
    ["batch zero", { [BATCH_SIZE_ENV_VAR]: "0" }, "batch_size_invalid"],
    [
      "batch over bound",
      { [BATCH_SIZE_ENV_VAR]: String(MAX_BATCH_SIZE + 1) },
      "batch_size_invalid",
    ],
    ["batch fractional", { [BATCH_SIZE_ENV_VAR]: "1.5" }, "batch_size_invalid"],
    ["batch signed", { [BATCH_SIZE_ENV_VAR]: "+5" }, "batch_size_invalid"],
    ["batch spaced", { [BATCH_SIZE_ENV_VAR]: " 5" }, "batch_size_invalid"],
    [
      "batch exponential",
      { [BATCH_SIZE_ENV_VAR]: "1e1" },
      "batch_size_invalid",
    ],
    ["batch words", { [BATCH_SIZE_ENV_VAR]: "ten" }, "batch_size_invalid"],
    ["timeout zero", { [TIMEOUT_MS_ENV_VAR]: "0" }, "timeout_invalid"],
    [
      "timeout over ceiling",
      { [TIMEOUT_MS_ENV_VAR]: String(MAX_DISPATCH_TIMEOUT_MS + 1) },
      "timeout_invalid",
    ],
    ["timeout negative", { [TIMEOUT_MS_ENV_VAR]: "-1" }, "timeout_invalid"],
  ];
  for (const [label, overrides, reason] of cases) {
    const result = resolveRuntimeConfig(envOf(overrides));
    assert.equal(result.ok, false, `${label}: must fail closed`);
    if (result.ok) continue;
    assert.equal(result.reason, reason, `${label}: reason`);
  }
});

Deno.test("failure never echoes the secret key, url, or consumer key", () => {
  const result = resolveRuntimeConfig(envOf({ [CONSUMER_KEY_ENV_VAR]: "A B" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const serialized = JSON.stringify(result);
  for (const secretish of [KEY_OK, URL_OK, "A B"]) {
    assert.ok(
      !serialized.includes(secretish),
      "a failure must carry a reason only, never a value",
    );
  }
});

Deno.test("explicit in-bounds batch size and timeout are honored exactly", () => {
  const result = resolveRuntimeConfig(
    envOf({
      [BATCH_SIZE_ENV_VAR]: String(MAX_BATCH_SIZE),
      [TIMEOUT_MS_ENV_VAR]: String(MAX_DISPATCH_TIMEOUT_MS),
    }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.batchSize, MAX_BATCH_SIZE);
  assert.equal(result.config.timeoutMs, MAX_DISPATCH_TIMEOUT_MS);
});
