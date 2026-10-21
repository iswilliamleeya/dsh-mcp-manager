/**
 * dsh-mcp-manager — host half.
 *
 * One plugin that owns the profile-wide MCP registry, mounts enabled servers
 * through the in-box bridge (`@deepseek-ai/dsh-mcp-client`), discovers the MCP
 * servers the host already mounts, probes connectivity, and serves the native
 * Desktop page over a same-origin `/mcp-manager` RPC channel.
 *
 * Layers (all dependency-injected so they stay unit-testable):
 *
 * - `manifest.js` — manifest v2 persistence, strict validation, atomic 0600 write.
 * - `mount.js` — bridge mount/unmount/reconcile + `lastError`.
 * - `external.js` — read-only discovery of host-configured MCP loader rows.
 * - `probe.js` — independent SDK connectivity test.
 * - `rpc.js` — endpoint dispatch for the Desktop page.
 *
 * @module dsh-mcp-manager
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  MANIFEST_VERSION,
  TRANSPORTS,
  emptyManifest,
  manifestPathFor,
  loadManifestFile,
  writeManifest,
  validateServerInput,
  countToolsByServer,
  mergeServerValues,
  resolveSpecValues,
} from "./manifest.js";
import {
  discoverExternalServers,
  externalStatus,
  externalTestSpec,
  mergeStateRows,
} from "./external.js";
import {
  convertMcpServersText,
  mergeImportedServers,
  prepareImportedServers,
  runImportTest,
} from "./import.js";
import { createMountManager } from "./mount.js";
import { createManagerRpcHandler } from "./rpc.js";
import { closeClientQuietly, openClient, probeServer, withTimeout } from "./probe.js";

/** Stable Loader identity. */
const name = "mcp-manager";

/** Services this plugin consumes. */
const inject = ["tools"];

/** Cap for text returned to the model, in characters. */
const MAX_TEXT_CHARS = 12000;

/** RPC route prefix for the native Desktop page. */
const RPC_PATH = "/mcp-manager";

/** Maximum accepted RPC request body. */
const MAX_RPC_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Plugin config. Every field is optional: the manager works with its defaults.
 */
const Config = z.object({
  /** Manifest path override; empty means `$DSH_HOME/mcp-manager.json`. */
  manifestFile: z.string().default(""),
  /** Mount every enabled server while the plugin loads. */
  autoMount: z.boolean().default(true),
  /** Default per-tool-call timeout handed to the bridge. */
  defaultToolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  /** Timeout for the manager's own probe/call requests, in milliseconds. */
  probeTimeoutMs: z.number().default(60000),
});

/** Build an Error carrying an RPC error code. */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Map a secret-resolution failure onto the probe error classes. */
function classifySecretError(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "CREDENTIAL_MISSING" || code === "CREDENTIAL_UNAVAILABLE" || code === "CREDENTIAL_RESOLVE_FAILED") return "auth";
  if (code === "ENV_MISSING") return "transport";
  return "unknown";
}

