// Static source-scan guards. Runtime tests can prove what the code DOES;
// they cannot prove an absence as robustly as reading the source itself.
// This file scans every non-test .ts file in this function's own directory
// (index.ts + lib/*.ts, excluding *_test.ts) and asserts the D3-2A
// prohibitions hold structurally, not just behaviorally.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// This file lives at .../phoenix-outbox-dispatcher/lib/static_guards_test.ts
// dirname once  -> .../phoenix-outbox-dispatcher/lib
// dirname twice -> .../phoenix-outbox-dispatcher   (the whole function)
const FUNCTION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = collectSourceFiles(FUNCTION_DIR);

Deno.test("static guard sanity: the expected non-test source files were actually found", () => {
  assert.ok(
    SOURCE_FILES.length >= 6,
    `expected >= 6 source files under ${FUNCTION_DIR}, found ${SOURCE_FILES.length}: ${
      SOURCE_FILES.join(", ")
    }`,
  );
});

// The four D3-1 ROUTINE names. D3-2C allow-lists exactly one production file
// (ADAPTER_RELATIVE) for these and for `.rpc(` — every other file remains
// under the original blanket prohibition, unchanged.
const PROHIBITED_D3_1_FUNCTION_IDENTIFIERS = [
  "phoenix_outbox_claim_batch",
  "phoenix_outbox_mark_completed",
  "phoenix_outbox_mark_failed",
  "phoenix_outbox_release_lease",
];

// The two D3-1 TABLE names. Never allow-listed anywhere, including the
// adapter: the adapter's entire authority is four routines, never direct
// table access.
const PROHIBITED_D3_1_TABLE_IDENTIFIERS = [
  "phoenix_outbox_consumers",
  "phoenix_outbox_delivery_state",
];

// The single production file D3-2C allow-lists. This is a NARROWING of two
// existing rules for exactly one path — not a removal. It is paired with the
// positive guards at the bottom of this file, which assert that this file
// really does carry those identifiers (so the allow-list cannot silently
// cover a file that no longer needs it), that no OTHER production file
// acquires them, and that no non-test production file imports it.
const ADAPTER_RELATIVE = "lib/supabase-rpc-adapter.ts";
const VALIDATION_RELATIVE = "lib/rpc-result-validation.ts";

