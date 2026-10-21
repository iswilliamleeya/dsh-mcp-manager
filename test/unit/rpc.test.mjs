/**
 * Unit tests for the `/mcp-manager` RPC dispatcher.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RPC_ENDPOINTS, createManagerRpcHandler } from "../../lib/rpc.js";
import { OWNER_PEER, createRpcBridge } from "./helpers.mjs";

test("RPC_ENDPOINTS matches the DESIGN contract", () => {
  assert.deepEqual([...RPC_ENDPOINTS], [
    "state",
    "server.add",
    "server.update",
    "server.remove",
    "server.toggle",
    "server.test",
    "server.import",
    "server.importTest",
    "status",
  ]);
});

test("state passes the bridge value through", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  assert.deepEqual(await handle("state", {}, undefined, OWNER_PEER), {
    ok: true,
    value: { version: 2, servers: [], status: {} },
  });
  assert.deepEqual(calls.map((call) => call.method), ["state"]);
});

test("status wraps the status record", async () => {
  const { bridge } = createRpcBridge({
    async status() {
      return { alpha: { mounted: true, toolCount: 2, lastError: null } };
    },
  });
  const handle = createManagerRpcHandler(bridge);
  assert.deepEqual(await handle("status", {}, undefined, OWNER_PEER), {
    ok: true,
    value: { status: { alpha: { mounted: true, toolCount: 2, lastError: null } } },
  });
});

test("server.add accepts a ServerInput object", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  const input = { serverName: "s", transport: "stdio", command: "node" };
  assert.deepEqual(await handle("server.add", input, undefined, OWNER_PEER), { ok: true, value: { serverName: "s" } });
  assert.deepEqual(calls[0], { method: "addServer", args: [input] });
});

test("server.update requires serverName but passes the full input", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  const input = { serverName: "s", transport: "stdio", command: "node" };
  assert.deepEqual(await handle("server.update", input, undefined, OWNER_PEER), { ok: true, value: { serverName: "s" } });
  assert.deepEqual(calls[0], { method: "updateServer", args: [input] });

  const failure = await handle("server.update", { transport: "stdio" }, undefined, OWNER_PEER);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "INVALID_INPUT");
  assert.match(failure.error.message, /serverName/);
});

test("server.remove returns the DESIGN result shape", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  assert.deepEqual(await handle("server.remove", { serverName: "s" }, undefined, OWNER_PEER), { ok: true, value: { removed: true } });
  assert.deepEqual(calls[0], { method: "removeServer", args: ["s"] });
});

test("server.toggle validates the boolean and returns it", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  assert.deepEqual(
    await handle("server.toggle", { serverName: "s", enabled: false }, undefined, OWNER_PEER),
    { ok: true, value: { enabled: false } },
  );
  assert.deepEqual(calls[0], { method: "toggleServer", args: ["s", false] });

  const missing = await handle("server.toggle", { serverName: "s" }, undefined, OWNER_PEER);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "INVALID_INPUT");

  const wrongType = await handle("server.toggle", { serverName: "s", enabled: "yes" }, undefined, OWNER_PEER);
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error.code, "INVALID_INPUT");
});

test("server.test passes an unsaved input through and keeps the probe shape", async () => {
  const { bridge } = createRpcBridge({
    async testServer(input) {
      assert.deepEqual(input, { serverName: "s", transport: "streamable-http", url: "https://example.com/mcp" });
      return { ok: false, latencyMs: 12, tools: [], error: { code: "auth", message: "401" } };
    },
  });
  const handle = createManagerRpcHandler(bridge);
  const input = { serverName: "s", transport: "streamable-http", url: "https://example.com/mcp" };
  const result = await handle("server.test", input, undefined, OWNER_PEER);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { ok: false, latencyMs: 12, tools: [], error: { code: "auth", message: "401" } });
});

test("server.import validates {json, replace} and returns the batch result", async () => {
  const { bridge, calls } = createRpcBridge();
  const received = [];
  bridge.importServers = async (input) => {
    received.push(input);
    return { added: ["flomo"], skipped: [{ serverName: "old", reason: "EXISTS" }], warnings: [] };
  };
  const handle = createManagerRpcHandler(bridge);

  const json = '{"mcpServers":{"flomo":{"type":"streamable-http","url":"https://flomoapp.com/mcp"}}}';
  const result = await handle("server.import", { json }, undefined, OWNER_PEER);
  assert.deepEqual(result, {
    ok: true,
    value: { added: ["flomo"], skipped: [{ serverName: "old", reason: "EXISTS" }], warnings: [] },
  });
  assert.deepEqual(received.at(-1), { json, replace: false });

  const withReplace = await handle("server.import", { json, replace: true, enabled: false }, undefined, OWNER_PEER);
  assert.equal(withReplace.ok, true);
  assert.deepEqual(received.at(-1), { json, replace: true, enabled: false });

  const badEnabled = await handle("server.import", { json, enabled: "yes" }, undefined, OWNER_PEER);
  assert.equal(badEnabled.ok, false);
  assert.equal(badEnabled.error.code, "INVALID_INPUT");
  assert.match(badEnabled.error.message, /enabled/);

  /* The batch timeout default is validated and passed through unchanged;
     a stray legacy `workspaces` payload field is ignored. */
  const withDefaults = await handle("server.import", {
    json,
    toolCallTimeoutMs: 900000,
    workspaces: ["should-be-ignored"],
  }, undefined, OWNER_PEER);
  assert.equal(withDefaults.ok, true);
  assert.deepEqual(received.at(-1), { json, replace: false, toolCallTimeoutMs: 900000 });

  for (const payload of [{}, { json: "" }, { json: "   " }, { json: 42 }]) {
    const failure = await handle("server.import", payload, undefined, OWNER_PEER);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "INVALID_INPUT");
    assert.deepEqual(failure.error.details, {});
  }

  const badReplace = await handle("server.import", { json, replace: "yes" }, undefined, OWNER_PEER);
  assert.equal(badReplace.ok, false);
  assert.equal(badReplace.error.code, "INVALID_INPUT");
});

