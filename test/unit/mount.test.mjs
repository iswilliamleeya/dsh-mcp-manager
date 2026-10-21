/**
 * Unit tests for bridge mounting: config translation, env resolution failures,
 * reconciliation and lastError bookkeeping.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateServerInput } from "../../lib/manifest.js";
import { createMountManager } from "../../lib/mount.js";
import { createMountContext } from "./helpers.mjs";

const STDIO = {
  serverName: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "server-github"],
  env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
  cwd: "/tmp/work",
  toolCallTimeoutMs: 1234,
};

const HTTP = {
  serverName: "remote",
  transport: "streamable-http",
  url: "https://example.com/mcp",
  headers: { Authorization: "env:MCP_TOKEN" },
};

/** Build a mount manager over a fake context. */
function harness(t, options = {}) {
  const world = createMountContext({ failFor: options.failFor });
  const manager = createMountManager({
    ctx: world.ctx,
    bridgePlugin: world.bridgePlugin,
    logger: world.logger,
    env: options.env ?? { GITHUB_TOKEN: "gh-token", MCP_TOKEN: "remote-token" },
    defaultToolCallTimeoutMs: 60000,
  });
  t.after(() => manager.disposeAll());
  return { ...world, manager };
}

test("mount translates a stdio spec into the bridge contract and resolves env", async (t) => {
  const { manager, calls } = harness(t);
  const spec = validateServerInput(STDIO);
  const result = await manager.mount(spec);

  assert.deepEqual(result, { mounted: true, error: null });
  assert.equal(manager.isMounted("github"), true);
  assert.equal(manager.lastError("github"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginModule.name, "mcp-client");
  assert.deepEqual(calls[0].config, {
    serverName: "github",
    toolCallTimeoutMs: 1234,
    failOnStartupError: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "server-github"],
    env: { GITHUB_TOKEN: "gh-token" },
    cwd: "/tmp/work",
  });
});

test("mount translates a streamable-http spec and resolves header credentials", async (t) => {
  const { manager, calls } = harness(t);
  const result = await manager.mount(validateServerInput(HTTP));
  assert.deepEqual(result, { mounted: true, error: null });
  assert.deepEqual(calls[0].config, {
    serverName: "remote",
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: "remote-token" },
  });
});

test("a missing env: variable records lastError instead of throwing", async (t) => {
  const { manager, calls, logger } = harness(t, { env: {} });
  const spec = validateServerInput(STDIO);
  const result = await manager.mount(spec);

  assert.equal(result.mounted, false);
  assert.match(result.error, /GITHUB_TOKEN/);
  assert.equal(manager.isMounted("github"), false);
  assert.match(manager.lastError("github"), /not set for the host process/);
  assert.equal(calls.length, 0, "no bridge plugin may be mounted without credentials");
  assert.match(logger.lines.join("\n"), /GITHUB_TOKEN/);
});

test("a failing bridge activation records lastError instead of throwing", async (t) => {
  const { manager } = harness(t, { failFor: ["broken"] });
  const result = await manager.mount(validateServerInput({ serverName: "broken", transport: "stdio", command: "x" }));
  assert.equal(result.mounted, false);
  assert.match(result.error, /activation failed/);
  assert.equal(manager.isMounted("broken"), false);
  assert.match(manager.lastError("broken"), /activation failed/);
});

test("a disabled spec is not mounted", async (t) => {
  const { manager, calls } = harness(t);
  const result = await manager.mount(validateServerInput({ serverName: "off", transport: "stdio", command: "x", enabled: false }));
  assert.deepEqual(result, { mounted: false, error: null });
  assert.equal(manager.isMounted("off"), false);
  assert.equal(calls.length, 0);
});

test("mounting the same unchanged spec twice is a no-op", async (t) => {
  const { manager, calls } = harness(t);
  const spec = validateServerInput(STDIO);
  await Promise.all([manager.mount(spec), manager.mount(spec)]);
  assert.equal(calls.length, 1);
});

