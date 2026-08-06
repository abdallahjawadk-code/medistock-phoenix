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

const PROHIBITED_D3_1_IDENTIFIERS = [
  "phoenix_outbox_claim_batch",
  "phoenix_outbox_mark_completed",
  "phoenix_outbox_mark_failed",
  "phoenix_outbox_release_lease",
  "phoenix_outbox_consumers",
  "phoenix_outbox_delivery_state",
];

for (const file of SOURCE_FILES) {
  const relative = file.slice(FUNCTION_DIR.length + 1).replace(/\\/g, "/");
  const source = Deno.readTextFileSync(file);

  Deno.test(`static guard [${relative}]: contains none of the prohibited D3-1 RPC/table identifiers`, () => {
    for (const id of PROHIBITED_D3_1_IDENTIFIERS) {
      assert.ok(!source.includes(id), `${relative} must not contain "${id}"`);
    }
  });

  Deno.test(`static guard [${relative}]: no Supabase client construction, RPC call, or table access`, () => {
    assert.ok(
      !/createClient\s*\(/.test(source),
      `${relative} must not call createClient(`,
    );
    assert.ok(!/\.rpc\s*\(/.test(source), `${relative} must not call .rpc(`);
    assert.ok(
      !/\.from\s*\(\s*['"]/.test(source),
      `${relative} must not call .from('table')`,
    );
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
