/**
 * Bridge mounting for dsh-mcp-manager.
 *
 * Each enabled server is mounted as one `@deepseek-ai/dsh-mcp-client` child
 * plugin: `await ctx.plugin(mcpClientPlugin, bridgeConfig)`. The child's
 * `failOnStartupError: false` means an unreachable server does not reject the
 * mount; the bridge logs and retries while the manager keeps the entry mounted.
 *
 * The manager owns the mounts and diffs them against the manifest:
 *
 * - a changed spec unmounts the old bridge and mounts the new one in place;
 * - a removed or disabled server unmounts;
 * - `env:NAME` resolution failures are recorded as `lastError` on the server,
 *   logged, and never thrown into the host or into an unrelated mutation;
 * - a server whose name is also configured by the host
 *   (`@deepseek-ai/dsh-mcp-client` loader row) is never mounted: the bridge
 *   would reject the duplicate namespace. The conflict is recorded and exposed
 *   through `conflict()`.
 *
 * All mutations are serialized through one promise chain so two manifest edits
 * cannot interleave a dispose/mount pair for the same server.
 *
 * The module is dependency-free (the bridge plugin is injected), which keeps it
 * unit-testable with a fake Cordis context.
 *
 * @module dsh-mcp-manager/mount
 */
import { bridgeConfigFor, specSignature } from "./manifest.js";

/**
 * Create one mount manager.
 *
 * @param options.ctx - plugin context (`ctx.plugin` owner).
 * @param options.bridgePlugin - the imported `@deepseek-ai/dsh-mcp-client` module.
 * @param options.logger - host logger (best-effort).
 * @param options.env - environment source for `env:` resolution.
 * @param options.defaultToolCallTimeoutMs - fallback per-server timeout.
 * @param options.resolveSpec - async hook that resolves stored header/env
 *   references before the bridge config is built. A rejection is
 *   recorded as `lastError` and never thrown into the host.
 * @returns the mount manager.
 */
