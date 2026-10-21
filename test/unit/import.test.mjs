/**
 * Unit tests for paste-a-JSON import: extraction, field mapping and the
 * validate/merge batch behaviour.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyImportDefaults,
  convertMcpServersText,
  extractJsonObject,
  mergeImportedServers,
  prepareImportedServers,
  runImportTest,
  toServerInput,
} from "../../lib/import.js";
import { validateServerInput } from "../../lib/manifest.js";

/** The exact sample the user pasted: a wrapper with a streamable-http server. */
const FLOMO_SAMPLE = `{"mcpServers":{"flomo":{"type":"streamable-http","url":"https://flomoapp.com/mcp","headers":{"Authorization":"Bearer 粘贴你的Token"}}}}`;

const INVALID_INPUT = /^INVALID_INPUT$/;

test("real flomo sample imports as streamable-http with the header kept verbatim", () => {
  const converted = convertMcpServersText(FLOMO_SAMPLE);
  assert.deepEqual(converted.errors, []);
  assert.deepEqual(converted.warnings, []);
  assert.equal(converted.servers.length, 1);
  const [{ serverName, input }] = converted.servers;
  assert.equal(serverName, "flomo");
  assert.deepEqual(input, {
    serverName: "flomo",
    transport: "streamable-http",
    url: "https://flomoapp.com/mcp",
    headers: { Authorization: "Bearer 粘贴你的Token" },
  });

  /* The manager's own validation must preserve the pasted credential as-is. */
  const spec = validateServerInput(input);
  assert.equal(spec.transport, "streamable-http");
  assert.equal(spec.url, "https://flomoapp.com/mcp");
  assert.deepEqual(spec.headers, { Authorization: "Bearer 粘贴你的Token" });
  assert.equal(spec.enabled, true);
});

