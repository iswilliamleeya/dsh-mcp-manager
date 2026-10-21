/**
 * Unit tests for manifest v2 persistence, validation and projection.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  bridgeConfigFor,
  emptyManifest,
  entriesToRecord,
  attributeToolName,
  countToolsByServer,
  loadManifestFile,
  manifestPathFor,
  mcpToolPrefix,
  readManifest,
  recordToEntries,
  resolveEnvValue,
  mergeServerValues,
  mergeValueRecord,
  resolveSecretValue,
  resolveSpecValues,
  sortServerNames,
  specSignature,
  toServerView,
  validateServerInput,
  writeManifest,
} from "../../lib/manifest.js";

/** One temporary directory per test. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-manager-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const STDIO_INPUT = {
  serverName: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
  cwd: "/tmp",
  toolCallTimeoutMs: 1234,
};

const HTTP_INPUT = {
  serverName: "unifuncs",
  transport: "streamable-http",
  url: "https://mcp.unifuncs.com/mcp",
  headers: { Authorization: "env:MCP_UNIFUNCS_API_KEY" },
  toolCallTimeoutMs: 900000,
};

test("manifestPathFor prefers an explicit override and ignores blank", () => {
  assert.equal(manifestPathFor({ manifestFile: "/x/y.json" }, "/home/.dsh"), "/x/y.json");
  assert.equal(manifestPathFor({ manifestFile: "   " }, "/home/.dsh"), join("/home/.dsh", MANIFEST_FILENAME));
  assert.equal(manifestPathFor({}, "/home/.dsh"), join("/home/.dsh", MANIFEST_FILENAME));
});

test("readManifest tolerates a missing file", (t) => {
  const dir = tempDir(t);
  const manifest = readManifest(join(dir, "absent.json"));
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.deepEqual(manifest.servers, []);
  assert.deepEqual(manifest.warnings, []);
});

test("writeManifest writes v2 atomically with mode 0600 and round-trips", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  const spec = validateServerInput(STDIO_INPUT);
  writeManifest(file, { servers: [spec] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const body = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(body.version, MANIFEST_VERSION);
  assert.equal(body.servers.length, 1);
  assert.deepEqual(body.servers[0].env, { GITHUB_TOKEN: "env:GITHUB_TOKEN" });
  const loaded = readManifest(file);
  assert.deepEqual(loaded.servers, [spec]);
});

test("writeManifest replaces a pre-existing wider-mode file with 0600", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeFileSync(file, JSON.stringify({ version: 1, servers: [] }), { mode: 0o644 });
  writeManifest(file, { servers: [] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("writeManifest validates before touching the live file", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeManifest(file, { servers: [validateServerInput(STDIO_INPUT)] });
  const before = readFileSync(file, "utf8");
  assert.throws(() => writeManifest(file, { servers: [{ serverName: "bad name!", transport: "stdio", command: "x" }] }), /serverName/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("readManifest upgrades a v1 manifest to the canonical v2 spec", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    servers: [{
      serverName: "old",
      transport: "stdio",
      enabled: true,
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "env:TOKEN" },
      cwd: "",
    }],
  }, null, 2)}\n`);
  const manifest = readManifest(file);
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal("workspaces" in manifest.servers[0], false);
  assert.equal(manifest.servers[0].toolCallTimeoutMs, 60000);
});

test("readManifest skips one invalid entry and reports it, keeping the rest", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeFileSync(file, JSON.stringify({
    version: 2,
    servers: [
      { serverName: "good", transport: "stdio", command: "node" },
      { serverName: "bad name", transport: "stdio", command: "node" },
      { serverName: "also-good", transport: "streamable-http", url: "http://localhost:3000/mcp" },
    ],
  }));
  const manifest = readManifest(file);
  assert.deepEqual(manifest.servers.map((server) => server.serverName), ["good", "also-good"]);
  assert.equal(manifest.warnings.length, 1);
  assert.match(manifest.warnings[0], /index 1/);
});

test("readManifest lets the later duplicate win", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeFileSync(file, JSON.stringify({
    version: 2,
    servers: [
      { serverName: "dup", transport: "stdio", command: "first" },
      { serverName: "dup", transport: "stdio", command: "second" },
    ],
  }));
  const manifest = readManifest(file);
  assert.equal(manifest.servers.length, 1);
  assert.equal(manifest.servers[0].command, "second");
  assert.match(manifest.warnings.join("\n"), /duplicate/);
});

test("readManifest rejects unreadable/corrupt/unsupported files", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");

  writeFileSync(file, "{ not json");
  assert.throws(() => readManifest(file), (error) => error.code === "MANIFEST_INVALID");

  writeFileSync(file, JSON.stringify([]));
  assert.throws(() => readManifest(file), (error) => error.code === "MANIFEST_INVALID");

  writeFileSync(file, JSON.stringify({ version: 2, servers: {} }));
  assert.throws(() => readManifest(file), (error) => error.code === "MANIFEST_INVALID");

  writeFileSync(file, JSON.stringify({ version: 99, servers: [] }));
  assert.throws(() => readManifest(file), (error) => error.code === "MANIFEST_UNSUPPORTED");
});

test("emptyManifest is v2 and empty", () => {
  assert.deepEqual(emptyManifest(), { version: 2, servers: [] });
});

test("legacy manifests with workspaces/externalScopes load and are stripped on disk", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeFileSync(file, `${JSON.stringify({
    version: 2,
    servers: [
      {
        serverName: "old",
        transport: "streamable-http",
        url: "https://old.example/mcp",
        headers: { Authorization: "env:TOKEN" },
        workspaces: ["legacy-workspace"],
      },
    ],
    externalScopes: { "host-row": ["another-workspace"] },
  }, null, 2)}\n`);

  /* readManifest is pure: it reports the removed fields without writing. */
  const loaded = readManifest(file);
  assert.deepEqual(loaded.legacyFields, ["externalScopes", "workspaces"]);
  assert.equal("workspaces" in loaded.servers[0], false);

  /* loadManifestFile ignores them and rewrites the file without them. */
  const result = loadManifestFile(file);
  assert.deepEqual(result.cleanedLegacyFields, ["externalScopes", "workspaces"]);
  assert.equal("workspaces" in result.manifest.servers[0], false);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("externalScopes" in onDisk, false);
  assert.equal("workspaces" in onDisk.servers[0], false);
  assert.equal(onDisk.servers[0].serverName, "old");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("loadManifestFile leaves a clean manifest untouched", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mcp-manager.json");
  writeManifest(file, { servers: [validateServerInput(STDIO_INPUT)] });
  const result = loadManifestFile(file);
  assert.deepEqual(result.cleanedLegacyFields, []);
  assert.deepEqual(result.manifest.servers, [validateServerInput(STDIO_INPUT)]);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  /* A missing manifest is also clean. */
  const missing = loadManifestFile(join(dir, "absent.json"));
  assert.deepEqual(missing.manifest.servers, []);
  assert.deepEqual(missing.cleanedLegacyFields, []);
});

