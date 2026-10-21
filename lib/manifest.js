/**
 * Manifest v2 for dsh-mcp-manager.
 *
 * The manifest is the manager's own persisted registry of MCP servers. It is
 * deliberately independent of the Cordis patch layer: adding a server must not
 * hot-reload the plugin tree (which disposes running sessions).
 *
 * Stored shape (v2):
 *
 * ```json
 * {
 *   "version": 2,
 *   "servers": [
 *     { "serverName": "github", "transport": "stdio", "enabled": true,
 *       "toolCallTimeoutMs": 60000, "command": "npx", "args": [], "env": {},
 *       "cwd": "" }
 *   ]
 * }
 * ```
 *
 * - `env` / `headers` are records (`{ "NAME": "env:NAME" }`) on disk; the RPC
 *   contract exposes them as `[{name, value}]` entry arrays.
 * - Legacy manifests written by older releases may still contain the removed
 *   `workspaces` server field and the top-level `externalScopes` map: they are
 *   ignored on read and stripped on the next save (`loadManifestFile` rewrites
 *   the file immediately).
 *
 * The file is written atomically with mode 0600: temp file + rename, and every
 * write re-validates/normalizes each entry so a bug cannot persist garbage.
 *
 * @module dsh-mcp-manager/manifest
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Manifest format this module writes. */
export const MANIFEST_VERSION = 2;

/** Default manifest filename inside `$DSH_HOME`. */
export const MANIFEST_FILENAME = "mcp-manager.json";

/** Server names must be safe as tool-name namespace segments (`mcp__<name>__<tool>`). */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Transports this manager accepts. */
export const TRANSPORTS = Object.freeze(["stdio", "streamable-http"]);

/** Per-server tool-call default, matching the in-box bridge (`mcp-client`). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

/** Upper bound accepted for a per-server/per-call timeout (24h). */
export const MAX_TOOL_CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Prefix marking a value that must be read from the host environment at mount time. */
export const ENV_PREFIX = "env:";

/** Prefix marking a value resolved through the harness credentials service. */
export const CREDENTIAL_PREFIX = "credential:";

/** Workspace ids kept per server. */
const MAX_WORKSPACES = 64;

/** Environment/header entries kept per server. */
const MAX_ENTRIES = 128;

/** Command-line arguments kept per stdio server. */
const MAX_ARGS = 256;

/** String budget for a single command / url / header value. */
const MAX_VALUE_CHARS = 8192;

/** Build the empty manifest. */
export function emptyManifest() {
  return { version: MANIFEST_VERSION, servers: [] };
}

/** Resolve the manifest path for one instance (explicit config wins). */
export function manifestPathFor(config, dshHome) {
  const override = config?.manifestFile;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return join(dshHome, MANIFEST_FILENAME);
}

/** Build an Error carrying a stable RPC error code. */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Reject invalid input with the contract's INVALID_INPUT code. */
function invalid(message) {
  throw codedError("INVALID_INPUT", message);
}

/** True for a plain (non-array, non-null) object. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Require a string, optionally allowing a default for `undefined`. */
function optionalString(value, field, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string") invalid(`${field} must be a string`);
  if (value.length > MAX_VALUE_CHARS) invalid(`${field} is longer than ${MAX_VALUE_CHARS} characters`);
  return value;
}

/**
 * Read one `env`/`headers` value that is either a record or a `[{name, value}]`
 * entry array, and return a canonical record in first-seen order.
 *
 * @param value - raw input field.
 * @param field - field name used in messages.
 * @returns the canonical record (empty when the field is absent).
 */
export function entriesToRecord(value, field) {
  if (value === undefined || value === null) return {};
  const record = Object.create(null);
  const add = (name, entryValue) => {
    if (typeof name !== "string" || name.length === 0) invalid(`${field} entry name must be a non-empty string`);
    if (name.length > MAX_VALUE_CHARS) invalid(`${field} entry name is longer than ${MAX_VALUE_CHARS} characters`);
    if (typeof entryValue !== "string") invalid(`${field} entry "${name}" value must be a string`);
    if (entryValue.length > MAX_VALUE_CHARS) invalid(`${field} entry "${name}" value is longer than ${MAX_VALUE_CHARS} characters`);
    if (name in record) invalid(`duplicate ${field} entry "${name}"`);
    record[name] = entryValue;
  };
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) invalid(`${field} has more than ${MAX_ENTRIES} entries`);
    for (const entry of value) {
      if (!isRecord(entry)) invalid(`${field} must be an object or an array of {name, value} entries`);
      add(entry.name, entry.value);
    }
    return { ...record };
  }
  if (!isRecord(value)) invalid(`${field} must be an object or an array of {name, value} entries`);
  const names = Object.keys(value);
  if (names.length > MAX_ENTRIES) invalid(`${field} has more than ${MAX_ENTRIES} entries`);
  for (const name of names) add(name, value[name]);
  return { ...record };
}