test("server.import rejects malformed batch defaults with INVALID_INPUT", async () => {
  const { bridge } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  const json = '{"mcpServers":{"s":{"url":"https://s.example/mcp"}}}';

  for (const toolCallTimeoutMs of [0, -1, 1.5, "900", null, Number.MAX_SAFE_INTEGER, 86_400_001]) {
    const failure = await handle("server.import", { json, toolCallTimeoutMs }, undefined, OWNER_PEER);
    assert.equal(failure.ok, false, `toolCallTimeoutMs ${JSON.stringify(toolCallTimeoutMs)} should fail`);
    assert.equal(failure.error.code, "INVALID_INPUT");
  }

  /* A valid request is never rejected because the optional fields are absent. */
  assert.equal((await handle("server.import", { json }, undefined, OWNER_PEER)).ok, true);
});

test("server.import surfaces a bad-JSON INVALID_INPUT from the manager", async () => {
  const { bridge } = createRpcBridge({
    async importServers() {
      throw Object.assign(new Error("无法从文本中提取有效的 JSON 对象"), { code: "INVALID_INPUT" });
    },
  });
  const handle = createManagerRpcHandler(bridge);
  const result = await handle("server.import", { json: "not json" }, undefined, OWNER_PEER);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "INVALID_INPUT", message: "无法从文本中提取有效的 JSON 对象", details: {} },
  });
});

test("non-owner peers are refused before dispatch", async () => {
  const { bridge, calls } = createRpcBridge();
  const handle = createManagerRpcHandler(bridge);
  const result = await handle("state", {}, undefined, { principal: { kind: "guest" } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("createManagerRpcHandler rejects a missing bridge", () => {
  assert.throws(() => createManagerRpcHandler(null), TypeError);
});