export function createMountManager(options) {
  const { ctx, bridgePlugin, logger, env = process.env } = options;
  const defaultToolCallTimeoutMs = options.defaultToolCallTimeoutMs;
  const resolveSpec = typeof options.resolveSpec === "function" ? options.resolveSpec : undefined;
  /** serverName -> { fiber, signature } */
  const mounts = new Map();
  /** serverName -> string */
  const errors = new Map();
  /** serverName -> 'host' for names the host already mounts itself */
  const conflicts = new Map();
  /** Serialized mutation chain. */
  let chain = Promise.resolve();

  /** Run one mutation after every earlier mutation settled. */
  function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Record one error for a server, log it once, and return its message. */
  function recordError(serverName, error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.set(serverName, message);
    try {
      logger?.warn?.(`mcp-manager: ${serverName}: ${message}`);
    } catch {
      /* host logging is best-effort */
    }
    return message;
  }

  /** Unmount one server, tolerating a dispose failure. */
  async function unmountNow(serverName) {
    const entry = mounts.get(serverName);
    mounts.delete(serverName);
    if (entry === undefined) return;
    try {
      await entry.fiber.dispose();
    } catch (error) {
      try {
        logger?.warn?.(`mcp-manager: unmounting "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Record a host/manager name conflict for one server. */
  function recordConflict(serverName) {
    conflicts.set(serverName, "host");
    const message = `与宿主已配置的 MCP server "${serverName}" 同名（@deepseek-ai/dsh-mcp-client loader row）；manager 跳过挂载以避免重复注册`;
    errors.set(serverName, message);
    try {
      logger?.warn?.(`mcp-manager: ${message}`);
    } catch {
      /* host logging is best-effort */
    }
    return message;
  }

  /** Mount one canonical spec, replacing any stale mount for that name. */
  async function mountNow(spec, signature, conflictNames) {
    const existing = mounts.get(spec.serverName);
    if (conflictNames?.has(spec.serverName) === true) {
      await unmountNow(spec.serverName);
      const message = recordConflict(spec.serverName);
      return { mounted: false, error: message, conflict: "host" };
    }
    conflicts.delete(spec.serverName);
    if (existing !== undefined && existing.signature === signature) return { mounted: true, error: null };
    await unmountNow(spec.serverName);
    if (spec.enabled === false) return { mounted: false, error: null };
    let prepared = spec;
    if (resolveSpec !== undefined) {
      try {
        prepared = await resolveSpec(spec);
      } catch (error) {
        const message = recordError(spec.serverName, error);
        return { mounted: false, error: message, code: error?.code };
      }
    }
    let config;
    try {
      config = bridgeConfigFor(prepared, { env, defaultToolCallTimeoutMs });
    } catch (error) {
      const message = recordError(spec.serverName, error);
      return { mounted: false, error: message, code: error?.code };
    }
    try {
      const fiber = await ctx.plugin(bridgePlugin, config);
      mounts.set(spec.serverName, { fiber, signature });
      errors.delete(spec.serverName);
      return { mounted: true, error: null };
    } catch (error) {
      const message = recordError(spec.serverName, error);
      return { mounted: false, error: message };
    }
  }

  return {
    /**
     * Mount one spec if needed (replacing a stale mount for the same name).
     * Never throws for an env/config/mount failure: the error is recorded.
     * @returns `{ mounted, error }`.
     */
    async mount(spec, options = {}) {
      return exclusive(() => mountNow(spec, specSignature(spec), options.conflicts));
    },

    /** Unmount one server. */
    async unmount(serverName) {
      return exclusive(async () => {
        await unmountNow(serverName);
        errors.delete(serverName);
      });
    },

    /**
     * Reconcile the mounts against the current registry: mount every changed
     * enabled server, unmount disabled/removed ones. Returns one result per
     * server that had work to do.
     *
     * @param servers - canonical specs in manifest order.
     * @param options.conflicts - set of server names the host already mounts; those
     *   specs are recorded as conflicts and never mounted.
     * @returns `{ mounted: string[], unmounted: string[], failed: {serverName, error}[], conflicts: string[] }`.
     */
    async sync(servers, options = {}) {
      return exclusive(async () => {
        const conflictNames = options.conflicts;
        const wanted = new Map();
        for (const spec of servers) wanted.set(spec.serverName, spec);
        const mounted = [];
        const unmounted = [];
        const failed = [];
        const conflicted = [];
        for (const serverName of [...mounts.keys()]) {
          const spec = wanted.get(serverName);
          if (spec === undefined || spec.enabled === false) {
            await unmountNow(serverName);
            if (spec === undefined) {
              errors.delete(serverName);
              conflicts.delete(serverName);
            }
            unmounted.push(serverName);
          }
        }
        /* Forget conflicts for names that are gone from the registry. */
        for (const serverName of [...conflicts.keys()]) {
          if (!wanted.has(serverName) || conflictNames?.has(serverName) !== true) conflicts.delete(serverName);
        }
        for (const spec of servers) {
          const signature = specSignature(spec);
          const isConflict = conflictNames?.has(spec.serverName) === true;
          if (isConflict) {
            await unmountNow(spec.serverName);
            const message = recordConflict(spec.serverName);
            conflicted.push(spec.serverName);
            failed.push({ serverName: spec.serverName, error: message });
            continue;
          }
          if (spec.enabled === false) {
            errors.delete(spec.serverName);
            continue;
          }
          const existing = mounts.get(spec.serverName);
          if (existing !== undefined && existing.signature === signature) continue;
          const result = await mountNow(spec, signature, conflictNames);
          if (result.mounted) mounted.push(spec.serverName);
          else if (result.error !== null) failed.push({ serverName: spec.serverName, error: result.error });
        }
        return { mounted, unmounted, failed, conflicts: conflicted };
      });
    },

    /** Whether a server currently has a live bridge fiber. */
    isMounted(serverName) {
      return mounts.has(serverName);
    },

    /** Last mount failure for one server, or null. */
    lastError(serverName) {
      return errors.get(serverName) ?? null;
    },

    /** Drop one remembered error (e.g. after the server was removed). */
    clearError(serverName) {
      errors.delete(serverName);
    },

    /** `'host'` when the host already mounts this name and the manager skips it. */
    conflict(serverName) {
      return conflicts.get(serverName) ?? null;
    },

    /** Dispose every mount, for plugin teardown. */
    async disposeAll() {
      return exclusive(async () => {
        const names = [...mounts.keys()];
        await Promise.allSettled(names.map((serverName) => unmountNow(serverName)));
        errors.clear();
        conflicts.clear();
      });
    },
  };
}
