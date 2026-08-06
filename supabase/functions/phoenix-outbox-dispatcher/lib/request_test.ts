import { strict as assert } from "node:assert";
import { hasUnexpectedBody, isSupportedMethod } from "./request.ts";

Deno.test("isSupportedMethod: only GET is supported", () => {
  assert.equal(isSupportedMethod("GET"), true);
  assert.equal(isSupportedMethod("get"), false);
  assert.equal(isSupportedMethod("POST"), false);
  assert.equal(isSupportedMethod("PUT"), false);
  assert.equal(isSupportedMethod("DELETE"), false);
  assert.equal(isSupportedMethod("OPTIONS"), false);
  assert.equal(isSupportedMethod("HEAD"), false);
});

Deno.test("hasUnexpectedBody: false for a plain GET with no body and no content-length", () => {
  const req = new Request("https://example.invalid/", { method: "GET" });
  assert.equal(hasUnexpectedBody(req), false);
});

Deno.test("hasUnexpectedBody: true when a non-zero content-length header is present", () => {
  const req = new Request("https://example.invalid/", {
    method: "GET",
    headers: { "content-length": "5" },
  });
  assert.equal(hasUnexpectedBody(req), true);
});

Deno.test("hasUnexpectedBody: false when content-length is explicitly zero", () => {
  const req = new Request("https://example.invalid/", {
    method: "GET",
    headers: { "content-length": "0" },
  });
  assert.equal(hasUnexpectedBody(req), false);
});
