/**
 * Unit tests for host-configured MCP discovery, read-only projection and the
 * state merge used by `state` / `status`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describeExternalServer,
  discoverExternalServers,
  entriesAreLiteral,
  externalServerView,
  externalStatus,
  externalTestSpec,
  isMcpClientEntry,
  mergeStateRows,
  presentEntries,
  scopeOfEntryId,
} from "../../lib/external.js";
import { validateServerInput } from "../../lib/manifest.js";

/** Build one fake loader entry. */
function makeEntry(options = {}) {
  const id = options.id ?? "mcp-row";
  return {
    id,
    options: {
      id,
      name: options.name ?? "@deepseek-ai/dsh-mcp-client",
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.disabled === true ? { disabled: true } : {}),
    },
    ...(options.active === false ? {} : { fiber: { uid: options.uid ?? "fiber-1" } }),
  };
}

const HTTP_CONFIG = {
  serverName: "flomo",
  transport: "streamable-http",
  url: "https://flomoapp.com/mcp",
  headers: { Authorization: "Bearer literal-token" },
  toolCallTimeoutMs: 900000,
};

const STDIO_CONFIG = {
  serverName: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
  cwd: "/tmp/work",
};

test("discovers a streamable-http loader row with literal headers", () => {
  const { servers, warnings } = discoverExternalServers([makeEntry({ id: "mcp-flomo", config: HTTP_CONFIG })]);
  assert.deepEqual(warnings, []);
  assert.equal(servers.length, 1);
  const [server] = servers;
  assert.equal(server.serverName, "flomo");
  assert.equal(server.entryId, "mcp-flomo");
  assert.equal(server.active, true);
  assert.equal(server.disabled, false);
  assert.equal(server.scope, "profile");
  assert.equal(server.transport, "streamable-http");
  assert.equal(server.url, "https://flomoapp.com/mcp");
  assert.deepEqual(server.headers, [{ name: "Authorization", value: "Bearer literal-token" }]);
  assert.equal(server.toolCallTimeoutMs, 900000);
  assert.equal(server.env, undefined);
});

test("discovers a stdio loader row and keeps command/args/env/cwd", () => {
  const [server] = discoverExternalServers([makeEntry({ id: "mcp-github", config: STDIO_CONFIG })]).servers;
  assert.equal(server.transport, "stdio");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(server.env, [{ name: "GITHUB_TOKEN", value: "env:GITHUB_TOKEN" }]);
  assert.equal(server.cwd, "/tmp/work");
});

test("marks disabled and inactive rows without dropping them", () => {
  const [disabled] = discoverExternalServers([makeEntry({ config: HTTP_CONFIG, disabled: true })]).servers;
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.active, true);

  const [inactive] = discoverExternalServers([makeEntry({ config: HTTP_CONFIG, active: false })]).servers;
  assert.equal(inactive.active, false);
  assert.equal(inactive.disabled, false);
});

test("preset-nested rows are marked scope:preset", () => {
  const { servers } = discoverExternalServers([
    makeEntry({ id: "preset-standard:mcp-flomo", config: HTTP_CONFIG }),
    makeEntry({ id: "mcp-top", config: { ...HTTP_CONFIG, serverName: "top" } }),
  ]);
  assert.equal(servers.find((server) => server.serverName === "flomo").scope, "preset");
  assert.equal(servers.find((server) => server.serverName === "top").scope, "profile");
});

test("the Loader's include-group prefix is not mistaken for a preset", () => {
  /* Profile patch rows are materialized as `include:<id>` by the Loader. */
  assert.equal(scopeOfEntryId("include:host-mcp-flomo"), "profile");
  assert.equal(scopeOfEntryId("include:include:mcp-flomo"), "profile");
  assert.equal(scopeOfEntryId("include:preset-standard:mcp-flomo"), "preset");
  assert.equal(scopeOfEntryId("preset-standard:mcp-flomo"), "preset");
  assert.equal(scopeOfEntryId(undefined), "profile");

  const { servers } = discoverExternalServers([makeEntry({ id: "include:host-mcp-flomo", config: HTTP_CONFIG })]);
  assert.equal(servers[0].scope, "profile");
});

