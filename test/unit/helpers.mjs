/**
 * Shared fakes for dsh-mcp-manager unit tests.
 *
 * Everything here is dependency-free: no Cordis, no DSH packages, no network.
 * The fakes model exactly the surface the production modules consume.
 */

/** Collecting logger. */
export function createLogger() {
  const lines = [];
  return {
    lines,
    info(message) {
      lines.push(`info: ${message}`);
    },
    warn(message) {
      lines.push(`warn: ${message}`);
    },
    error(message) {
      lines.push(`error: ${message}`);
    },
  };
}

/**
 * Build a fake Cordis-like context for the mount manager.
 *
 * @param options.failFor - server names whose plugin activation throws.
 */
export function createMountContext(options = {}) {
  const failFor = new Set(options.failFor ?? []);
  const calls = [];
  const fibers = [];
  const logger = createLogger();
  const ctx = {
    logger,
    async plugin(pluginModule, config) {
      calls.push({ pluginModule, config });
      if (failFor.has(config.serverName)) throw new Error(`activation failed for ${config.serverName}`);
      const fiber = {
        disposed: false,
        async dispose() {
          fiber.disposed = true;
        },
      };
      fibers.push(fiber);
      return fiber;
    },
  };
  return { ctx, calls, fibers, logger, bridgePlugin: { name: "mcp-client", apply() {} } };
}

/**
 * Build a fake manager bridge for the RPC dispatcher.
 * Every method records its arguments and returns a canned value.
 */
export function createRpcBridge(overrides = {}) {
  const calls = [];
  const record = (method, args) => calls.push({ method, args });
  const bridge = {
    async state() {
      record("state", []);
      return { version: 2, servers: [], status: {} };
    },
    async addServer(input) {
      record("addServer", [input]);
      return { serverName: input.serverName };
    },
    async updateServer(input) {
      record("updateServer", [input]);
      return { serverName: input.serverName };
    },
    async removeServer(serverName) {
      record("removeServer", [serverName]);
      return { removed: true };
    },
    async toggleServer(serverName, enabled) {
      record("toggleServer", [serverName, enabled]);
      return { enabled };
    },
    async testServer(input) {
      record("testServer", [input]);
      return { ok: true, latencyMs: 5, tools: [] };
    },
    async importServers(input) {
      record("importServers", [input]);
      return { added: [], skipped: [], warnings: [] };
    },
    async importTest(input) {
      record("importTest", [input]);
      return { results: [], parseErrors: [], skipped: [] };
    },
    async status() {
      record("status", []);
      return {};
    },
    ...overrides,
  };
  return { bridge, calls };
}

/** A minimal owner peer. */
export const OWNER_PEER = { principal: { kind: "owner" } };