/** Clamp one string for the model-facing result. */
function clamp(text) {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated, ${text.length} chars total)`;
}

/**
 * Project ordered MCP content blocks into text, mirroring the in-box bridge's
 * native presentation so a programmatic call reports what the model would see.
 * @param content - the MCP result's content array, untrusted.
 * @param serverName - owning server, for the actionable hint.
 * @param toolName - raw tool name, for the empty-result message.
 * @returns the model-facing text projection.
 */
function projectMcpContent(content, serverName, toolName) {
  const lines = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      lines.push("[unsupported MCP content block: expected an object]");
      continue;
    }
    switch (block.type) {
      case "text":
        if (block.text !== undefined) lines.push(String(block.text));
        break;
      case "image":
        lines.push(`[image result: ${block.mimeType ?? "unknown media type"}; call the mounted tool mcp__${serverName}__${toolName} to see it, or consume the raw block in this result's content]`);
        break;
      case "resource_link":
        if (block.name === undefined || block.uri === undefined) lines.push("[resource link unavailable: the MCP block is missing its name or URI]");
        else lines.push(`Resource link: ${block.name} (${block.uri})`);
        break;
      case "audio":
        lines.push(`[audio result unsupported: ${block.mimeType ?? "unknown media type"}; raw audio data remains available in this result's content]`);
        break;
      case "resource":
        lines.push("[embedded resource unsupported; the raw resource block remains available in this result's content]");
        break;
      default:
        lines.push(`[unsupported MCP content type: ${String(block.type)}]`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : `(${toolName} returned no model-visible content)`;
}

/**
 * Runtime state for one plugin instance: the persisted registry, the bridge
 * mounts, and the manager's own inspection clients.
 */
class Manager {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.file = manifestPathFor(config, resolveDshHome());
    this.manifest = emptyManifest();
    this.warnings = [];
    this.loadError = null;
    /** Optional Loader service injected later by `apply`. */
    this.loaderService = null;
    /** Whether the loader-unavailable degradation was already logged. */
    this.loaderUnavailableLogged = false;
    /** External-discovery warnings already logged (state re-enumerates every poll). */
    this.externalWarned = new Set();
    /** Optional credentials service for `credential:` references. */
    this.credentialsService = null;
    this.mounts = createMountManager({
      ctx,
      bridgePlugin: McpClient,
      logger: ctx.logger,
      env: process.env,
      defaultToolCallTimeoutMs: config.defaultToolCallTimeoutMs,
      resolveSpec: (spec) => this.resolveSpec(spec),
    });
    /** serverName -> { signature, promise: Promise<{client, transport}> } */
    this.toolClients = new Map();
    /** Serializes manifest mutations. */
    this.chain = Promise.resolve();
    /** Set once plugin teardown starts; async follow-ups must not revive mounts. */
    this.disposed = false;
  }

  /** Load the manifest, degrading to an empty registry on a broken file. */
  load() {
    try {
      const loaded = loadManifestFile(this.file);
      this.manifest = loaded.manifest;
      this.warnings = loaded.warnings ?? [];
      this.loadError = null;
      for (const warning of this.warnings) this.logWarn(warning);
      if (loaded.cleanedLegacyFields.length > 0) {
        this.logWarn(`removed legacy workspace-scoping fields from the manifest (${loaded.cleanedLegacyFields.join(", ")})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadError = message;
      this.manifest = emptyManifest();
      this.warnings = [];
      this.logWarn(`${message} — starting with an empty MCP registry; the file is left untouched until the next change`);
    }
  }

  /** Best-effort host logging. */
  logWarn(message) {
    try {
      this.ctx.logger?.warn?.(`mcp-manager: ${message}`);
    } catch {
      /* host logging is best-effort */
    }
  }

  /** Run one mutation after every earlier mutation settled. */
  exclusive(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Find one canonical spec by server name. */
  spec(serverName) {
    return this.manifest.servers.find((server) => server.serverName === serverName);
  }

  /** Replace or append one spec, preserving registry order. */
  put(spec) {
    const index = this.manifest.servers.findIndex((server) => server.serverName === spec.serverName);
    if (index === -1) this.manifest.servers.push(spec);
    else this.manifest.servers[index] = spec;
  }

  /** Drop one spec. */
  drop(serverName) {
    this.manifest.servers = this.manifest.servers.filter((server) => server.serverName !== serverName);
  }

  /** Persist the current registry. */
  save() {
    writeManifest(this.file, this.manifest);
  }

  /**
   * Resolve one spec's header/env values for the bridge/probe/self-client.
   *
   * Value resolution: `env:NAME` reads the host environment,
   * `credential:NAME` asks the credentials service, everything else is the
   * plaintext value. Failures carry `ENV_MISSING`/`CREDENTIAL_*` codes and are
   * recorded as a mount `lastError` rather than crashing the host.
   *
   * @param spec - canonical stored spec.
   * @returns the resolved spec.
   */
  async resolveSpec(spec) {
    return resolveSpecValues(spec, {
      env: process.env,
      credentials: this.credentialsService ?? undefined,
    });
  }

  /** Resolve the Loader service, preferring the injected reference. */
  loader() {
    if (this.loaderService !== null && this.loaderService !== undefined) return this.loaderService;
    try {
      const direct = this.ctx.get?.("loader");
      if (direct !== undefined && direct !== null) this.loaderService = direct;
      return direct ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Discover the MCP servers the host already mounts through
   * `@deepseek-ai/dsh-mcp-client` loader rows. Called on every `state` RPC and
   * once during apply; a missing Loader degrades to an empty list with one log.
   *
   * @returns `{ servers, warnings }`.
   */
  discoverExternal() {
    const loader = this.loader();
    if (loader === null) {
      if (!this.loaderUnavailableLogged) {
        this.loaderUnavailableLogged = true;
        this.logWarn("Loader service is unavailable; host-configured MCP servers cannot be discovered (showing manager entries only)");
      }
      return { servers: [], warnings: [] };
    }
    let entries;
    try {
      entries = typeof loader.entries === "function" ? loader.entries() : loader;
    } catch (error) {
      const message = `enumerating Loader entries failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logWarn(message);
      return { servers: [], warnings: [message] };
    }
    const discovered = discoverExternalServers(entries);
    for (const warning of discovered.warnings) {
      if (this.externalWarned.has(warning)) continue;
      this.externalWarned.add(warning);
      this.logWarn(warning);
    }
    return discovered;
  }

  /** Map of host-configured serverName -> descriptor. */
  externalIndex() {
    return new Map(this.discoverExternal().servers.map((server) => [server.serverName, server]));
  }

  /** Server names whose manager entry collides with a host-configured row. */
  conflictNames(externalServers = this.discoverExternal().servers) {
    const hostNames = new Set(externalServers.map((server) => server.serverName));
    return new Set(this.manifest.servers.filter((spec) => hostNames.has(spec.serverName)).map((spec) => spec.serverName));
  }

  /** Live global tool names (the only names `restrict` may mention). */
  toolNames() {
    try {
      const schemas = this.ctx.tools.schemas();
      return Array.isArray(schemas) ? schemas.map((schema) => schema.name).filter((toolName) => typeof toolName === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * `ServerStatus` record covering manager entries and host-configured rows.
   *
   * - manager entry: bridge mount liveness + last mount error;
   * - host row: Loader row liveness, no mount error;
   * - conflicting name: the host row is what runs, and `conflict: 'host'` is
   *   reported on both the status record and the manager view.
   */
  statusMap(externalServers = this.discoverExternal().servers) {
    const externalByName = new Map(externalServers.map((server) => [server.serverName, server]));
    const names = [
      ...this.manifest.servers.map((server) => server.serverName),
      ...externalServers.filter((server) => this.spec(server.serverName) === undefined).map((server) => server.serverName),
    ];
    const counts = countToolsByServer(this.toolNames(), names);
    const status = {};
    for (const server of this.manifest.servers) {
      const name = server.serverName;
      const host = externalByName.get(name);
      if (host !== undefined) {
        status[name] = {
          mounted: host.active === true,
          toolCount: counts.get(name) ?? 0,
          lastError: this.mounts.lastError(name) ?? `与宿主配置同名（entry ${host.entryId}），manager 未挂载`,
          conflict: "host",
        };
        continue;
      }
      status[name] = {
        mounted: this.mounts.isMounted(name),
        toolCount: counts.get(name) ?? 0,
        lastError: this.mounts.lastError(name),
      };
    }
    for (const server of externalServers) {
      if (this.spec(server.serverName) !== undefined) continue;
      status[server.serverName] = externalStatus(server, counts.get(server.serverName) ?? 0);
    }
    return status;
  }

  /** The `state` RPC value. Manager rows and host rows are merged by name. */
  state() {
    const external = this.discoverExternal();
    const merged = mergeStateRows({
      managerServers: this.manifest.servers,
      externalServers: external.servers,
    });
    const value = {
      version: MANIFEST_VERSION,
      servers: merged.servers,
      status: this.statusMap(external.servers),
    };
    if (this.loadError !== null) value.loadError = this.loadError;
    const warnings = [...this.warnings, ...external.warnings];
    if (warnings.length > 0) value.warnings = warnings;
    return value;
  }

  /**
   * Reconcile mounts after a registry change.
   *
   * A manager entry whose name is also configured by the host is never mounted
   * (the bridge would reject the duplicate namespace); `sync` records the
   * conflict and this method surfaces it as `lastError` through status.
   */
  async afterChange() {
    if (this.disposed) return { mounted: [], unmounted: [], failed: [], conflicts: [] };
    const external = this.discoverExternal().servers;
    const result = await this.mounts.sync(this.manifest.servers, { conflicts: this.conflictNames(external) });
    for (const failure of result.failed) this.logWarn(`mounting "${failure.serverName}" failed: ${failure.error}`);
    return result;
  }

  /** Add one server. */
  async addServer(input) {
    return this.exclusive(async () => {
      const spec = validateServerInput(input, { defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs });
      const host = this.externalIndex().get(spec.serverName);
      if (host !== undefined) {
        throw codedError("EXISTS_HOST_CONFIG", `server "${spec.serverName}" is already configured by the host (@deepseek-ai/dsh-mcp-client, entry ${host.entryId}); the manager will not add a duplicate`);
      }
      if (this.spec(spec.serverName) !== undefined) {
        throw codedError("DUPLICATE_SERVER", `server "${spec.serverName}" already exists — use server.update to edit it`);
      }
      this.put(mergeServerValues(spec, undefined));
      this.save();
      await this.afterChange();
      return { serverName: spec.serverName };
    });
  }

  /** Update one existing server, identified by serverName. */
  async updateServer(input) {
    const target = typeof input?.serverName === "string" ? input.serverName.trim() : undefined;
    const host = target === undefined ? undefined : this.externalIndex().get(target);
    if (host !== undefined) {
      throw codedError("EXTERNAL_READONLY", `server "${host.serverName}" comes from the host config (@deepseek-ai/dsh-mcp-client, entry ${host.entryId}) and is read-only; edit the profile patch file instead`);
    }
    return this.exclusive(async () => {
      const existing = typeof input?.serverName === "string" ? this.spec(input.serverName) : undefined;
      if (existing === undefined) throw codedError("UNKNOWN_SERVER", `unknown server ${JSON.stringify(input?.serverName)}`);
      const spec = validateServerInput(input, { defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs });
      /* An empty value in the form means "keep the stored value"; a brand-new
         empty entry is an input error (checked by mergeServerValues). */
      await this.dropClient(spec.serverName);
      this.put(mergeServerValues(spec, existing));
      this.save();
      await this.afterChange();
      return { serverName: spec.serverName };
    });
  }

  /** Remove one server. */
  async removeServer(serverName) {
    const host = this.externalIndex().get(serverName);
    if (host !== undefined) {
      throw codedError("EXTERNAL_READONLY", `server "${serverName}" comes from the host config (@deepseek-ai/dsh-mcp-client, entry ${host.entryId}) and cannot be removed here; edit the profile patch file instead`);
    }
    return this.exclusive(async () => {
      const spec = this.spec(serverName);
      if (spec === undefined) throw codedError("UNKNOWN_SERVER", `unknown server ${JSON.stringify(serverName)}`);
      await this.mounts.unmount(serverName);
      await this.dropClient(serverName);
      this.drop(serverName);
      this.save();
      await this.afterChange();
      return { removed: true };
    });
  }

  /** Enable or disable one server. */
  async toggleServer(serverName, enabled) {
    const host = this.externalIndex().get(serverName);
    if (host !== undefined) {
      throw codedError("EXTERNAL_READONLY", `server "${serverName}" comes from the host config (@deepseek-ai/dsh-mcp-client, entry ${host.entryId}) and cannot be enabled/disabled here; edit the profile patch file instead`);
    }
    return this.exclusive(async () => {
      const spec = this.spec(serverName);
      if (spec === undefined) throw codedError("UNKNOWN_SERVER", `unknown server ${JSON.stringify(serverName)}`);
      spec.enabled = enabled === true;
      if (!spec.enabled) {
        await this.mounts.unmount(serverName);
        await this.dropClient(serverName);
      }
      this.save();
      await this.afterChange();
      return { enabled: spec.enabled };
    });
  }

  /** Probe one stored or unsaved server (`server.test`). */
  async testServer(input) {
    /* A stored host row is tested with the host's own config; a payload with an
       explicit transport is always treated as a fresh, unsaved server. */
    const requested = typeof input?.serverName === "string" ? input.serverName.trim() : undefined;
    if (requested !== undefined && typeof input?.transport !== "string") {
      const host = this.externalIndex().get(requested);
      if (host !== undefined) {
        const prepared = externalTestSpec(host);
        if (prepared.error !== undefined) {
          return { ok: false, latencyMs: 0, tools: [], error: prepared.error };
        }
        return probeServer(prepared.spec, { timeoutMs: this.config.probeTimeoutMs, env: process.env });
      }
    }
    let spec;
    if (input !== null && typeof input === "object" && typeof input.transport === "string") {
      const validated = validateServerInput(input, { defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs });
      /* Blank secret entries in the form keep the stored secret (same merge
         rule as server.update), so testing an edited server needs no retyping. */
      spec = mergeServerValues(validated, this.spec(validated.serverName));
    } else {
      const serverName = input?.serverName;
      const stored = typeof serverName === "string" ? this.spec(serverName) : undefined;
      if (stored === undefined) throw codedError("UNKNOWN_SERVER", `server ${JSON.stringify(serverName)} does not exist and no transport was supplied`);
      spec = stored;
    }
    let resolved;
    try {
      resolved = await this.resolveSpec(spec);
    } catch (error) {
      return {
        ok: false,
        latencyMs: 0,
        tools: [],
        error: {
          code: classifySecretError(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const result = await probeServer(resolved, { timeoutMs: this.config.probeTimeoutMs, env: process.env });
    if (result.ok) return result;
    return { ...result, ok: false };
  }

  /** Rebuild one mount (or every enabled mount). */
  async reload(serverName) {
    return this.exclusive(async () => {
      const targets = serverName === undefined
        ? this.manifest.servers.filter((server) => server.enabled !== false).map((server) => server.serverName)
        : [serverName];
      const external = this.externalIndex();
      const conflicts = this.conflictNames([...external.values()]);
      const reloaded = [];
      const failed = [];
      for (const target of targets) {
        const host = external.get(target);
        if (host !== undefined) {
          failed.push(`${target}: 宿主配置的 server 为只读，不能 reload（entry ${host.entryId}；请编辑 profile patch 或重启宿主）`);
          continue;
        }
        const spec = this.spec(target);
        if (spec === undefined) {
          failed.push(`${target}: unknown server`);
          continue;
        }
        await this.mounts.unmount(target);
        await this.dropClient(target);
        const result = await this.mounts.mount(spec, { conflicts });
        if (result.mounted) reloaded.push(target);
        else failed.push(`${target}: ${result.error ?? "mount failed"}`);
      }
      return { reloaded, failed };
    });
  }

  /** Import servers already declared in a Cordis patch file. */
  async importPatch(file, dryRun) {
    return this.exclusive(async () => {
      const { parsePatchFile } = await import("./patch-import.js");
      const rows = parsePatchFile(file);
      const imported = [];
      const skipped = [];
      const hostNames = this.externalIndex();
      for (const row of rows) {
        try {
          const spec = validateServerInput(row, { defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs });
          if (hostNames.has(spec.serverName)) {
            skipped.push(`${spec.serverName}: 已由宿主配置（只读），无需导入`);
            continue;
          }
          this.put(mergeServerValues(spec, this.spec(spec.serverName)));
          imported.push(`${spec.serverName} (${spec.transport})`);
        } catch (error) {
          skipped.push(`${row?.serverName ?? "<unnamed>"}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (dryRun !== true && imported.length > 0) {
        this.save();
        await this.afterChange();
      }
      return { imported, skipped };
    });
  }

  /**
   * Import servers pasted as a JSON config (`server.import` RPC).
   *
   * Walks every entry through `validateServerInput`; an existing name is
   * skipped unless `replace` is true; one invalid entry never blocks the rest.
   * Only after the whole batch is merged does the registry persist and the
   * mounts reconcile, so a 10-server paste mounts once instead of ten times.
   *
   * @param input - `{ json: string, replace?: boolean, enabled?: boolean, toolCallTimeoutMs?: number }`.
   *   `enabled`/`toolCallTimeoutMs` are batch defaults: a pasted entry that
   *   declares the field itself wins, otherwise the batch value applies, and
   *   with neither the server is enabled and the plugin timeout is used.
   * @returns `{ added, skipped, warnings }`.
   */
  async importServers(input) {
    return this.exclusive(async () => {
      const converted = convertMcpServersText(input?.json);
      const defaults = {};
      if (input?.enabled !== undefined) defaults.enabled = input.enabled === true;
      if (input?.toolCallTimeoutMs !== undefined) defaults.toolCallTimeoutMs = input.toolCallTimeoutMs;
      const merged = mergeImportedServers({
        servers: converted.servers,
        existingNames: this.manifest.servers.map((server) => server.serverName),
        hostNames: [...this.externalIndex().keys()],
        replace: input?.replace === true,
        defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs,
        defaults,
      });
      const skipped = [
        ...converted.errors.map((entry) => ({ serverName: entry.serverName, reason: entry.reason })),
        ...merged.skipped,
      ];
      const imported = [];
      for (const { spec, replace } of merged.specs) {
        try {
          const merged = mergeServerValues(spec, this.spec(spec.serverName));
          if (replace) await this.dropClient(spec.serverName);
          this.put(merged);
          imported.push(spec.serverName);
        } catch (error) {
          skipped.push({
            serverName: spec.serverName,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const added = merged.added.filter((serverName) => imported.includes(serverName));
      if (imported.length > 0) {
        this.save();
        await this.afterChange();
      }
      return { added, skipped, warnings: converted.warnings };
    });
  }

  /**
   * `server.importTest` RPC: parse a pasted config and probe each server
   * independently without persisting or touching mounted connections.
   *
   * Batch defaults (`enabled`/`toolCallTimeoutMs`) apply exactly like
   * `server.import`; at most 10 servers are tested (the rest are returned in
   * `skipped`) and every server gets its own probe timeout.
   *
   * @param input - `{ json: string, enabled?: boolean, toolCallTimeoutMs?: number }`.
   * @returns `{ results, parseErrors, skipped }`.
   */
  async importTest(input) {
    const converted = convertMcpServersText(input?.json);
    const defaults = {};
    if (input?.enabled !== undefined) defaults.enabled = input.enabled === true;
    if (input?.toolCallTimeoutMs !== undefined) defaults.toolCallTimeoutMs = input.toolCallTimeoutMs;
    const prepared = prepareImportedServers({
      servers: converted.servers,
      defaults,
      defaultToolCallTimeoutMs: this.config.defaultToolCallTimeoutMs,
    });
    return runImportTest({
      converted,
      prepared,
      limit: 10,
      probe: (spec) => this.probeImportedSpec(spec),
    });
  }

  /**
   * Resolve one imported spec's values and probe it. Never throws: failures
   * become probe-shaped error results so one bad server cannot stop the batch.
   */
  async probeImportedSpec(spec) {
    try {
      const resolved = await this.resolveSpec(spec);
      return await probeServer(resolved, { timeoutMs: this.config.probeTimeoutMs, env: process.env });
    } catch (error) {
      return {
        ok: false,
        latencyMs: 0,
        tools: [],
        error: {
          code: classifySecretError(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** One inspection client per server, rebuilt when the spec changes. */
  clientFor(spec) {
    const signature = JSON.stringify(spec);
    const cached = this.toolClients.get(spec.serverName);
    if (cached !== undefined && cached.signature === signature) return cached.promise;
    if (cached !== undefined) void closeClientQuietly(cached.client).catch(() => {});
    const record = { signature, client: undefined, promise: null };
    record.promise = (async () => {
      const resolved = await this.resolveSpec(spec);
      return openClient(resolved, {
        env: process.env,
        timeoutMs: this.config.probeTimeoutMs,
        name: "dsh-mcp-manager",
        version: "0.2.0",
      });
    })().then((opened) => {
      record.client = opened.client;
      return opened;
    });
    record.promise.catch(() => {
      if (this.toolClients.get(spec.serverName) === record) this.toolClients.delete(spec.serverName);
    });
    this.toolClients.set(spec.serverName, record);
    return record.promise;
  }

  /** Close and forget one inspection client. */
  async dropClient(serverName) {
    const record = this.toolClients.get(serverName);
    this.toolClients.delete(serverName);
    if (record === undefined) return;
    try {
      const opened = await record.promise;
      await closeClientQuietly(opened.client);
    } catch {
      /* a client that never connected has nothing to close */
    }
  }

  /** Close every inspection client (teardown). */
  async closeAllClients() {
    const names = [...this.toolClients.keys()];
    await Promise.allSettled(names.map((serverName) => this.dropClient(serverName)));
  }
}

//#region model-facing tools

/** Structured summary of one status row, for model-facing text. */
function describeStatus(row) {
  const state = row.lastError !== null
    ? `error: ${row.lastError}`
    : row.mounted
      ? "mounted"
      : row.enabled
        ? "not mounted"
        : "disabled";
  return `- ${row.serverName} [${row.transport}] ${row.target} — ${state} (${row.toolCount} tool(s))`;
}

/**
 * Register every manager tool on `ctx.tools`.
 * @param ctx - plugin context carrying the tool registry.
 * @param manager - this instance's runtime.
 */
function registerTools(ctx, manager) {
  ctx.tools.register(defineTool({
    name: "mcp_manager_list",
    description: "List the MCP servers this manager knows: transport, target, whether each is enabled and currently mounted, its tool count, and the last mount error. Use it before adding, reloading or removing a server, and after any change to confirm the result.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          manifestFile: { type: "string", required: true },
          detail: { type: "string", required: true },
          servers: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                serverName: { type: "string", required: true },
                transport: { type: "string", required: true, enum: TRANSPORTS },
                enabled: { type: "boolean", required: true },
                mounted: { type: "boolean", required: true },
                target: { type: "string", required: true },
                toolCallTimeoutMs: { type: "integer", required: true },
                toolCount: { type: "integer", required: true },
                error: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute() {
      const state = manager.state();
      /* Host-configured rows are read-only and surfaced by the GUI/state RPC;
         this model-facing registry listing stays limited to managed servers. */
      const managed = state.servers.filter((server) => server.source === "manager");
      const detail = managed.length === 0
        ? `No MCP servers are registered with the manager yet (manifest: ${manager.file}). Add one with mcp_manager_add.`
        : [`MCP servers (manifest: ${manager.file}):`, ...managed.map((server) => describeStatus({
          ...server,
          lastError: state.status[server.serverName]?.lastError ?? null,
          mounted: state.status[server.serverName]?.mounted ?? false,
          toolCount: state.status[server.serverName]?.toolCount ?? 0,
          target: server.transport === "stdio" ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim() : (server.url ?? ""),
        }))].join("\n");
      return {
        manifestFile: manager.file,
        detail,
        servers: managed.map((server) => {
          const status = state.status[server.serverName] ?? { mounted: false, toolCount: 0, lastError: null };
          return {
            serverName: server.serverName,
            transport: server.transport,
            enabled: server.enabled,
            mounted: status.mounted,
            target: server.transport === "stdio" ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim() : (server.url ?? ""),
            toolCallTimeoutMs: server.toolCallTimeoutMs,
            toolCount: status.toolCount,
            ...(status.lastError === null ? {} : { error: status.lastError }),
          };
        }),
      };
    },
    presentCall: () => ({ card: "generic", title: "List MCP servers", kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_add",
    description: "Register an MCP server with the manager, persist it in the manager manifest, and mount it immediately so its tools become available to the model as mcp__<serverName>__<tool>. Use transport stdio for local servers (command/args/env/cwd) and streamable-http for remote servers (url/headers). Prefer \"env:NAME\" or \"credential:NAME\" references to keep secrets out of the manifest; plaintext values are stored verbatim in the 0600 manifest file. Existing servers are only overwritten when replace is true.",
    parameters: {
      serverName: { type: "string", required: true, description: "Unique name, letters/digits/_/-, 1-32 chars. It becomes the tool namespace: mcp__<serverName>__<tool>." },
      transport: { type: "string", required: true, enum: TRANSPORTS, description: "stdio for a spawned local server, streamable-http for a remote URL." },
      command: { type: "string", description: "stdio only: executable to spawn, e.g. \"npx\" or an absolute path." },
      args: { type: "array", description: "stdio only: command arguments.", items: { type: "string" } },
      env: { type: "array", description: "stdio only: environment entries as {name, value}. Use value \"env:VAR\" to read the host environment.", items: { type: "object", additionalProperties: false, properties: { name: { type: "string", required: true }, value: { type: "string", required: true } } } },
      cwd: { type: "string", description: "stdio only: working directory for the spawned server." },
      url: { type: "string", description: "streamable-http only: absolute http(s) MCP endpoint." },
      headers: { type: "array", description: "streamable-http only: request header entries as {name, value}. Use value \"env:VAR\" for credentials.", items: { type: "object", additionalProperties: false, properties: { name: { type: "string", required: true }, value: { type: "string", required: true } } } },
      toolCallTimeoutMs: { type: "integer", description: "Per-call timeout for this server's tools. Defaults to the plugin's defaultToolCallTimeoutMs." },
      enabled: { type: "boolean", description: "Persist the server as enabled (default true)." },
      replace: { type: "boolean", description: "Overwrite an existing registration with the same serverName (default false)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverName: { type: "string", required: true },
          mounted: { type: "boolean", required: true },
          detail: { type: "string", required: true },
          ok: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const existing = manager.spec(args.serverName);
      if (existing !== undefined && args.replace !== true) throw new Error(`mcp-manager: server "${args.serverName}" already exists — pass replace: true to overwrite it, or pick another serverName`);
      if (existing !== undefined) await manager.updateServer(args);
      else await manager.addServer(args);
      const status = manager.statusMap()[args.serverName] ?? { mounted: false, lastError: null };
      const detail = status.mounted
        ? `Added and mounted MCP server "${args.serverName}". Its tools are now available as mcp__${args.serverName}__<tool>; verify with mcp_manager_tools.`
        : status.lastError !== null
          ? `Registered MCP server "${args.serverName}" but mounting failed: ${status.lastError}`
          : `Registered MCP server "${args.serverName}" as disabled; enable it with mcp_manager_enable.`;
      return { serverName: args.serverName, mounted: status.mounted, detail, ok: status.lastError === null };
    },
    presentCall: (args) => ({ card: "generic", title: `Add MCP server ${args.serverName}`, kind: "other", rawInput: { transport: args.transport, url: args.url, command: args.command } }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_remove",
    description: "Unmount an MCP server and delete it from the manager manifest. Its tools stop being available to the model immediately.",
    parameters: {
      serverName: { type: "string", required: true, description: "Server to remove." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverName: { type: "string", required: true },
          removed: { type: "boolean", required: true },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      await manager.removeServer(args.serverName);
      return { serverName: args.serverName, removed: true, detail: `Removed MCP server "${args.serverName}" and unmounted its tools.` };
    },
    presentCall: (args) => ({ card: "generic", title: `Remove MCP server ${args.serverName}`, kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_reload",
    description: "Rebuild the connection to one MCP server (or every enabled server when serverName is omitted) without restarting the host: the server is unmounted and mounted again, and the manager's own client is dropped. Use this when a server's tools start failing — for streamable-http servers a long host suspend can expire the server-side session and every call then fails until the connection is rebuilt.",
    parameters: {
      serverName: { type: "string", description: "Server to reload; omit to reload every enabled server." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reloaded: { type: "array", required: true, items: { type: "string" } },
          failed: { type: "array", required: true, items: { type: "string" } },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const { reloaded, failed } = await manager.reload(args.serverName);
      const detail = [
        reloaded.length > 0 ? `Reloaded: ${reloaded.join(", ")}.` : "Nothing was reloaded.",
        failed.length > 0 ? `Failed: ${failed.join("; ")}.` : "",
      ].filter(Boolean).join(" ");
      return { reloaded, failed, detail };
    },
    presentCall: (args) => ({ card: "generic", title: args.serverName === undefined ? "Reload every MCP server" : `Reload MCP server ${args.serverName}`, kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_enable",
    description: "Enable or disable one registered MCP server. Disabling unmounts its tools without deleting the registration; enabling mounts it again.",
    parameters: {
      serverName: { type: "string", required: true, description: "Server to toggle." },
      enabled: { type: "boolean", required: true, description: "true mounts the server, false unmounts it." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverName: { type: "string", required: true },
          enabled: { type: "boolean", required: true },
          mounted: { type: "boolean", required: true },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const { enabled } = await manager.toggleServer(args.serverName, args.enabled);
      const mounted = manager.mounts.isMounted(args.serverName);
      const detail = mounted
        ? `Enabled and mounted MCP server "${args.serverName}".`
        : `Disabled and unmounted MCP server "${args.serverName}".`;
      return { serverName: args.serverName, enabled, mounted, detail };
    },
    presentCall: (args) => ({ card: "generic", title: `${args.enabled ? "Enable" : "Disable"} MCP server ${args.serverName}`, kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_tools",
    description: "Connect to one MCP server with a fresh client and list the tools it exposes (name, description, and the parameter names the server declares). Use it to discover what a newly added server offers, or to diagnose a server whose tools the model cannot see.",
    parameters: {
      serverName: { type: "string", required: true, description: "Server to inspect." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverName: { type: "string", required: true },
          ok: { type: "boolean", required: true },
          detail: { type: "string", required: true },
          tools: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                description: { type: "string", required: true },
                parameters: { type: "string", required: true },
                inputSchema: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const spec = manager.spec(args.serverName);
      if (spec === undefined) throw new Error(`mcp-manager: unknown server "${args.serverName}"`);
      const { client } = await manager.clientFor(spec);
      const listed = await withTimeout(Promise.resolve(client.listTools(undefined, { cacheMode: "refresh" })), manager.config.probeTimeoutMs, `listTools on "${args.serverName}"`);
      const tools = (listed?.tools ?? []).map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description.slice(0, 400) : "",
        parameters: Object.keys(tool.inputSchema?.properties ?? {}).join(", "),
        inputSchema: clamp(JSON.stringify(tool.inputSchema ?? {})),
      }));
      const detail = tools.length === 0
        ? `Server "${args.serverName}" exposes no tools.`
        : [`Server "${args.serverName}" exposes ${tools.length} tool(s):`, ...tools.map((tool) => `- ${tool.name}(${tool.parameters}) — ${tool.description}`)].join("\n");
      return { serverName: args.serverName, ok: true, detail: clamp(detail), tools };
    },
    presentCall: (args) => ({ card: "generic", title: `Inspect MCP server ${args.serverName}`, kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_call",
    description: "Call one tool on one MCP server with a fresh client, independent of what is mounted. arguments is a JSON object string (omit it for a tool that takes no arguments). Prefer calling the mounted tool mcp__<serverName>__<tool> directly when it is visible to you; use this for inspection, for a server that is not mounted, or to compare behaviour.",
    parameters: {
      serverName: { type: "string", required: true, description: "Server that owns the tool." },
      tool: { type: "string", required: true, description: "Tool name exactly as the server declares it." },
      arguments: { type: "string", description: "JSON object string of tool arguments, e.g. {\"query\":\"x\"}. Omit when the tool takes none." },
      timeoutMs: { type: "integer", description: "Override the wait for this call. Long-running tools (deep research) need more than the plugin's probeTimeoutMs." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          isError: { type: "boolean", required: true },
          detail: { type: "string", required: true },
          content: { type: "array", required: true, items: { type: "json" } },
          structuredContent: { type: "json" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      let parsed = {};
      if (args.arguments !== undefined && args.arguments.trim() !== "") {
        try {
          parsed = JSON.parse(args.arguments);
        } catch (error) {
          throw new Error(`mcp-manager: arguments is not valid JSON: ${String(error)}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mcp-manager: arguments must be a JSON object");
      }
      const spec = manager.spec(args.serverName);
      if (spec === undefined) throw new Error(`mcp-manager: unknown server "${args.serverName}"`);
      const { client } = await manager.clientFor(spec);
      const waitMs = args.timeoutMs === undefined ? manager.config.probeTimeoutMs : args.timeoutMs;
      let result;
      try {
        result = await withTimeout(
          Promise.resolve(client.callTool({ name: args.tool, arguments: parsed }, { timeout: waitMs })),
          waitMs + 2000,
          `call ${args.serverName}.${args.tool}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, detail: clamp(`mcp__${args.serverName}__${args.tool} → error\n${message}`), content: [] };
      }
      const isError = result?.isError === true;
      const content = Array.isArray(result?.content) ? result.content : [];
      const projected = content.length > 0
        ? projectMcpContent(content, args.serverName, args.tool)
        : JSON.stringify(result?.structuredContent ?? result ?? null);
      const structuredContent = result?.structuredContent;
      const structuredText = structuredContent === undefined ? "" : `\nstructuredContent: ${clamp(JSON.stringify(structuredContent))}`;
      return {
        isError,
        detail: clamp(`mcp__${args.serverName}__${args.tool} → ${isError ? "error" : "ok"}\n${projected}${structuredText}`),
        content,
        ...(structuredContent === undefined ? {} : { structuredContent }),
      };
    },
    presentCall: (args) => ({ card: "generic", title: `Call ${args.serverName}.${args.tool}`, kind: "other", rawInput: args.arguments }),
  }));

  ctx.tools.register(defineTool({
    name: "mcp_manager_import",
    description: "Import MCP servers already declared in a cordis patch file (default: the host patch layer, $DSH_HOME/cordis.patch.yml) into this manager's registry, so the hand-written rows can be retired. Rows whose headers use a ${process.env.VAR} expression are translated to the manager's env: indirection when possible. Reports what it imported and what it skipped.",
    parameters: {
      path: { type: "string", description: "Patch file to read. Defaults to $DSH_HOME/cordis.patch.yml." },
      dryRun: { type: "boolean", description: "Report what would be imported without persisting anything (default false)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          imported: { type: "array", required: true, items: { type: "string" } },
          skipped: { type: "array", required: true, items: { type: "string" } },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const { join } = await import("node:path");
      const file = args.path !== undefined && args.path !== "" ? args.path : join(resolveDshHome(), "cordis.patch.yml");
      const { imported, skipped } = await manager.importPatch(file, args.dryRun === true);
      const detail = [
        `Patch file: ${file}`,
        imported.length > 0 ? `Imported${args.dryRun === true ? " (dry run)" : ""}: ${imported.join(", ")}.` : "Nothing was imported.",
        skipped.length > 0 ? `Skipped: ${skipped.join("; ")}.` : "",
        imported.length > 0 && args.dryRun !== true
          ? "Retire the corresponding dsh-mcp-client rows from the patch file to avoid mounting the same server twice; that edit hot-reloads the plugin tree, so do it while no turn is running."
          : "",
      ].filter(Boolean).join("\n");
      return { imported, skipped, detail };
    },
    presentCall: () => ({ card: "generic", title: "Import MCP servers from a patch file", kind: "other" }),
  }));
}

//#endregion

/**
 * Register the native Desktop page's RPC route (`/mcp-manager`).
 *
 * The browser half calls `connection.rpc.call('/mcp-manager', endpoint, payload)`,
 * which POSTs a `{ type: 'client-request', rpcId, method, payload }` envelope to
 * `/mcp-manager/<endpoint>` and expects `{ type: 'server-response', rpcId, result }`.
 * Admission is delegated to `connection.admit(req)` (owner-only browser peer).
 *
 * @param ctx - host plugin context.
 * @param manager - this instance's runtime.
 */
function registerRpcRoute(ctx, manager) {
  const handler = createManagerRpcHandler({
    state: () => manager.state(),
    addServer: (input) => manager.addServer(input),
    updateServer: (input) => manager.updateServer(input),
    removeServer: (serverName) => manager.removeServer(serverName),
    toggleServer: (serverName, enabled) => manager.toggleServer(serverName, enabled),
    testServer: (input) => manager.testServer(input),
    importServers: (input) => manager.importServers(input),
    importTest: (input) => manager.importTest(input),
    status: () => manager.statusMap(),
  });

  /**
   * Build the prefix route over the admitted peer of this admission.
   * @param rpcCtx - context where both `webServer` and `connection` are present.
   */
  function buildRoute(rpcCtx) {
    return {
      kind: "prefix",
      path: RPC_PATH,
      handler: async (req, res) => {
        try {
          const admission = rpcCtx.connection.admit(req);
          if ("rejection" in admission) {
            res.writeHead(admission.rejection);
            res.end();
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          const url = new URL(req.url ?? "/", "http://x");
          const endpoint = url.pathname.startsWith(`${RPC_PATH}/`) ? url.pathname.slice(RPC_PATH.length + 1) : "";
          if (endpoint.length === 0 || !/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
            res.writeHead(404);
            res.end();
            return;
          }
          let body = "";
          let bytes = 0;
          for await (const chunk of req) {
            bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
            if (bytes > MAX_RPC_BODY_BYTES) {
              res.writeHead(413);
              res.end();
              return;
            }
            body += chunk;
          }
          let envelope;
          try {
            envelope = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          if (envelope === null || typeof envelope !== "object"
            || envelope.type !== "client-request"
            || typeof envelope.rpcId !== "string"
            || envelope.method !== endpoint) {
            res.writeHead(400);
            res.end();
            return;
          }
          let result;
          try {
            result = await handler(endpoint, envelope.payload ?? {}, req.signal, admission.peer);
          } catch (error) {
            result = {
              ok: false,
              error: {
                code: typeof error?.code === "string" ? error.code : "MCP_MANAGER_ERROR",
                message: error instanceof Error ? error.message : String(error),
                details: {},
              },
            };
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            ctx.logger?.warn?.(`mcp-manager: RPC route failed: ${message}`);
          } catch {
            /* best-effort */
          }
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end(message);
          } else {
            res.end();
          }
        }
      },
    };
  }

  ctx.inject(["webServer", "connection"], (rpcCtx) => {
    try {
      rpcCtx.effect(() => rpcCtx.webServer.register(buildRoute(rpcCtx)), "mcp-manager: native rpc route");
    } catch (error) {
      manager.logWarn(`registering the ${RPC_PATH} RPC route failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Mount the manager: load its registry, register its tools, expose the RPC
 * route, and mount enabled servers.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved plugin config.
 */
async function apply(ctx, config) {
  const manager = new Manager(ctx, config);
  manager.load();
  registerTools(ctx, manager);

  /* Optional Loader service: used to discover MCP servers the host already
     mounts through @deepseek-ai/dsh-mcp-client. Without it, the manager shows
     only its own registry and logs once. */
  ctx.inject(["loader"], (loaderCtx) => {
    manager.loaderService = loaderCtx.loader;
    loaderCtx.effect(() => () => {
      manager.loaderService = null;
    }, "mcp-manager: loader service lifecycle");
    /* Reconcile once the Loader is observable: a manager entry that collides
       with a host row must be unmounted before it can double-register the
       serverName namespace. */
    manager.afterChange().catch((error) => {
      manager.logWarn(`reconciling host-configured servers failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  /* Optional credentials service for `credential:NAME` header/env values. */
  ctx.inject(["credentials"], (credentialsCtx) => {
    manager.credentialsService = credentialsCtx.credentials;
    credentialsCtx.effect(() => () => {
      manager.credentialsService = null;
    }, "mcp-manager: credentials service lifecycle");
    /* Mounts that failed only because the credentials service was not ready
       yet can now resolve `credential:` references; retry them. */
    manager.afterChange().catch((error) => {
      manager.logWarn(`retrying mounts after the credentials service became available failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  registerRpcRoute(ctx, manager);

  ctx.effect(() => () => {
    manager.disposed = true;
    const cleanup = (async () => {
      await manager.closeAllClients();
      await manager.mounts.disposeAll();
    })();
    return cleanup;
  }, "mcp-manager.lifecycle");

  /* Discover host-configured MCP rows once at apply (state re-enumerates on
     every RPC), then reconcile mounts with the discovered conflicts. */
  const discovered = manager.discoverExternal();
  for (const warning of discovered.warnings) manager.logWarn(warning);
  if (config.autoMount) {
    await manager.afterChange();
  } else {
    const conflicts = manager.conflictNames(discovered.servers);
    if (conflicts.size > 0) {
      for (const serverName of conflicts) manager.logWarn(`server "${serverName}" is also configured by the host; manager will not mount it`);
    }
  }
}

export { Config, apply, inject, name };