/** Read a record back into the RPC contract's entry array. */
export function recordToEntries(record) {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

/** Read a string array (`args`), rejecting non-string members. */
function stringList(value, field, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${field} must be an array of strings`);
  if (value.length > max) invalid(`${field} has more than ${max} entries`);
  return value.map((entry) => {
    if (typeof entry !== "string") invalid(`${field} must be an array of strings`);
    if (entry.length > MAX_VALUE_CHARS) invalid(`${field} entry is longer than ${MAX_VALUE_CHARS} characters`);
    return entry;
  });
}

/**
 * Validate and canonicalize one server input (RPC, model tool, or import).
 *
 * Accepts `env`/`headers` as either a record or an entry array. Unknown extra
 * fields are ignored (the canonical result only carries contract fields), and
 * fields that do not belong to the selected transport are dropped.
 *
 * @param input - untrusted server input.
 * @param options - defaults.
 * @returns the canonical persisted spec.
 */
export function validateServerInput(input, options = {}) {
  const defaults = {
    defaultToolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    ...options,
  };
  if (!isRecord(input)) invalid("server input must be an object");
  const serverName = input.serverName;
  if (typeof serverName !== "string" || !SERVER_NAME_PATTERN.test(serverName)) {
    invalid(`serverName must match ${String(SERVER_NAME_PATTERN)} (got ${JSON.stringify(serverName)})`);
  }
  const transport = input.transport;
  if (!TRANSPORTS.includes(transport)) invalid(`transport must be one of ${TRANSPORTS.join(", ")}`);

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") invalid("enabled must be a boolean");

  const timeout = input.toolCallTimeoutMs;
  const toolCallTimeoutMs = timeout === undefined ? defaults.defaultToolCallTimeoutMs : timeout;
  if (!Number.isSafeInteger(toolCallTimeoutMs) || toolCallTimeoutMs <= 0 || toolCallTimeoutMs > MAX_TOOL_CALL_TIMEOUT_MS) {
    invalid(`toolCallTimeoutMs must be an integer between 1 and ${MAX_TOOL_CALL_TIMEOUT_MS}`);
  }

  if (transport === "stdio") {
    const command = input.command;
    if (typeof command !== "string" || command.trim().length === 0) invalid("stdio servers require a non-empty command");
    if (command.length > MAX_VALUE_CHARS) invalid("command is too long");
    return {
      serverName,
      transport,
      enabled,
      toolCallTimeoutMs,
      command,
      args: stringList(input.args, "args", MAX_ARGS),
      env: entriesToRecord(input.env, "env"),
      cwd: optionalString(input.cwd, "cwd"),
    };
  }

  const url = input.url;
  if (typeof url !== "string" || url.length === 0) invalid("streamable-http servers require a url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid(`url ${JSON.stringify(url)} is not a valid absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") invalid("url must use http or https");
  return {
    serverName,
    transport,
    enabled,
    toolCallTimeoutMs,
    url: parsed.href,
    headers: entriesToRecord(input.headers, "headers"),
  };
}

/**
 * Canonicalize a spec read from disk. Stored specs use records for env/headers,
 * which `validateServerInput` already accepts, so the same strict path applies.
 * @param spec - untrusted stored spec.
 * @returns the canonical spec.
 */
export function normalizeStoredSpec(spec) {
  return validateServerInput(spec, { defaultToolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS });
}

/**
 * Read the manifest.
 *
 * Missing file = empty registry. Unreadable or malformed JSON, or a manifest
 * whose top-level shape is not an object with an array `servers`, throws: the
 * caller decides how to degrade (log + run empty, never silently rewrite).
 * Individual invalid entries are skipped and reported in `warnings`, so one
 * hand-edited broken row cannot take the whole registry down.
 *
 * @param file - absolute manifest path.
 * @returns `{ version, servers, warnings, legacyFields }` where `legacyFields`
 *          names removed workspace-scoping fields still present on disk.
 */
export function readManifest(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ...emptyManifest(), warnings: [], legacyFields: [] };
    throw codedError("MANIFEST_UNREADABLE", `mcp-manager: cannot read manifest ${file}: ${String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw codedError("MANIFEST_INVALID", `mcp-manager: manifest ${file} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) throw codedError("MANIFEST_INVALID", `mcp-manager: manifest ${file} must be a JSON object`);
  if (parsed.version !== undefined && (!Number.isSafeInteger(parsed.version) || parsed.version < 1 || parsed.version > MANIFEST_VERSION)) {
    throw codedError("MANIFEST_UNSUPPORTED", `mcp-manager: manifest ${file} declares unsupported version ${JSON.stringify(parsed.version)} (this manager writes ${MANIFEST_VERSION})`);
  }
  if (!Array.isArray(parsed.servers)) throw codedError("MANIFEST_INVALID", `mcp-manager: manifest ${file} must contain a "servers" array`);
  const warnings = [];
  const legacyFields = new Set();
  if (Object.hasOwn(parsed, "externalScopes")) legacyFields.add("externalScopes");
  const servers = [];
  const seen = new Set();
  for (const [index, entry] of parsed.servers.entries()) {
    if (isRecord(entry) && Object.hasOwn(entry, "workspaces")) legacyFields.add("workspaces");
    try {
      const spec = normalizeStoredSpec(entry);
      if (seen.has(spec.serverName)) {
        warnings.push(`duplicate serverName "${spec.serverName}" at index ${index}; the later entry wins`);
        servers[servers.findIndex((server) => server.serverName === spec.serverName)] = spec;
        continue;
      }
      seen.add(spec.serverName);
      servers.push(spec);
    } catch (error) {
      warnings.push(`skipped invalid server entry at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { version: MANIFEST_VERSION, servers, warnings, legacyFields: [...legacyFields].sort() };
}

/**
 * Load the manifest and strip removed workspace-scoping fields from disk.
 *
 * Older releases stored per-server `workspaces` ids and a top-level
 * `externalScopes` map. Workspace scoping is gone, so those fields are ignored
 * on read and this loader rewrites the file once to remove them (atomic 0600,
 * no backup: the user explicitly asked for this data to be removed). A rewrite
 * failure still returns the stripped in-memory manifest with a warning, so a
 * read-only filesystem cannot break startup.
 *
 * @param file - absolute manifest path.
 * @returns `{ manifest, warnings, cleanedLegacyFields }`.
 */
export function loadManifestFile(file) {
  const loaded = readManifest(file);
  const manifest = { version: MANIFEST_VERSION, servers: loaded.servers };
  const warnings = [...loaded.warnings];
  let cleanedLegacyFields = [];
  if (loaded.legacyFields.length > 0) {
    try {
      writeManifest(file, manifest);
      cleanedLegacyFields = loaded.legacyFields;
    } catch (error) {
      warnings.push(`could not strip legacy workspace-scoping fields from ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { manifest, warnings, cleanedLegacyFields };
}

/**
 * Write the manifest atomically (temp file + rename) with mode 0600.
 * Entries are re-validated so a programming error fails loudly before touching
 * the live file.
 *
 * @param file - absolute manifest path.
 * @param manifest - `{ servers }` (the version is owned by this module).
 */
export function writeManifest(file, manifest) {
  const servers = (manifest?.servers ?? []).map((spec) => normalizeStoredSpec(spec));
  const body = `${JSON.stringify({ version: MANIFEST_VERSION, servers }, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw codedError("MANIFEST_WRITE_FAILED", `mcp-manager: cannot write manifest ${file}: ${String(error)}`);
  }
}

/**
 * Resolve an `env:NAME` indirection against a host environment.
 * @param value - stored value.
 * @param what - field label for messages.
 * @param env - environment source (defaults to `process.env`).
 * @returns the resolved value.
 */
export function resolveEnvValue(value, what, env = process.env) {
  if (typeof value !== "string") invalid(`${what} must be a string`);
  if (!value.startsWith(ENV_PREFIX)) return value;
  const variable = value.slice(ENV_PREFIX.length);
  if (variable.length === 0) invalid(`${what} uses "${ENV_PREFIX}" without a variable name`);
  const resolved = env[variable];
  if (resolved === undefined || resolved === "") {
    throw codedError("ENV_MISSING", `mcp-manager: ${what} references environment variable "${variable}", which is not set for the host process`);
  }
  return resolved;
}

/**
 * Translate one canonical spec into the in-box bridge's config shape.
 * Env/header values are resolved here; a missing variable throws ENV_MISSING
 * and the mount layer records it as `lastError` instead of failing the host.
 *
 * @param spec - canonical spec.
 * @param options - `env` source and default timeout.
 * @returns bridge config for `ctx.plugin(mcp-client, config)`.
 */
export function bridgeConfigFor(spec, options = {}) {
  const env = options.env ?? process.env;
  const base = {
    serverName: spec.serverName,
    toolCallTimeoutMs: spec.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  };
  if (spec.transport === "stdio") {
    const resolvedEnv = {};
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      resolvedEnv[key] = resolveEnvValue(value, `env.${key}`, env);
    }
    return {
      ...base,
      transport: "stdio",
      command: spec.command,
      args: spec.args ?? [],
      env: resolvedEnv,
      cwd: spec.cwd ?? "",
    };
  }
  const resolvedHeaders = {};
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    resolvedHeaders[key] = resolveEnvValue(value, `headers.${key}`, env);
  }
  return { ...base, transport: "streamable-http", url: spec.url, headers: resolvedHeaders };
}

/**
 * Signature of everything that affects a mounted bridge connection (env
 * references unresolved, so changing a variable's value does not remount).
 * @param spec - canonical spec.
 * @returns a stable string.
 */
export function specSignature(spec) {
  const common = {
    serverName: spec.serverName,
    transport: spec.transport,
    toolCallTimeoutMs: spec.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
  };
  if (spec.transport === "stdio") {
    return JSON.stringify({ ...common, command: spec.command, args: spec.args ?? [], env: spec.env ?? {}, cwd: spec.cwd ?? "" });
  }
  return JSON.stringify({ ...common, url: spec.url, headers: spec.headers ?? {} });
}

/**
 * Project one canonical spec onto the RPC `ServerView` shape.
 *
 * @param spec - canonical spec.
 * @returns the client-facing view.
 */
export function toServerView(spec) {
  const view = {
    serverName: spec.serverName,
    transport: spec.transport,
    enabled: spec.enabled !== false,
    toolCallTimeoutMs: spec.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
  };
  if (spec.transport === "stdio") {
    view.command = spec.command;
    view.args = [...(spec.args ?? [])];
    view.env = recordToEntries(spec.env);
    view.cwd = spec.cwd ?? "";
  } else {
    view.url = spec.url;
    view.headers = recordToEntries(spec.headers);
  }
  return view;
}

//#region value references and blank-value edit semantics

/** True for an `env:NAME` host-environment reference. */
export function isEnvReference(value) {
  return typeof value === "string" && value.startsWith(ENV_PREFIX);
}

/** True for a `credential:NAME` harness-credential reference. */
export function isCredentialReference(value) {
  return typeof value === "string" && value.startsWith(CREDENTIAL_PREFIX);
}

/**
 * Resolve one stored header/env value for use on the wire.
 *
 * Resolution: `env:NAME` reads the host environment, `credential:NAME` asks
 * the credentials service, and everything else is used verbatim (plaintext).
 *
 * @param value - stored value.
 * @param deps.env - environment source (defaults to `process.env`).
 * @param deps.credentials - optional credentials service.
 * @param what - field label for errors.
 * @returns the resolved string.
 */
export async function resolveSecretValue(value, deps = {}, what = "secret") {
  if (isEnvReference(value)) {
    const name = value.slice(ENV_PREFIX.length).trim();
    if (name.length === 0) invalid(`mcp-manager: ${what} uses "${ENV_PREFIX}" without a variable name`);
    const env = deps.env ?? process.env;
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw codedError("ENV_MISSING", `mcp-manager: ${what} references environment variable "${name}", which is not set for the host process`);
    }
    return resolved;
  }
  if (isCredentialReference(value)) {
    const name = value.slice(CREDENTIAL_PREFIX.length).trim();
    if (name.length === 0) invalid(`mcp-manager: ${what} uses "${CREDENTIAL_PREFIX}" without a credential name`);
    if (deps.credentials === undefined || deps.credentials === null) {
      throw codedError("CREDENTIAL_UNAVAILABLE", `mcp-manager: ${what} references credential "${name}" but the credentials service is unavailable`);
    }
    let resolved;
    try {
      resolved = await deps.credentials.resolve(name);
    } catch (error) {
      throw codedError("CREDENTIAL_RESOLVE_FAILED", `mcp-manager: resolving credential "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolved === undefined || resolved === null || typeof resolved.value !== "string" || resolved.value.length === 0) {
      throw codedError("CREDENTIAL_MISSING", `mcp-manager: credential "${name}" is not configured`);
    }
    return resolved.value;
  }
  return value;
}

/** Resolve every value of one env/header record. */
async function resolveValueRecord(record, deps, field) {
  const result = {};
  for (const [name, value] of Object.entries(record ?? {})) {
    result[name] = await resolveSecretValue(value, deps, `${field}.${name}`);
  }
  return result;
}

/**
 * Return a copy of one spec with its header/env values resolved for the bridge
 * or a probe. The persisted spec keeps the references/plaintext untouched.
 *
 * @param spec - canonical spec.
 * @param deps - `{ env, credentials }`.
 * @returns the resolved spec.
 */
export async function resolveSpecValues(spec, deps = {}) {
  const resolved = { ...spec };
  if (spec.transport === "stdio") {
    resolved.env = await resolveValueRecord(spec.env, deps, "env");
  } else {
    resolved.headers = await resolveValueRecord(spec.headers, deps, "headers");
  }
  return resolved;
}

/**
 * Merge UI entries over the stored record: an empty incoming value keeps the
 * stored value for that name; a missing name removes it; a brand-new empty
 * entry is an input error.
 *
 * @param incoming - record from the validated input.
 * @param existing - stored record for this server (undefined for a new one).
 * @param field - field label for errors.
 * @returns the merged record.
 */
export function mergeValueRecord(incoming, existing, field) {
  const result = {};
  for (const [name, value] of Object.entries(incoming ?? {})) {
    if (value === "") {
      if (existing !== undefined && Object.hasOwn(existing, name)) {
        result[name] = existing[name];
        continue;
      }
      throw codedError("INVALID_INPUT", `mcp-manager: ${field}.${name} is empty; a new entry must carry a value (an empty value keeps the stored value)`);
    }
    result[name] = value;
  }
  return result;
}

/**
 * Merge a whole spec's env/headers over the stored spec (blank values keep the
 * stored value), for the editing form.
 *
 * @param spec - validated incoming spec.
 * @param existingSpec - stored spec for the same server, if any.
 * @returns a copy with merged `env`/`headers`.
 */
export function mergeServerValues(spec, existingSpec) {
  const merged = { ...spec };
  if (spec.transport === "stdio") {
    merged.env = mergeValueRecord(spec.env ?? {}, existingSpec?.env, "env");
  } else {
    merged.headers = mergeValueRecord(spec.headers ?? {}, existingSpec?.headers, "headers");
  }
  return merged;
}

//#endregion

//#region model-facing MCP tool attribution

/** Prefix owned by one mounted MCP server in the model-facing tool namespace. */
export function mcpToolPrefix(serverName) {
  return `mcp__${serverName}__`;
}

/** Order server names longest-first so overlapping prefixes resolve correctly. */
export function sortServerNames(serverNames) {
  return [...serverNames].sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Resolve which server owns one model-facing MCP tool name.
 * @param toolName - registered tool name.
 * @param sortedNames - server names sorted by {@link sortServerNames}.
 * @returns the owning server name, or undefined for a non-MCP/foreign tool.
 */
export function attributeToolName(toolName, sortedNames) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return undefined;
  for (const serverName of sortedNames) {
    if (toolName.startsWith(mcpToolPrefix(serverName))) return serverName;
  }
  return undefined;
}

/**
 * Count the registered MCP tools of every server (status/toolCount support).
 * @param toolNames - names from the global tool schemas.
 * @param serverNames - manifest/host server names.
 * @returns `Map<serverName, number>` including zero counts.
 */
export function countToolsByServer(toolNames, serverNames) {
  const counts = new Map(serverNames.map((serverName) => [serverName, 0]));
  const sorted = sortServerNames(serverNames);
  for (const toolName of toolNames) {
    const owner = attributeToolName(toolName, sorted);
    if (owner !== undefined) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return counts;
}

//#endregion