test("duplicate serverName keeps the first row and warns", () => {
  const { servers, warnings } = discoverExternalServers([
    makeEntry({ id: "first", config: HTTP_CONFIG }),
    makeEntry({ id: "second", config: { ...HTTP_CONFIG, url: "https://second.example/mcp" } }),
  ]);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].entryId, "first");
  assert.equal(servers[0].url, "https://flomoapp.com/mcp");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /flomo/);
});

test("rows without config/serverName and non-mcp-client rows are ignored", () => {
  const entries = [
    makeEntry({ id: "no-config" }),
    makeEntry({ id: "no-name", config: { transport: "stdio", command: "node" } }),
    makeEntry({ id: "other-plugin", name: "@deepseek-ai/dsh-mcp-resources", config: HTTP_CONFIG }),
    makeEntry({ id: "manager", name: "@deepseek-ai/dsh-mcp-manager", config: HTTP_CONFIG }),
    makeEntry({ id: "webserver", name: "@deepseek-ai/dsh-host-webserver", config: HTTP_CONFIG }),
    makeEntry({ id: "ok", config: { ...HTTP_CONFIG, serverName: "ok" } }),
  ];
  const { servers } = discoverExternalServers(entries);
  assert.deepEqual(servers.map((server) => server.serverName), ["ok"]);
});

test("relative-path / alias package names fall back to substring matching", () => {
  const pathEntry = makeEntry({ name: "../../node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", config: HTTP_CONFIG });
  const aliasEntry = makeEntry({ name: "my-dsh-mcp-client-alias", config: { ...HTTP_CONFIG, serverName: "alias" } });
  const unrelated = makeEntry({ name: "dsh-mcp-client-manager", config: { ...HTTP_CONFIG, serverName: "nope" } });
  assert.equal(isMcpClientEntry(pathEntry), true);
  assert.equal(isMcpClientEntry(aliasEntry), true);
  assert.equal(isMcpClientEntry(unrelated), true, "substring fallback is intentionally permissive");
  assert.equal(isMcpClientEntry(makeEntry({ name: "dsh-mcp-manager" })), false);
  assert.equal(isMcpClientEntry(null), false);

  const { servers } = discoverExternalServers([pathEntry]);
  assert.equal(servers.length, 1);
});

test("!!js expression values are carried as text with an expression marker, never executed", () => {
  const config = {
    ...HTTP_CONFIG,
    headers: {
      Authorization: "Bearer literal",
      "X-Dynamic": { __dshJsExpression: "`Bearer ${process.env.SECRET}`" },
      "X-Number": 42,
    },
  };
  const [server] = discoverExternalServers([makeEntry({ config })]).servers;
  assert.equal(server.headers[0].expression, undefined);
  assert.equal(server.headers[1].expression, true);
  assert.match(server.headers[1].value, /process\.env\.SECRET/);
  assert.equal(server.headers[2].expression, true);
  assert.equal(server.headers[2].value, "42");
  assert.equal(entriesAreLiteral(server.headers), false);
  assert.equal(entriesAreLiteral([{ name: "A", value: "1" }]), true);
});

test("presentEntries and undefined entries are handled defensively", () => {
  assert.deepEqual(presentEntries(undefined), []);
  assert.deepEqual(presentEntries({ A: "1" }), [{ name: "A", value: "1" }]);
  assert.deepEqual(discoverExternalServers(undefined), { servers: [], warnings: [] });
  assert.deepEqual(discoverExternalServers(null), { servers: [], warnings: [] });
});

test("describeExternalServer returns undefined for unusable rows", () => {
  assert.equal(describeExternalServer(null), undefined);
  assert.equal(describeExternalServer(makeEntry({ id: "x" })), undefined);
  assert.equal(describeExternalServer(makeEntry({ id: "y", config: { serverName: "" } })), undefined);
});

test("externalServerView is read-only host metadata without workspace scoping", () => {
  const [server] = discoverExternalServers([makeEntry({ id: "mcp-flomo", config: HTTP_CONFIG })]).servers;
  const view = externalServerView(server);
  assert.equal(view.serverName, "flomo");
  assert.equal(view.source, "host");
  assert.equal(view.readOnly, true);
  assert.equal(view.entryId, "mcp-flomo");
  assert.equal(view.active, true);
  assert.equal(view.scope, "profile");
  assert.equal(view.transport, "streamable-http");
  assert.equal(view.url, "https://flomoapp.com/mcp");
  assert.equal("workspaces" in view, false);
  assert.equal("staleWorkspaces" in view, false);
  /* Host-config literal values are shown as stored (no encryption/masking). */
  assert.deepEqual(view.headers, [{ name: "Authorization", value: "Bearer literal-token" }]);
});