test("removed workspace fields are ignored by validation instead of rejecting", () => {
  const spec = validateServerInput({
    serverName: "s",
    transport: "streamable-http",
    url: "https://s.example/mcp",
    workspaces: ["w1"],
    externalScopes: { x: ["y"] },
  });
  assert.equal("workspaces" in spec, false);
  assert.equal("externalScopes" in spec, false);
});

test("MCP tool prefix attribution supports status/toolCount after workspace removal", () => {
  assert.equal(mcpToolPrefix("github"), "mcp__github__");
  assert.deepEqual(sortServerNames(["a", "alpha", "alpha-deep"]), ["alpha-deep", "alpha", "a"]);
  const sorted = sortServerNames(["alpha", "alpha-deep", "beta"]);
  assert.equal(attributeToolName("mcp__alpha-deep__x", sorted), "alpha-deep");
  assert.equal(attributeToolName("mcp__alpha__x", sorted), "alpha");
  assert.equal(attributeToolName("mcp__gamma__x", sorted), undefined);
  assert.equal(attributeToolName("read", sorted), undefined);

  const counts = countToolsByServer(
    ["read", "mcp__alpha__a", "mcp__alpha__b", "mcp__alpha-deep__c", "mcp__beta__d"],
    ["alpha", "alpha-deep", "beta", "unused"],
  );
  assert.equal(counts.get("alpha"), 2);
  assert.equal(counts.get("alpha-deep"), 1);
  assert.equal(counts.get("beta"), 1);
  assert.equal(counts.get("unused"), 0);
});