test("sync mounts enabled servers, skips disabled ones and unmounts removed ones", async (t) => {
  const { manager, calls, fibers } = harness(t);
  const a = validateServerInput({ serverName: "a", transport: "stdio", command: "node" });
  const b = validateServerInput({ serverName: "b", transport: "stdio", command: "node", enabled: false });
  const c = validateServerInput({ serverName: "c", transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "env:MCP_TOKEN" } });

  let result = await manager.sync([a, b, c]);
  assert.deepEqual(result.mounted.sort(), ["a", "c"]);
  assert.deepEqual(result.failed, []);
  assert.equal(manager.isMounted("b"), false);

  /* Remove `c`, disable `a`, add `d`: only the delta is touched. */
  const d = validateServerInput({ serverName: "d", transport: "stdio", command: "node" });
  const aOff = validateServerInput({ serverName: "a", transport: "stdio", command: "node", enabled: false });
  result = await manager.sync([aOff, d]);
  assert.deepEqual(result.mounted, ["d"]);
  assert.deepEqual(result.unmounted.sort(), ["a", "c"]);
  assert.equal(manager.isMounted("a"), false);
  assert.equal(manager.isMounted("d"), true);
  assert.equal(fibers.filter((fiber) => fiber.disposed).length, 2);
});

test("changing a spec remounts in place and clears the previous error", async (t) => {
  const { manager, calls } = harness(t);
  const first = validateServerInput(HTTP);
  await manager.mount(first);
  assert.equal(calls.length, 1);

  const changed = validateServerInput({ ...HTTP, url: "https://example.com/other" });
  const result = await manager.mount(changed);
  assert.equal(result.mounted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].config.url, "https://example.com/other");
  assert.equal(manager.lastError("remote"), null);
});

test("sync reports every mount failure and keeps the other servers mounted", async (t) => {
  const { manager } = harness(t, { failFor: ["bad"] });
  const good = validateServerInput({ serverName: "good", transport: "stdio", command: "node" });
  const bad = validateServerInput({ serverName: "bad", transport: "stdio", command: "node" });
  const result = await manager.sync([good, bad]);
  assert.deepEqual(result.mounted, ["good"]);
  assert.deepEqual(result.failed.map((failure) => failure.serverName), ["bad"]);
  assert.equal(manager.isMounted("good"), true);
  assert.match(manager.lastError("bad"), /activation failed/);
});

test("enable/disable through sync unmounts and remounts", async (t) => {
  const { manager, calls } = harness(t);
  const on = validateServerInput({ serverName: "s", transport: "stdio", command: "node" });
  await manager.sync([on]);
  assert.equal(calls.length, 1);

  await manager.sync([{ ...on, enabled: false }]);
  assert.equal(manager.isMounted("s"), false);

  await manager.sync([{ ...on, enabled: true }]);
  assert.equal(manager.isMounted("s"), true);
  assert.equal(calls.length, 2);
});

test("unmount lifts the mount and forgets the error", async (t) => {
  const { manager, fibers } = harness(t);
  await manager.mount(validateServerInput(STDIO));
  await manager.unmount("github");
  assert.equal(manager.isMounted("github"), false);
  assert.equal(manager.lastError("github"), null);
  assert.equal(fibers[0].disposed, true);
});

test("disposeAll disposes every mount", async (t) => {
  const { manager, fibers } = harness(t);
  await manager.sync([
    validateServerInput({ serverName: "a", transport: "stdio", command: "node" }),
    validateServerInput({ serverName: "b", transport: "stdio", command: "node" }),
  ]);
  assert.equal(fibers.length, 2);
  await manager.disposeAll();
  assert.equal(manager.isMounted("a"), false);
  assert.equal(manager.isMounted("b"), false);
  assert.equal(fibers.every((fiber) => fiber.disposed), true);
});