test("externalTestSpec reuses literal host config but refuses unevaluated expressions", () => {
  const [httpServer] = discoverExternalServers([makeEntry({ config: HTTP_CONFIG })]).servers;
  const http = externalTestSpec(httpServer);
  assert.deepEqual(http.spec, {
    serverName: "flomo",
    transport: "streamable-http",
    toolCallTimeoutMs: 900000,
    url: "https://flomoapp.com/mcp",
    headers: { Authorization: "Bearer literal-token" },
  });

  const [stdioServer] = discoverExternalServers([
    makeEntry({ config: { ...STDIO_CONFIG, env: { GITHUB_TOKEN: "literal-token" } } }),
  ]).servers;
  const stdio = externalTestSpec(stdioServer);
  assert.equal(stdio.spec.transport, "stdio");
  assert.equal(stdio.spec.command, "npx");
  assert.deepEqual(stdio.spec.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(stdio.spec.env, { GITHUB_TOKEN: "literal-token" });

  const [expression] = discoverExternalServers([
    makeEntry({ config: { ...HTTP_CONFIG, headers: { Authorization: { __dshJsExpression: "process.env.TOKEN" } } } }),
  ]).servers;
  const refused = externalTestSpec(expression);
  assert.equal(refused.spec, undefined);
  assert.equal(refused.error.code, "unknown");
  assert.match(refused.error.message, /表达式/);

  assert.equal(externalTestSpec(undefined).error.code, "unknown");
  assert.equal(externalTestSpec({ serverName: "x", transport: "sse" }).error.code, "unknown");
  assert.equal(externalTestSpec({ serverName: "x", transport: "stdio", command: "", env: [] }).error.code, "unknown");
  assert.equal(externalTestSpec({ serverName: "x", transport: "streamable-http", url: "", headers: [] }).error.code, "unknown");
});

test("externalStatus reports host liveness and never a mount error", () => {
  assert.deepEqual(externalStatus({ active: true }, 3), { mounted: true, toolCount: 3, lastError: null });
  assert.deepEqual(externalStatus({ active: false }, 0), { mounted: false, toolCount: 0, lastError: null });
});

test("mergeStateRows adds manager source, host rows and conflict rows", () => {
  const managerServers = [
    validateServerInput({ serverName: "managed", transport: "stdio", command: "node" }),
    validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://manager.example/mcp" }),
  ];
  const externalServers = discoverExternalServers([
    makeEntry({ id: "mcp-flomo", config: HTTP_CONFIG }),
    makeEntry({ id: "mcp-other", config: { ...HTTP_CONFIG, serverName: "other", url: "https://other.example/mcp" } }),
  ]).servers;

  const { servers, conflicts } = mergeStateRows({ managerServers, externalServers });

  assert.deepEqual(conflicts, ["flomo"]);
  assert.deepEqual(servers.map((server) => server.serverName), ["managed", "flomo", "other"]);

  const managed = servers.find((server) => server.serverName === "managed");
  assert.equal(managed.source, "manager");
  assert.equal(managed.readOnly, undefined);
  assert.equal("workspaces" in managed, false);

  /* Conflict: one manager row, read-only, carrying the host metadata. */
  const flomo = servers.find((server) => server.serverName === "flomo");
  assert.equal(flomo.source, "manager");
  assert.equal(flomo.conflict, "host");
  assert.equal(flomo.readOnly, true);
  assert.equal(flomo.entryId, "mcp-flomo");
  assert.equal(flomo.active, true);
  assert.equal(flomo.scope, "profile");
  assert.equal(servers.filter((server) => server.serverName === "flomo").length, 1);

  const other = servers.find((server) => server.serverName === "other");
  assert.equal(other.source, "host");
  assert.equal(other.readOnly, true);
  assert.equal("workspaces" in other, false);
});

test("mergeStateRows keeps host rows read-only and independent of the manager registry", () => {
  const externalServers = discoverExternalServers([makeEntry({ config: HTTP_CONFIG })]).servers;
  const { servers, conflicts } = mergeStateRows({ managerServers: [], externalServers });
  assert.deepEqual(conflicts, []);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].source, "host");
  assert.equal(servers[0].readOnly, true);
  assert.equal("workspaces" in servers[0], false);
});
