/**
 * Discovery of MCP servers that the host already runs.
 *
 * Users often mount MCP servers directly in the profile patch layer
 * (`@deepseek-ai/dsh-mcp-client` loader rows). The manager used to show only
 * its own manifest, so those servers looked "missing" in the GUI. This module
 * reads the live Loader entry list and describes those rows:
 *
 * - read-only: the manager never edits the host patch file;
 * - `!!js` expressions are never executed: a non-string header/env value is
 *   carried as text plus an `expression: true` marker so the GUI can say
 *   "未求值".
 *
 * The module is dependency-free (the loader is injected by the caller), so it is
 * unit-testable with fake entries.
 *
 * @module dsh-mcp-manager/external
 */
import { toServerView } from "./manifest.js";

/** The in-box bridge package that mounts one MCP server per loader row. */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

/** Prefix of the manager's own package name, used to avoid matching ourselves. */
const MANAGER_PACKAGE = "@deepseek-ai/dsh-mcp-manager";

/** True for a plain (non-array, non-null) object. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Serialize an unevaluated value for display, bounded. */
function displayValue(value) {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    /* fall through */
  }
  return String(value);
}

/**
 * Resolve the package name a loader row mounts.
 * @param entry - loader entry.
 * @returns the lower-cased name string, or undefined.
 */
export function entryPackageName(entry) {
  const name = entry?.options?.name;
  return typeof name === "string" ? name.trim().toLowerCase() : undefined;
}

/**
 * Whether one loader entry mounts the in-box MCP client bridge.
 *
 * The configured name is normally the exact package name, but the Loader also
 * accepts relative paths and aliases, so an exact match falls back to a
 * substring check (the manager's own package name cannot match).
 *
 * @param entry - loader entry.
 * @returns true for a `@deepseek-ai/dsh-mcp-client` row.
 */
export function isMcpClientEntry(entry) {
  const name = entryPackageName(entry);
  if (name === undefined || name.length === 0) return false;
  if (name === MANAGER_PACKAGE) return false;
  if (name === MCP_CLIENT_PACKAGE) return true;
  return name.includes("dsh-mcp-client");
}

/** Present one env/header record as an entry array without evaluating values. */
export function presentEntries(record) {
  if (!isRecord(record)) return [];
  return Object.entries(record).map(([name, value]) => {
    if (typeof value === "string") return { name, value };
    return { name, value: displayValue(value), expression: true };
  });
}

/**
 * Classify a loader entry id as profile-level or preset-nested.
 *
 * Profile patch files are materialized through the Loader's `include` group, so
 * ordinary profile rows carry ids such as `include:mcp-flomo`; those leading
 * include segments are not a preset nesting marker. A row mounted under a
 * preset keeps a colon after the include prefix (`include:preset-standard:mcp-x`).
 *
 * @param entryId - loader entry id.
 * @returns `'profile' | 'preset'`.
 */
export function scopeOfEntryId(entryId) {
  let id = typeof entryId === "string" ? entryId : "";
  while (id.startsWith("include:")) id = id.slice("include:".length);
  return id.includes(":") ? "preset" : "profile";
}

/**
 * Describe one MCP-client loader entry as an external server.
 *
 * @param entry - loader entry.
 * @returns the descriptor, or undefined when it is not a usable MCP row.
 */
export function describeExternalServer(entry) {
  if (!isMcpClientEntry(entry)) return undefined;
  const options = entry.options ?? {};
  const config = options.config;
  if (!isRecord(config)) return undefined;
  const serverName = config.serverName;
  if (typeof serverName !== "string" || serverName.trim().length === 0) return undefined;

  const entryId = typeof entry.id === "string"
    ? entry.id
    : typeof options.id === "string"
      ? options.id
      : serverName;
  const transport = typeof config.transport === "string" ? config.transport : undefined;

  const view = {
    serverName,
    entryId,
    active: Boolean(entry.fiber?.uid),
    disabled: Boolean(options.disabled),
    scope: scopeOfEntryId(entryId),
    transport,
  };
  if (transport === "stdio") {
    if (typeof config.command === "string") view.command = config.command;
    if (Array.isArray(config.args)) view.args = config.args.filter((argument) => typeof argument === "string");
    if (typeof config.cwd === "string" && config.cwd.length > 0) view.cwd = config.cwd;
    view.env = presentEntries(config.env);
  } else {
    if (typeof config.url === "string") view.url = config.url;
    view.headers = presentEntries(config.headers);
  }
  if (typeof config.toolCallTimeoutMs === "number" && Number.isFinite(config.toolCallTimeoutMs)) {
    view.toolCallTimeoutMs = config.toolCallTimeoutMs;
  }
  return view;
}

/**
 * Discover every host-configured MCP server from the live Loader entries.
 *
 * @param entries - iterable of loader entries (or undefined when unavailable).
 * @returns `{ servers, warnings }`; duplicate server names keep the first row.
 */