test("sync never mounts a server whose name the host already configures", async (t) => {
  const { manager, calls } = harness(t);
  const conflicted = validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://flomoapp.com/mcp" });
  const free = validateServerInput({ serverName: "free", transport: "stdio", command: "node" });

  const result = await manager.sync([conflicted, free], { conflicts: new Set(["flomo"]) });

  assert.deepEqual(result.conflicts, ["flomo"]);
  assert.deepEqual(result.mounted, ["free"]);
  assert.deepEqual(result.failed.map((failure) => failure.serverName), ["flomo"]);
  assert.equal(manager.isMounted("flomo"), false, "the bridge must not receive a duplicate serverName");
  assert.equal(manager.isMounted("free"), true);
  assert.equal(manager.conflict("flomo"), "host");
  assert.equal(manager.conflict("free"), null);
  assert.match(manager.lastError("flomo"), /同名/);
  assert.equal(calls.length, 1, "only the free server was handed to the bridge");
  assert.equal(calls[0].config.serverName, "free");
});

test("an already-mounted server is unmounted when it becomes a host conflict", async (t) => {
  const { manager, fibers } = harness(t);
  const spec = validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://flomoapp.com/mcp" });
  await manager.sync([spec]);
  assert.equal(manager.isMounted("flomo"), true);
  assert.equal(fibers.length, 1);

  await manager.sync([spec], { conflicts: new Set(["flomo"]) });
  assert.equal(manager.isMounted("flomo"), false);
  assert.equal(fibers[0].disposed, true);
  assert.equal(manager.conflict("flomo"), "host");
});

test("the conflict clears when the host row disappears and the server mounts again", async (t) => {
  const { manager } = harness(t);
  const spec = validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://flomoapp.com/mcp" });
  await manager.sync([spec], { conflicts: new Set(["flomo"]) });
  assert.equal(manager.conflict("flomo"), "host");
  assert.equal(manager.isMounted("flomo"), false);

  await manager.sync([spec]);
  assert.equal(manager.conflict("flomo"), null);
  assert.equal(manager.isMounted("flomo"), true);
  assert.equal(manager.lastError("flomo"), null);
});

test("mount(spec, { conflicts }) refuses a conflicting server without activating the bridge", async (t) => {
  const { manager, calls } = harness(t);
  const spec = validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://flomoapp.com/mcp" });
  const result = await manager.mount(spec, { conflicts: new Set(["flomo"]) });
  assert.equal(result.mounted, false);
  assert.match(result.error, /同名/);
  assert.equal(calls.length, 0);
  assert.equal(manager.conflict("flomo"), "host");
});

test("disposeAll clears recorded conflicts", async (t) => {
  const { manager } = harness(t);
  const spec = validateServerInput({ serverName: "flomo", transport: "streamable-http", url: "https://flomoapp.com/mcp" });
  await manager.sync([spec], { conflicts: new Set(["flomo"]) });
  assert.equal(manager.conflict("flomo"), "host");
  await manager.disposeAll();
  assert.equal(manager.conflict("flomo"), null);
});

test("resolveSpec hook resolves references before the bridge config and records failures", async (t) => {
  const world = createMountContext();
  const manager = createMountManager({
    ctx: world.ctx,
    bridgePlugin: world.bridgePlugin,
    logger: world.logger,
    env: {},
    defaultToolCallTimeoutMs: 60000,
    resolveSpec: async (spec) => {
      if (spec.serverName === "broken-secret") {
        throw Object.assign(new Error("mcp-manager: credential resolution failed"), { code: "CREDENTIAL_MISSING" });
      }
      return { ...spec, headers: { Authorization: "Bearer resolved-secret" } };
    },
  });
  t.after(() => manager.disposeAll());

  const ok = validateServerInput({
    serverName: "with-secret",
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: "env:TOKEN" },
  });
  const result = await manager.mount(ok);
  assert.deepEqual(result, { mounted: true, error: null });
  assert.deepEqual(world.calls[0].config.headers, { Authorization: "Bearer resolved-secret" });

  const broken = validateServerInput({
    serverName: "broken-secret",
    transport: "streamable-http",
    url: "https://example.com/mcp",
  });
  const failed = await manager.mount(broken);
  assert.equal(failed.mounted, false);
  assert.equal(failed.code, "CREDENTIAL_MISSING");
  assert.match(manager.lastError("broken-secret"), /credential resolution failed/);
  assert.equal(world.calls.length, 1, "a resolution failure must not reach the bridge");
});