test("validateServerInput normalizes stdio and http inputs", () => {
  const stdio = validateServerInput(STDIO_INPUT);
  assert.deepEqual(stdio, {
    serverName: "github",
    transport: "stdio",
    enabled: true,
    toolCallTimeoutMs: 1234,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
    cwd: "/tmp",
  });

  const http = validateServerInput(HTTP_INPUT);
  assert.deepEqual(http, {
    serverName: "unifuncs",
    transport: "streamable-http",
    enabled: true,
    toolCallTimeoutMs: 900000,
    url: "https://mcp.unifuncs.com/mcp",
    headers: { Authorization: "env:MCP_UNIFUNCS_API_KEY" },
  });

  /* A default timeout applies when omitted. */
  assert.equal(validateServerInput({ serverName: "a", transport: "stdio", command: "x" }).toolCallTimeoutMs, 60000);
  assert.equal(
    validateServerInput({ serverName: "a", transport: "stdio", command: "x" }, { defaultToolCallTimeoutMs: 9 }).toolCallTimeoutMs,
    9,
  );
});

test("validateServerInput accepts entry arrays for env/headers", () => {
  const stdio = validateServerInput({
    serverName: "s",
    transport: "stdio",
    command: "x",
    env: [{ name: "A", value: "1" }, { name: "B", value: "env:B" }],
  });
  assert.deepEqual(stdio.env, { A: "1", B: "env:B" });

  const http = validateServerInput({
    serverName: "h",
    transport: "streamable-http",
    url: "http://localhost:1/mcp",
    headers: [{ name: "Authorization", value: "env:TOKEN" }],
  });
  assert.deepEqual(http.headers, { Authorization: "env:TOKEN" });
});