test("complete mcpServers wrapper with a mixed map keeps order and both transports", () => {
  const text = JSON.stringify({
    mcpServers: {
      flomo: { type: "streamable-http", url: "https://flomoapp.com/mcp", headers: { Authorization: "Bearer x" } },
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" } },
    },
  });
  const converted = convertMcpServersText(text);
  assert.deepEqual(converted.servers.map((entry) => entry.serverName), ["flomo", "github"]);
  assert.equal(converted.servers[0].input.transport, "streamable-http");
  assert.equal(converted.servers[1].input.transport, "stdio");
  assert.deepEqual(converted.servers[1].input.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(converted.servers[1].input.env, { GITHUB_TOKEN: "env:GITHUB_TOKEN" });
});

test("a bare name → server map is accepted without the wrapper", () => {
  const converted = convertMcpServersText('{"alpha":{"url":"https://a.example/mcp"},"beta":{"url":"https://b.example/mcp"}}');
  assert.deepEqual(converted.servers.map((entry) => entry.serverName), ["alpha", "beta"]);
  assert.deepEqual(converted.servers.map((entry) => entry.input.url), ["https://a.example/mcp", "https://b.example/mcp"]);
});

test("a single server object without wrapper is accepted, using serverName or the 'mcp' fallback", () => {
  const named = convertMcpServersText('{"serverName":"solo","type":"streamable-http","url":"https://solo.example/mcp"}');
  assert.deepEqual(named.servers.map((entry) => entry.serverName), ["solo"]);

  const unnamed = convertMcpServersText('{"type":"streamable-http","url":"https://unnamed.example/mcp"}');
  assert.deepEqual(unnamed.servers.map((entry) => entry.serverName), ["mcp"]);

  /* A stdio single object is recognized by its command, not just by name. */
  const stdio = convertMcpServersText('{"command":"npx","args":["-y","pkg"]}');
  assert.equal(stdio.servers[0].serverName, "mcp");
  assert.equal(stdio.servers[0].input.transport, "stdio");
});

test("JSON inside a ```json fence with surrounding prose is extracted", () => {
  const text = [
    "这是我的 MCP 配置，请帮我导入：",
    "```json",
    FLOMO_SAMPLE,
    "```",
    "谢谢！",
  ].join("\n");
  const converted = convertMcpServersText(text);
  assert.equal(converted.servers[0].serverName, "flomo");
  assert.equal(converted.servers[0].input.url, "https://flomoapp.com/mcp");
});

test("surrounding prose without a fence is extracted with balanced braces", () => {
  const text = `配置如下: {"mcpServers":{"x":{"url":"https://x.example/mcp"},"y":{"url":"https://y.example/mcp"}}} 请导入`;
  const converted = convertMcpServersText(text);
  assert.deepEqual(converted.servers.map((entry) => entry.serverName), ["x", "y"]);
});

test("braces inside string values do not confuse the brace matcher", () => {
  const text = `prefix {"mcpServers":{"s":{"type":"streamable-http","url":"https://s.example/mcp","headers":{"X-Template":"{ not json }"}}}} suffix`;
  const converted = convertMcpServersText(text);
  assert.equal(converted.servers[0].input.headers["X-Template"], "{ not json }");
});

test("sse is mapped to streamable-http and warned about", () => {
  const converted = convertMcpServersText('{"mcpServers":{"legacy":{"type":"sse","url":"https://legacy.example/sse"}}}');
  assert.equal(converted.servers[0].input.transport, "streamable-http");
  assert.equal(converted.errors.length, 0);
  assert.equal(converted.warnings.length, 1);
  assert.match(converted.warnings[0], /sse.*streamable-http/);
});

test("transport aliases are normalized", () => {
  const variants = ["streamable-http", "streamableHttp", "streamable_http", "http", "https", "HTTP"];
  for (const variant of variants) {
    const converted = convertMcpServersText(JSON.stringify({ mcpServers: { s: { type: variant, url: "https://s.example/mcp" } } }));
    assert.equal(converted.servers[0].input.transport, "streamable-http", `variant ${variant}`);
  }
  /* `transport` is accepted as an alias of `type`. */
  const viaTransportField = convertMcpServersText('{"mcpServers":{"s":{"transport":"stdio","command":"node"}}}');
  assert.equal(viaTransportField.servers[0].input.transport, "stdio");

  const stdio = convertMcpServersText('{"mcpServers":{"s":{"type":"stdio","command":"node","args":["x.js"]}}}');
  assert.equal(stdio.servers[0].input.transport, "stdio");
});

test("transport is inferred from command or url when no type is given", () => {
  const inferredStdio = convertMcpServersText('{"mcpServers":{"s":{"command":"uvx","args":["mcp-server-fetch"]}}}');
  assert.equal(inferredStdio.servers[0].input.transport, "stdio");

  const inferredHttp = convertMcpServersText('{"mcpServers":{"s":{"url":"https://s.example/mcp"}}}');
  assert.equal(inferredHttp.servers[0].input.transport, "streamable-http");

  for (const field of ["serverUrl", "endpoint"]) {
    const converted = convertMcpServersText(JSON.stringify({ mcpServers: { s: { [field]: "https://alias.example/mcp" } } }));
    assert.equal(converted.servers[0].input.transport, "streamable-http");
    assert.equal(converted.servers[0].input.url, "https://alias.example/mcp");
  }
});

test("timeout, enabled, cwd and env pass through the mapping", () => {
  const converted = convertMcpServersText(JSON.stringify({
    mcpServers: {
      s: {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "env:TOKEN" },
        cwd: "/tmp/work",
        toolCallTimeoutMs: 900000,
        enabled: false,
      },
    },
  }));
  const input = converted.servers[0].input;
  assert.equal("workspaces" in input, false);
  assert.equal(input.toolCallTimeoutMs, 900000);
  assert.equal(input.enabled, false);
  assert.equal(input.cwd, "/tmp/work");
  assert.deepEqual(input.env, { TOKEN: "env:TOKEN" });

  const spec = validateServerInput(input);
  assert.equal("workspaces" in spec, false);
  assert.equal(spec.toolCallTimeoutMs, 900000);
  assert.equal(spec.enabled, false);
});