export function discoverExternalServers(entries) {
  const servers = [];
  const warnings = [];
  if (entries === undefined || entries === null) return { servers, warnings };
  let list;
  try {
    list = [...entries];
  } catch (error) {
    return {
      servers,
      warnings: [`无法枚举 Loader entries：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const seen = new Set();
  for (const entry of list) {
    const described = describeExternalServer(entry);
    if (described === undefined) continue;
    if (seen.has(described.serverName)) {
      warnings.push(`宿主配置里 serverName "${described.serverName}" 重复（entry ${described.entryId}），只保留第一条`);
      continue;
    }
    seen.add(described.serverName);
    servers.push(described);
  }
  return { servers, warnings };
}

/**
 * Whether one external server's env/headers are fully evaluable.
 * Non-string values mean a `!!js` expression (or other non-literal) that the
 * manager will not execute.
 *
 * @param entries - presented entry arrays.
 * @returns true when every value is a literal string.
 */
export function entriesAreLiteral(entries) {
  return (entries ?? []).every((entry) => entry?.expression !== true && typeof entry?.value === "string");
}

/**
 * Build a probe spec for an external server, or a classified failure.
 *
 * The host row's config is reused as-is; `!!js` expressions are not evaluated,
 * so a config that needs one cannot be tested from here — that is reported as a
 * probe-shaped failure instead of throwing.
 *
 * @param external - descriptor from {@link describeExternalServer}.
 * @returns `{ spec }` or `{ error: { code, message } }`.
 */
export function externalTestSpec(external) {
  if (external === undefined) return { error: { code: "unknown", message: "server 不存在" } };
  if (external.transport !== "stdio" && external.transport !== "streamable-http") {
    return { error: { code: "unknown", message: `宿主配置的 transport ${JSON.stringify(external.transport)} 无法测试` } };
  }
  if (external.transport === "stdio") {
    if (typeof external.command !== "string" || external.command.length === 0) {
      return { error: { code: "unknown", message: "宿主配置缺少 command，无法测试" } };
    }
    if (!entriesAreLiteral(external.env)) {
      return { error: { code: "unknown", message: "宿主配置的 env 含未求值表达式，测试不会执行表达式；请在宿主 env 中提供字面量或改用管理器添加" } };
    }
  } else {
    if (typeof external.url !== "string" || external.url.length === 0) {
      return { error: { code: "unknown", message: "宿主配置缺少 url，无法测试" } };
    }
    if (!entriesAreLiteral(external.headers)) {
      return { error: { code: "unknown", message: "宿主配置的 headers 含未求值表达式（如 !!js process.env.X），测试不会执行表达式；请改用管理器添加以便用 env: 间接引用" } };
    }
  }
  const spec = {
    serverName: external.serverName,
    transport: external.transport,
    toolCallTimeoutMs: external.toolCallTimeoutMs ?? 60000,
  };
  if (external.transport === "stdio") {
    spec.command = external.command;
    spec.args = Array.isArray(external.args) ? [...external.args] : [];
    spec.env = Object.fromEntries((external.env ?? []).map((entry) => [entry.name, entry.value]));
    spec.cwd = external.cwd ?? "";
  } else {
    spec.url = external.url;
    spec.headers = Object.fromEntries((external.headers ?? []).map((entry) => [entry.name, entry.value]));
  }
  return { spec };
}

/**
 * Project one external descriptor onto the state view consumed by the GUI.
 *
 * @param external - descriptor.
 * @returns the read-only ServerView for a host row.
 */
export function externalServerView(external) {
  const view = {
    serverName: external.serverName,
    source: "host",
    readOnly: true,
    entryId: external.entryId,
    active: external.active,
    disabled: external.disabled,
    scope: external.scope,
    transport: external.transport,
  };
  if (external.url !== undefined) view.url = external.url;
  if (external.command !== undefined) view.command = external.command;
  if (external.args !== undefined) view.args = [...external.args];
  if (external.cwd !== undefined) view.cwd = external.cwd;
  /* Host patch values are shown as stored: literals as plaintext, `!!js`
     expressions as their original text plus the `expression: true` marker
     (they are never evaluated). */
  if (external.env !== undefined) view.env = external.env.map((entry) => ({ ...entry }));
  if (external.headers !== undefined) view.headers = external.headers.map((entry) => ({ ...entry }));
  if (external.toolCallTimeoutMs !== undefined) view.toolCallTimeoutMs = external.toolCallTimeoutMs;
  return view;
}

/**
 * Merge manager rows and host rows into the `state.servers` list.
 *
 * A name configured by both sides is one row: the manager row gains
 * `conflict: "host"`, becomes read-only, and carries the host metadata
 * (`entryId`/`active`/`scope`), because the host row is the one actually
 * mounted. Host-only rows are appended read-only.
 *
 * @param options.managerServers - canonical manager specs.
 * @param options.externalServers - descriptors from {@link discoverExternalServers}.
 * @returns `{ servers, conflicts }` where conflicts is the conflicting name list.
 */
export function mergeStateRows(options) {
  const managerServers = options.managerServers ?? [];
  const externalServers = options.externalServers ?? [];
  const hostByName = new Map(externalServers.map((external) => [external.serverName, external]));
  const managerNames = new Set(managerServers.map((spec) => spec.serverName));
  const servers = [];
  const conflicts = [];
  for (const spec of managerServers) {
    const view = toServerView(spec);
    view.source = "manager";
    const host = hostByName.get(spec.serverName);
    if (host !== undefined) {
      conflicts.push(spec.serverName);
      view.conflict = "host";
      view.readOnly = true;
      view.entryId = host.entryId;
      view.active = host.active;
      view.scope = host.scope;
      if (host.disabled) view.hostDisabled = true;
    }
    servers.push(view);
  }
  for (const host of externalServers) {
    if (managerNames.has(host.serverName)) continue;
    servers.push(externalServerView(host));
  }
  return { servers, conflicts };
}

/**
 * `ServerStatus` for one host row: the loader row's liveness plus the global
 * tool count. The manager never mounts it and never has a mount error for it.
 *
 * @param external - descriptor from discovery.
 * @param toolCount - registered `mcp__<serverName>__*` count.
 * @returns the status record.
 */
export function externalStatus(external, toolCount) {
  return { mounted: external.active === true, toolCount, lastError: null };
}