test("validateServerInput rejects invalid fields with INVALID_INPUT", () => {
  const reject = (input, pattern) => {
    assert.throws(() => validateServerInput(input), (error) => {
      assert.equal(error.code, "INVALID_INPUT", `unexpected code for ${JSON.stringify(input)}: ${error.message}`);
      if (pattern !== undefined) assert.match(error.message, pattern);
      return true;
    });
  };
  reject(null);
  reject({ transport: "stdio", command: "x" });
  reject({ serverName: "has space", transport: "stdio", command: "x" }, /serverName/);
  reject({ serverName: "x".repeat(33), transport: "stdio", command: "x" }, /serverName/);
  reject({ serverName: "s", transport: "sse", command: "x" }, /transport/);
  reject({ serverName: "s", transport: "stdio" }, /command/);
  reject({ serverName: "s", transport: "stdio", command: "x", enabled: "yes" }, /enabled/);
  reject({ serverName: "s", transport: "stdio", command: "x", toolCallTimeoutMs: 0 }, /toolCallTimeoutMs/);
  reject({ serverName: "s", transport: "stdio", command: "x", toolCallTimeoutMs: 1.5 }, /toolCallTimeoutMs/);
  reject({ serverName: "s", transport: "streamable-http" }, /url/);
  reject({ serverName: "s", transport: "streamable-http", url: "ftp://x" }, /http/);
  reject({ serverName: "s", transport: "streamable-http", url: "not a url" }, /absolute URL/);
  reject({ serverName: "s", transport: "stdio", command: "x", env: { A: 1 } }, /env/);
  reject({ serverName: "s", transport: "stdio", command: "x", env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, /duplicate env/);
});

test("validateServerInput ignores irrelevant and unknown fields", () => {
  const spec = validateServerInput({
    serverName: "s",
    transport: "stdio",
    command: "x",
    url: "http://ignored",
    headers: { ignored: "yes" },
    unknownField: 42,
  });
  assert.equal("url" in spec, false);
  assert.equal("headers" in spec, false);
  assert.equal("unknownField" in spec, false);
});

test("entriesToRecord/recordToEntries round-trip", () => {
  const record = entriesToRecord([{ name: "A", value: "1" }], "env");
  assert.deepEqual(record, { A: "1" });
  assert.deepEqual(recordToEntries(record), [{ name: "A", value: "1" }]);
  assert.deepEqual(recordToEntries(undefined), []);
});

test("resolveEnvValue passes plain values through and resolves env: indirection", () => {
  assert.equal(resolveEnvValue("plain", "x", {}), "plain");
  assert.equal(resolveEnvValue("env:TOKEN", "x", { TOKEN: "secret" }), "secret");
  assert.throws(() => resolveEnvValue("env:MISSING", "x", {}), (error) => error.code === "ENV_MISSING");
  assert.throws(() => resolveEnvValue("env:", "x", {}), (error) => error.code === "INVALID_INPUT");
  assert.throws(() => resolveEnvValue("env:EMPTY", "x", { EMPTY: "" }), (error) => error.code === "ENV_MISSING");
});

test("bridgeConfigFor produces the bridge contract and resolves credentials", () => {
  const stdio = bridgeConfigFor(validateServerInput(STDIO_INPUT), { env: { GITHUB_TOKEN: "t0ken" } });
  assert.deepEqual(stdio, {
    serverName: "github",
    toolCallTimeoutMs: 1234,
    failOnStartupError: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "t0ken" },
    cwd: "/tmp",
  });

  const http = bridgeConfigFor(validateServerInput(HTTP_INPUT), { env: { MCP_UNIFUNCS_API_KEY: "k" } });
  assert.deepEqual(http, {
    serverName: "unifuncs",
    toolCallTimeoutMs: 900000,
    failOnStartupError: false,
    transport: "streamable-http",
    url: "https://mcp.unifuncs.com/mcp",
    headers: { Authorization: "k" },
  });

  assert.throws(() => bridgeConfigFor(validateServerInput(HTTP_INPUT), { env: {} }), (error) => error.code === "ENV_MISSING");
});

test("specSignature tracks connection-relevant fields only", () => {
  const base = validateServerInput(HTTP_INPUT);
  const same = validateServerInput({ ...HTTP_INPUT, toolCallTimeoutMs: 900000 });
  assert.equal(specSignature(base), specSignature(same));
  const changedUrl = validateServerInput({ ...HTTP_INPUT, url: "https://example.com/mcp" });
  assert.notEqual(specSignature(base), specSignature(changedUrl));
  const changedTimeout = validateServerInput({ ...HTTP_INPUT, toolCallTimeoutMs: 5 });
  assert.notEqual(specSignature(base), specSignature(changedTimeout));
  /* Changing a credential reference remounts; changing its value would not. */
  const changedHeader = validateServerInput({ ...HTTP_INPUT, headers: { Authorization: "env:OTHER" } });
  assert.notEqual(specSignature(base), specSignature(changedHeader));
});

test("toServerView exposes entry arrays without workspace-scoping fields", () => {
  const stdio = toServerView(validateServerInput(STDIO_INPUT));
  assert.deepEqual(stdio, {
    serverName: "github",
    transport: "stdio",
    enabled: true,
    toolCallTimeoutMs: 1234,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: [{ name: "GITHUB_TOKEN", value: "env:GITHUB_TOKEN" }],
    cwd: "/tmp",
  });

  const http = toServerView(validateServerInput(HTTP_INPUT));
  assert.deepEqual(http.headers, [{ name: "Authorization", value: "env:MCP_UNIFUNCS_API_KEY" }]);
  assert.equal("workspaces" in http, false);
  assert.equal("staleWorkspaces" in http, false);
});

