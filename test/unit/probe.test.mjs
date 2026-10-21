/**
 * Unit tests for probe error classification, environment scrubbing and the
 * timeout wrapper. Network/SDK behavior is exercised only by the isolated
 * profile verification, never here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PROBE_ERROR_CODES, classifyProbeError, scrubParentEnv, withTimeout } from "../../lib/probe.js";

test("PROBE_ERROR_CODES matches the DESIGN contract", () => {
  assert.deepEqual([...PROBE_ERROR_CODES], ["timeout", "auth", "transport", "protocol", "unknown"]);
});

test("classifyProbeError recognises timeouts", () => {
  const coded = Object.assign(new Error("boom"), { code: "MCP_MANAGER_TIMEOUT" });
  assert.equal(classifyProbeError(coded), "timeout");
  assert.equal(classifyProbeError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "timeout");
  assert.equal(classifyProbeError(Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" })), "timeout");
  assert.equal(classifyProbeError(new Error("request timed out after 60000ms")), "timeout");
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(classifyProbeError(abort), "timeout");
});

test("classifyProbeError recognises authentication failures", () => {
  assert.equal(classifyProbeError(Object.assign(new Error("nope"), { status: 401 })), "auth");
  assert.equal(classifyProbeError(Object.assign(new Error("nope"), { statusCode: 403 })), "auth");
  assert.equal(classifyProbeError(Object.assign(new Error("nope"), { response: { status: 401 } })), "auth");
  assert.equal(classifyProbeError(new Error("HTTP 401 Unauthorized")), "auth");
  assert.equal(classifyProbeError(new Error("status: 403")), "auth");
  assert.equal(classifyProbeError(new Error("invalid token")), "auth");
});

test("classifyProbeError recognises transport failures", () => {
  assert.equal(classifyProbeError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })), "transport");
  assert.equal(classifyProbeError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), "transport");
  assert.equal(classifyProbeError(Object.assign(new Error("spawn"), { code: "ENOENT" })), "transport");
  assert.equal(classifyProbeError(new Error("fetch failed")), "transport");
  assert.equal(classifyProbeError(new Error("socket hang up")), "transport");
  assert.equal(classifyProbeError(new Error("Connection closed")), "transport");
  assert.equal(classifyProbeError(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" })), "transport");
});

test("classifyProbeError recognises protocol failures", () => {
  assert.equal(classifyProbeError(Object.assign(new Error("bad method"), { code: -32601 })), "protocol");
  assert.equal(classifyProbeError(Object.assign(new Error("internal"), { code: -32603 })), "protocol");
  assert.equal(classifyProbeError(new Error("Invalid JSON-RPC response")), "protocol");
  assert.equal(classifyProbeError(new Error("Unsupported protocol version")), "protocol");
  assert.equal(classifyProbeError(new Error("invalid initialize result")), "protocol");
});

test("classifyProbeError falls back to unknown", () => {
  assert.equal(classifyProbeError(new Error("something odd")), "unknown");
  assert.equal(classifyProbeError(undefined), "unknown");
  assert.equal(classifyProbeError("a string"), "unknown");
  /* A positive JSON-RPC-looking code is not the protocol range. */
  assert.equal(classifyProbeError(Object.assign(new Error("odd"), { code: 5 })), "unknown");
});

test("scrubParentEnv drops credential-shaped and DSH_* names", () => {
  const scrubbed = scrubParentEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    GITHUB_TOKEN: "secret",
    MY_PASSWORD: "secret",
    CLIENT_SECRET: "secret",
    API_KEY: "secret",
    DSH_HOME: "/tmp/dsh",
    DSH_PROFILE: "x",
    NORMAL: "value",
    NUMERIC: 42,
  });
  assert.deepEqual(scrubbed, { PATH: "/usr/bin", HOME: "/home/me", NORMAL: "value" });
});

test("withTimeout passes a fast result through and rejects slow work with a timeout code", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "fast"), "ok");
  await assert.rejects(
    withTimeout(new Promise((resolve) => setTimeout(resolve, 200)), 20, "slow"),
    (error) => error.code === "MCP_MANAGER_TIMEOUT" && /slow timed out after 20ms/.test(error.message),
  );
  /* A non-positive timeout means "unbounded". */
  assert.equal(await withTimeout(Promise.resolve("forever"), 0, "unbounded"), "forever");
});