test("entries the manager cannot represent become per-entry errors, not a fatal throw", () => {
  const converted = convertMcpServersText(JSON.stringify({
    mcpServers: {
      badType: { type: "websocket", url: "wss://x.example/mcp" },
      missingUrl: { type: "streamable-http", headers: {} },
      nul: null,
      ok: { url: "https://ok.example/mcp" },
    },
  }));
  assert.deepEqual(converted.servers.map((entry) => entry.serverName), ["ok"]);
  assert.deepEqual(converted.errors.map((entry) => entry.serverName), ["badType", "missingUrl", "nul"]);
  assert.match(converted.errors[0].reason, /不支持的 type\/transport/);
  assert.match(converted.errors[1].reason, /缺少 url/);
  assert.match(converted.errors[2].reason, /必须是对象/);
});

test("empty configs convert to zero servers with a warning instead of throwing", () => {
  const emptyObject = convertMcpServersText("{}");
  assert.deepEqual(emptyObject.servers, []);
  assert.deepEqual(emptyObject.errors, []);
  assert.equal(emptyObject.warnings.length, 1);
  assert.match(emptyObject.warnings[0], /没有任何 server/);

  const emptyWrapper = convertMcpServersText('{"mcpServers":{}}');
  assert.deepEqual(emptyWrapper.servers, []);
  assert.equal(emptyWrapper.warnings.length, 1);
});

test("unparseable or unrecognizable JSON throws INVALID_INPUT", () => {
  for (const text of ["", "   ", "not json at all", "{ broken", "[]", '"a string"', "{\"mcpServers\": []}"]) {
    assert.throws(
      () => convertMcpServersText(text),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT", `text ${JSON.stringify(text)}: ${error.message}`);
        return true;
      },
      `text ${JSON.stringify(text)}`,
    );
  }
});

test("a plain object whose values are not server objects reports per-entry errors", () => {
  const converted = convertMcpServersText('{"foo":"bar"}');
  assert.deepEqual(converted.servers, []);
  assert.deepEqual(converted.errors.map((entry) => entry.serverName), ["foo"]);
  assert.match(converted.errors[0].reason, /必须是对象/);
});

test("extractJsonObject rejects non-string input", () => {
  assert.throws(() => extractJsonObject(undefined), (error) => error.code === "INVALID_INPUT");
});

test("mergeImportedServers validates and skips existing names unless replace is set", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      flomo: { type: "streamable-http", url: "https://flomoapp.com/mcp", headers: { Authorization: "Bearer x" } },
      fresh: { type: "streamable-http", url: "https://fresh.example/mcp" },
      broken: { type: "streamable-http", url: "ftp://broken.example/mcp" },
      "bad name": { type: "streamable-http", url: "https://badname.example/mcp" },
    },
  }));

  const first = mergeImportedServers({ servers, existingNames: [], defaultToolCallTimeoutMs: 60000 });
  assert.deepEqual(first.added, ["flomo", "fresh"]);
  assert.deepEqual(first.skipped.map((entry) => entry.serverName), ["broken", "bad name"]);
  assert.match(first.skipped[0].reason, /url/);
  assert.match(first.skipped[1].reason, /serverName/);

  const second = mergeImportedServers({ servers, existingNames: ["flomo"], defaultToolCallTimeoutMs: 60000 });
  assert.deepEqual(second.added, ["fresh"]);
  assert.deepEqual(second.skipped[0], { serverName: "flomo", reason: "EXISTS" });
  assert.equal(second.specs.some((entry) => entry.spec.serverName === "flomo"), false);

  const third = mergeImportedServers({ servers, existingNames: ["flomo"], replace: true, defaultToolCallTimeoutMs: 60000 });
  assert.deepEqual(third.added, ["flomo", "fresh"]);
  assert.equal(third.specs.find((entry) => entry.spec.serverName === "flomo").replace, true);
  assert.equal(third.specs.find((entry) => entry.spec.serverName === "fresh").replace, false);
});

test("toServerInput is exposed for single-entry callers", () => {
  const warnings = [];
  const input = toServerInput("s", { type: "http", serverUrl: "https://s.example/mcp" }, warnings);
  assert.deepEqual(input, { serverName: "s", transport: "streamable-http", url: "https://s.example/mcp" });
  assert.deepEqual(warnings, []);
});