test("toServerView returns actual header/env values (plaintext and references)", () => {
  const stdio = validateServerInput({
    serverName: "s",
    transport: "stdio",
    command: "node",
    env: { PLAIN: "literal-secret", ENVREF: "env:TOKEN", CREDREF: "credential:openai" },
  });
  const view = toServerView(stdio);
  assert.deepEqual(view.env, [
    { name: "PLAIN", value: "literal-secret" },
    { name: "ENVREF", value: "env:TOKEN" },
    { name: "CREDREF", value: "credential:openai" },
  ]);
  assert.equal(view.env.some((entry) => "secret" in entry), false);

  const http = validateServerInput({ serverName: "h", transport: "streamable-http", url: "https://x.example/mcp", headers: { Authorization: "Bearer legacy" } });
  assert.deepEqual(toServerView(http).headers, [{ name: "Authorization", value: "Bearer legacy" }]);
});

test("resolveSecretValue resolves references and passes plaintext through", async () => {
  const credentials = {
    async resolve(ref) {
      return ref === "known" ? { value: "credential-value", source: "test" } : undefined;
    },
  };
  const deps = { env: { TOKEN: "env-value", EMPTY: "" }, credentials };

  assert.equal(await resolveSecretValue("literal-value", deps), "literal-value");
  assert.equal(await resolveSecretValue("env:TOKEN", deps), "env-value");
  assert.equal(await resolveSecretValue("credential:known", deps), "credential-value");

  await assert.rejects(() => resolveSecretValue("env:MISSING", deps), (error) => error.code === "ENV_MISSING");
  await assert.rejects(() => resolveSecretValue("env:EMPTY", deps), (error) => error.code === "ENV_MISSING");
  await assert.rejects(() => resolveSecretValue("env:", deps), (error) => error.code === "INVALID_INPUT");
  await assert.rejects(() => resolveSecretValue("credential:missing", deps), (error) => error.code === "CREDENTIAL_MISSING");
  await assert.rejects(() => resolveSecretValue("credential:any", { env: {} }), (error) => error.code === "CREDENTIAL_UNAVAILABLE");
  await assert.rejects(
    () => resolveSecretValue("credential:boom", { env: {}, credentials: { async resolve() { throw new Error("boom"); } } }),
    (error) => error.code === "CREDENTIAL_RESOLVE_FAILED",
  );
});

test("resolveSpecValues resolves the active transport's values only", async () => {
  const credentials = { async resolve() { return { value: "cred", source: "test" }; } };
  const stdio = await resolveSpecValues(
    validateServerInput({ serverName: "s", transport: "stdio", command: "node", env: { A: "plain", B: "env:TWO", C: "credential:x" } }),
    { env: { TWO: "two" }, credentials },
  );
  assert.deepEqual(stdio.env, { A: "plain", B: "two", C: "cred" });
  assert.equal(stdio.headers, undefined);

  const http = await resolveSpecValues(
    validateServerInput({ serverName: "h", transport: "streamable-http", url: "https://h.example/mcp", headers: { Authorization: "Bearer real", "X-Ref": "env:REF" } }),
    { env: { REF: "ref-value" } },
  );
  assert.deepEqual(http.headers, { Authorization: "Bearer real", "X-Ref": "ref-value" });
});

test("blank header/env values keep the stored value; new blank entries are rejected", () => {
  const existing = { TOKEN: "stored-value", OTHER: "env:OTHER" };
  assert.deepEqual(mergeValueRecord({ TOKEN: "", OTHER: "" }, existing, "env"), { TOKEN: "stored-value", OTHER: "env:OTHER" });
  assert.deepEqual(mergeValueRecord({ TOKEN: "new-value" }, existing, "env"), { TOKEN: "new-value" });
  /* A field absent from the incoming record means the entry was deleted. */
  assert.deepEqual(mergeValueRecord({}, existing, "env"), {});
  assert.throws(() => mergeValueRecord({ NEW: "" }, { OLD: "x" }, "env"), (error) => error.code === "INVALID_INPUT");

  const stored = validateServerInput({ serverName: "s", transport: "streamable-http", url: "https://s.example/mcp", headers: { Authorization: "Bearer stored" } });
  const merged = mergeServerValues(
    validateServerInput({ serverName: "s", transport: "streamable-http", url: "https://s.example/mcp", headers: { Authorization: "", "X-New": "new" } }),
    stored,
  );
  assert.deepEqual(merged.headers, { Authorization: "Bearer stored", "X-New": "new" });
});