// Matches a remote-procedure call WITH OR WITHOUT an explicit type argument.
// The plain /\.rpc\s*\(/ form silently misses `.rpc<T>(...)`, which is the
// shape a typed client is normally called with — a hole this guard closes.
const RPC_CALL = /\.rpc\s*(<[^>]*>)?\s*\(/;

// Reachability is about IMPORTS, not mentions: a module named in a comment is
// documentation, while a module named in an import specifier is a live edge in
// the dependency graph. These match only the latter.
const importsModule = (source: string, moduleName: string): boolean =>
  new RegExp(`from\\s+["'][^"']*${moduleName}`).test(source) ||
  new RegExp(`import\\s*\\(\\s*["'][^"']*${moduleName}`).test(source);

for (const file of SOURCE_FILES) {
  const relative = file.slice(FUNCTION_DIR.length + 1).replace(/\\/g, "/");
  const source = Deno.readTextFileSync(file);
  const isAdapter = relative === ADAPTER_RELATIVE;

  Deno.test(`static guard [${relative}]: contains none of the prohibited D3-1 RPC/table identifiers`, () => {
    // Tables are prohibited in every production file without exception.
    for (const id of PROHIBITED_D3_1_TABLE_IDENTIFIERS) {
      assert.ok(!source.includes(id), `${relative} must not contain "${id}"`);
    }
    // Routine names are prohibited everywhere except the allow-listed adapter.
    if (isAdapter) return;
    for (const id of PROHIBITED_D3_1_FUNCTION_IDENTIFIERS) {
      assert.ok(!source.includes(id), `${relative} must not contain "${id}"`);
    }
  });

  Deno.test(`static guard [${relative}]: no Supabase client construction, RPC call, or table access`, () => {
    // createClient( stays prohibited in EVERY production file, including the
    // adapter — D3-2C injects its transport and constructs no client.
    assert.ok(
      !/createClient\s*\(/.test(source),
      `${relative} must not call createClient(`,
    );
    // Table access stays prohibited everywhere, including the adapter.
    assert.ok(
      !/\.from\s*\(\s*['"]/.test(source),
      `${relative} must not call .from('table')`,
    );
    if (isAdapter) return;
    assert.ok(!RPC_CALL.test(source), `${relative} must not call .rpc(`);
  });

  Deno.test(`static guard [${relative}]: no outbound fetch call`, () => {
    assert.ok(!/\bfetch\s*\(/.test(source), `${relative} must not call fetch(`);
  });

  Deno.test(`static guard [${relative}]: no legacy service-role key reference`, () => {
    assert.ok(
      !source.includes("SUPABASE_SERVICE_ROLE_KEY"),
      `${relative} must not reference SUPABASE_SERVICE_ROLE_KEY`,
    );
  });

  Deno.test(`static guard [${relative}]: no pg_cron, pg_net, or cron.schedule reference`, () => {
    assert.ok(
      !/pg_cron|pg_net/i.test(source),
      `${relative} must not reference pg_cron/pg_net`,
    );
    assert.ok(
      !/cron\.schedule/i.test(source),
      `${relative} must not reference cron.schedule`,
    );
  });

  Deno.test(`static guard [${relative}]: no direct DB connection string / Postgres driver usage`, () => {
    assert.ok(
      !/postgresql:\/\//i.test(source),
      `${relative} must not embed a Postgres connection string`,
    );
    assert.ok(
      !/from\s+['"]pg['"]/.test(source),
      `${relative} must not import the 'pg' driver`,
    );
  });
}

// ── D3-2C positive guards ───────────────────────────────────────────────────
//
// The narrowing above is only safe because these assertions bound it: the
// allow-list must apply to a file that genuinely needs it, must apply to
// exactly one file, and must never make that file reachable.

function readSource(relative: string): string {
  return Deno.readTextFileSync(join(FUNCTION_DIR, relative));
}

Deno.test("D3-2C guard: the allow-listed adapter really is the file that carries the D3-1 routine identifiers", () => {
  const source = readSource(ADAPTER_RELATIVE);
  for (const id of PROHIBITED_D3_1_FUNCTION_IDENTIFIERS) {
    assert.ok(
      source.includes(id),
      `${ADAPTER_RELATIVE} is allow-listed and must therefore contain "${id}"`,
    );
  }
  assert.ok(
    RPC_CALL.test(source),
    `${ADAPTER_RELATIVE} is allow-listed and must therefore call .rpc(`,
  );
});

Deno.test("D3-2C guard: exactly ONE production file carries the D3-1 routine identifiers or .rpc(", () => {
  const carriers: string[] = [];
  for (const file of SOURCE_FILES) {
    const relative = file.slice(FUNCTION_DIR.length + 1).replace(/\\/g, "/");
    const source = Deno.readTextFileSync(file);
    const carriesName = PROHIBITED_D3_1_FUNCTION_IDENTIFIERS.some((id) =>
      source.includes(id)
    );
    if (carriesName || RPC_CALL.test(source)) carriers.push(relative);
  }
  assert.deepEqual(
    carriers,
    [ADAPTER_RELATIVE],
    "only the allow-listed adapter may name a D3-1 routine or call .rpc(",
  );
});

Deno.test(`D3-2C guard [${ADAPTER_RELATIVE}]: the adapter's own prohibitions still hold`, () => {
  const source = readSource(ADAPTER_RELATIVE);
  const forbiddenSubstrings = [
    "createClient(",
    ".from(",
    "fetch(",
    "SUPABASE_SERVICE_ROLE_KEY",
    "Deno.env",
    "process.env",
    "postgres://",
    "postgresql://",
    "console.log",
    "console.error",
    "console.warn",
    "console.debug",
    "console.info",
  ];
  for (const needle of forbiddenSubstrings) {
    assert.ok(
      !source.includes(needle),
      `${ADAPTER_RELATIVE} must not contain "${needle}"`,
    );
  }
  assert.ok(
    !/from\s+["']pg["']/.test(source),
    `${ADAPTER_RELATIVE} must not import the 'pg' driver`,
  );
  // No outbound request headers are constructed here: the injected transport
  // owns credential presentation entirely.
  assert.ok(
    !/["'](authorization|apikey)["']/i.test(source),
    `${ADAPTER_RELATIVE} must not construct request auth headers`,
  );
  // No remote dependency of any kind (D1 ruling).
  assert.ok(
    !/from\s+["'](npm:|jsr:|https?:)/.test(source),
    `${ADAPTER_RELATIVE} must not import a remote module`,
  );
});

Deno.test("D3-2C guard: no non-test production file imports the adapter or the validation module", () => {
  for (const file of SOURCE_FILES) {
    const relative = file.slice(FUNCTION_DIR.length + 1).replace(/\\/g, "/");
    if (relative === ADAPTER_RELATIVE) continue; // the adapter may import the validators
    const source = Deno.readTextFileSync(file);
    assert.ok(
      !importsModule(source, "supabase-rpc-adapter"),
      `${relative} must not import the adapter — it stays unreachable`,
    );
    if (relative === VALIDATION_RELATIVE) continue;
    assert.ok(
      !importsModule(source, "rpc-result-validation"),
      `${relative} must not import the validation module`,
    );
  }
});

Deno.test("D3-2C guard: the validation module is pure and imports nothing remote", () => {
  const source = readSource(VALIDATION_RELATIVE);
  for (
    const needle of [
      "createClient(",
      ".rpc(",
      ".from(",
      "fetch(",
      "Deno.env",
      "process.env",
      "console.log",
    ]
  ) {
    assert.ok(
      !source.includes(needle),
      `${VALIDATION_RELATIVE} must not contain "${needle}"`,
    );
  }
  assert.ok(
    !/from\s+["'](npm:|jsr:|https?:)/.test(source),
    `${VALIDATION_RELATIVE} must not import a remote module`,
  );
});

Deno.test("D3-2C guard: index.ts and handler.ts remain free of every dispatch and adapter identifier", () => {
  for (const relative of ["index.ts", "lib/handler.ts"]) {
    const source = readSource(relative);
    const forbidden = [
      "runDispatchCycle",
      "OutboxRpcClient",
      "supabase-rpc-adapter",
      "rpc-result-validation",
      "createClient(",

      ...PROHIBITED_D3_1_FUNCTION_IDENTIFIERS,
    ];
    for (const needle of forbidden) {
      assert.ok(
        !source.includes(needle),
        `${relative} must remain free of "${needle}"`,
      );
    }
  }
});

Deno.test("static guard: the three existing Edge Functions are not imported or referenced by this function", () => {
  const forbiddenReferences = [
    "admin-create-user",
    "admin-recycle-user",
    "admin-user-lifecycle",
  ];
  for (const file of SOURCE_FILES) {
    const source = Deno.readTextFileSync(file);
    for (const name of forbiddenReferences) {
      assert.ok(
        !source.includes(name),
        `${file} must not reference existing function "${name}"`,
      );
    }
  }
});