test("batch defaults fill in entries that do not declare a timeout", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      a: { type: "streamable-http", url: "https://a.example/mcp" },
      b: { type: "stdio", command: "node" },
    },
  }));
  const merged = mergeImportedServers({
    servers,
    existingNames: [],
    defaultToolCallTimeoutMs: 60000,
    defaults: { toolCallTimeoutMs: 900000 },
  });
  assert.deepEqual(merged.added, ["a", "b"]);
  for (const { spec } of merged.specs) {
    assert.equal(spec.toolCallTimeoutMs, 900000);
    assert.equal("workspaces" in spec, false);
  }
});

test("a pasted entry's own timeout wins over the batch default", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      own: { type: "streamable-http", url: "https://own.example/mcp", toolCallTimeoutMs: 1234 },
    },
  }));
  const merged = mergeImportedServers({
    servers,
    existingNames: [],
    defaultToolCallTimeoutMs: 60000,
    defaults: { toolCallTimeoutMs: 900000 },
  });
  assert.equal(merged.specs[0].spec.toolCallTimeoutMs, 1234);
});

test("without a batch default the plugin default timeout applies", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: { plain: { type: "streamable-http", url: "https://p.example/mcp" } },
  }));
  const merged = mergeImportedServers({ servers, existingNames: [], defaultToolCallTimeoutMs: 4242 });
  assert.equal(merged.specs[0].spec.toolCallTimeoutMs, 4242);
});

test("a mixed batch applies the timeout default per entry without cross-contamination", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      scoped: { type: "streamable-http", url: "https://s.example/mcp", toolCallTimeoutMs: 5000 },
      inherited: { type: "streamable-http", url: "https://i.example/mcp" },
      explicitAll: { type: "stdio", command: "node" },
    },
  }));
  const merged = mergeImportedServers({
    servers,
    existingNames: [],
    defaultToolCallTimeoutMs: 60000,
    defaults: { toolCallTimeoutMs: 900000 },
  });
  const byName = Object.fromEntries(merged.specs.map(({ spec }) => [spec.serverName, spec]));
  assert.equal(byName.scoped.toolCallTimeoutMs, 5000);
  assert.equal(byName.inherited.toolCallTimeoutMs, 900000);
  assert.equal(byName.explicitAll.toolCallTimeoutMs, 900000);
});

test("invalid batch defaults are rejected by validateServerInput per entry", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: { s: { type: "streamable-http", url: "https://s.example/mcp" } },
  }));
  /* The RPC layer normally validates first; the merge layer still fails closed. */
  const badTimeout = mergeImportedServers({
    servers,
    existingNames: [],
    defaultToolCallTimeoutMs: 60000,
    defaults: { toolCallTimeoutMs: 1.5 },
  });
  assert.deepEqual(badTimeout.added, []);
  assert.match(badTimeout.skipped[0].reason, /toolCallTimeoutMs/);
});

test("applyImportDefaults fills enabled/timeout without overriding entry values", () => {
  const defaults = { enabled: false, toolCallTimeoutMs: 900000 };
  assert.deepEqual(applyImportDefaults({ serverName: "a", transport: "stdio", command: "node" }, defaults), {
    serverName: "a",
    transport: "stdio",
    command: "node",
    enabled: false,
    toolCallTimeoutMs: 900000,
  });
  /* Entry-declared values always win, including an explicit false/0-ish value. */
  assert.deepEqual(
    applyImportDefaults({ serverName: "b", transport: "stdio", command: "node", enabled: true, toolCallTimeoutMs: 1234 }, defaults),
    { serverName: "b", transport: "stdio", command: "node", enabled: true, toolCallTimeoutMs: 1234 },
  );
  assert.deepEqual(applyImportDefaults({ serverName: "c", transport: "stdio", command: "node" }, {}), { serverName: "c", transport: "stdio", command: "node" });
});

test("server.import enabled default applies to entries that do not declare it", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      inherited: { url: "https://a.example/mcp" },
      explicit: { url: "https://b.example/mcp", enabled: true },
      disabled: { url: "https://c.example/mcp", enabled: false },
    },
  }));
  const merged = mergeImportedServers({
    servers,
    existingNames: [],
    defaultToolCallTimeoutMs: 60000,
    defaults: { enabled: false, toolCallTimeoutMs: 900000 },
  });
  const byName = Object.fromEntries(merged.specs.map(({ spec }) => [spec.serverName, spec]));
  assert.equal(byName.inherited.enabled, false);
  assert.equal(byName.inherited.toolCallTimeoutMs, 900000);
  assert.equal(byName.explicit.enabled, true);
  assert.equal(byName.disabled.enabled, false);
});

