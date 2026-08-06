import { strict as assert } from "node:assert";
import {
  ARTIFACT_VERSION,
  buildHealthPayload,
  SERVICE_NAME,
} from "./health.ts";

Deno.test("buildHealthPayload: healthy payload matches the exact minimal contract", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const payload = buildHealthPayload({ healthy: true, now });
  assert.deepEqual(Object.keys(payload).sort(), [
    "service",
    "status",
    "timestamp",
    "version",
  ]);
  assert.equal(payload.service, SERVICE_NAME);
  assert.equal(payload.status, "ok");
  assert.equal(payload.version, ARTIFACT_VERSION);
  assert.equal(payload.timestamp, "2026-01-01T00:00:00.000Z");
});

Deno.test("buildHealthPayload: degraded status when unhealthy, same shape otherwise", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const payload = buildHealthPayload({ healthy: false, now });
  assert.equal(payload.status, "degraded");
  assert.deepEqual(Object.keys(payload).sort(), [
    "service",
    "status",
    "timestamp",
    "version",
  ]);
});

Deno.test("buildHealthPayload contains no environment values, secrets, or database identifiers", () => {
  const payload = buildHealthPayload({ healthy: true, now: new Date() });
  const serialized = JSON.stringify(payload);
  assert.ok(
    !/supabase|postgres|eyrzxgfkvqybjdgyphap|SECRET|KEY/i.test(serialized),
  );
});

Deno.test("buildHealthPayload is deterministic for the same inputs", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  assert.deepEqual(
    buildHealthPayload({ healthy: true, now }),
    buildHealthPayload({ healthy: true, now }),
  );
});