test("prepareImportedServers validates without registry checks", () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      ok: { url: "https://ok.example/mcp" },
      bad: { url: "ftp://bad.example/mcp" },
    },
  }));
  const prepared = prepareImportedServers({
    servers,
    defaults: { enabled: false },
    defaultToolCallTimeoutMs: 60000,
  });
  assert.deepEqual(prepared.specs.map((spec) => spec.serverName), ["ok"]);
  assert.equal(prepared.specs[0].enabled, false);
  assert.deepEqual(prepared.errors.map((entry) => entry.serverName), ["bad"]);
  assert.match(prepared.errors[0].message, /url/);
});

test("runImportTest probes each server independently and maps probe results", async () => {
  const { servers } = convertMcpServersText(JSON.stringify({
    mcpServers: {
      good: { url: "https://good.example/mcp" },
      rejects: { url: "https://rejects.example/mcp" },
      down: { url: "https://down.example/mcp" },
    },
  }));
  const prepared = prepareImportedServers({ servers, defaults: { enabled: true }, defaultToolCallTimeoutMs: 60000 });
  const probed = [];
  const result = await runImportTest({
    converted: { errors: [] },
    prepared,
    probe: async (spec) => {
      probed.push(spec.serverName);
      if (spec.serverName === "good") {
        return { ok: true, latencyMs: 12, protocolVersion: "2026-07-28", serverInfo: { name: "good", version: "1" }, tools: [{ name: "search", description: "Search" }] };
      }
      if (spec.serverName === "rejects") throw new Error("probe exploded");
      return { ok: false, latencyMs: 3, tools: [], error: { code: "transport", message: "fetch failed" } };
    },
  });
  assert.deepEqual(probed, ["good", "rejects", "down"]);
  assert.equal(result.parseErrors.length, 0);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.results.length, 3);

  const good = result.results.find((entry) => entry.serverName === "good");
  assert.equal(good.ok, true);
  assert.equal(good.latencyMs, 12);
  assert.equal(good.protocolVersion, "2026-07-28");
  assert.deepEqual(good.serverInfo, { name: "good", version: "1" });
  assert.deepEqual(good.tools, [{ name: "search", description: "Search" }]);
  assert.equal("error" in good, false);

  const rejects = result.results.find((entry) => entry.serverName === "rejects");
  assert.equal(rejects.ok, false);
  assert.equal(rejects.error.code, "unknown");
  assert.match(rejects.error.message, /probe exploded/);

  const down = result.results.find((entry) => entry.serverName === "down");
  assert.equal(down.ok, false);
  assert.deepEqual(down.error, { code: "transport", message: "fetch failed" });
});

test("runImportTest caps at 10 servers and reports the rest as skipped", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `s${index}`);
  const converted = convertMcpServersText(JSON.stringify({
    mcpServers: Object.fromEntries(names.map((name) => [name, { url: `https://${name}.example/mcp` }])),
  }));
  const prepared = prepareImportedServers({ servers: converted.servers, defaultToolCallTimeoutMs: 60000 });
  const probed = [];
  const result = await runImportTest({
    converted,
    prepared,
    limit: 10,
    probe: async (spec) => {
      probed.push(spec.serverName);
      return { ok: true, latencyMs: 1, tools: [] };
    },
  });
  assert.equal(probed.length, 10);
  assert.equal(result.results.length, 10);
  assert.deepEqual(result.skipped, ["s10", "s11"]);
});

test("runImportTest merges parse and validation errors into parseErrors", async () => {
  const converted = {
    servers: [],
    errors: [{ serverName: "brokenEntry", reason: "缺少 url" }],
  };
  const result = await runImportTest({
    converted,
    prepared: { specs: [], errors: [{ serverName: "invalidServer", message: "url is not valid" }] },
    probe: async () => {
      throw new Error("must not probe");
    },
  });
  assert.deepEqual(result.parseErrors, [
    { serverName: "brokenEntry", message: "缺少 url" },
    { serverName: "invalidServer", message: "url is not valid" },
  ]);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.skipped, []);
});
