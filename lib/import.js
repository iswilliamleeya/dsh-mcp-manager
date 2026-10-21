/**
 * Paste-a-JSON import for dsh-mcp-manager.
 *
 * Users routinely have an MCP client config on hand (Claude Desktop's
 * `{"mcpServers": {...}}`, Cursor's `{"mcpServers": {...}}`, VS Code's
 * `{"servers": ...}` shape, or just one server object). This module turns that
 * text into the manager's canonical ServerInput shape; it does not touch the
 * manifest or mount anything, so it is dependency-free and unit-testable.
 *
 * Accepted inputs:
 *
 * - full wrapper: `{ "mcpServers": { "flomo": { ... } } }`
 * - bare map: `{ "flomo": { ... }, "github": { ... } }`
 * - one server object: `{ "url": "...", "type": "streamable-http" }`
 * - any of the above inside a ```json fence or surrounded by explanation text
 *
 * Field mapping:
 *
 * - `type`/`transport`: `streamable-http` / `streamableHttp` / `http` / `https`
 *   / `sse` → streamable-http (`sse` adds a warning); `stdio` → stdio.
 * - Without a type: `command` implies stdio, otherwise a URL implies
 *   streamable-http.
 * - URL aliases: `url`, `serverUrl`, `endpoint`.
 *
 * Anything the manager cannot represent (unsupported transport, missing url,
 * non-object entry, ...) is reported per entry so one bad row cannot block the
 * rest — the caller turns those into `skipped` results.
 *
 * @module dsh-mcp-manager/import
 */
import { validateServerInput } from "./manifest.js";

/** Transports the manager accepts. */
const TRANSPORTS = new Set(["stdio", "streamable-http"]);

/** Entry field names accepted as the MCP endpoint. */
const URL_FIELDS = ["url", "serverUrl", "endpoint"];

/** A bare object with one of these keys is treated as a single server. */
const SERVER_SHAPE_FIELDS = ["command", "url", "serverUrl", "endpoint", "args", "type", "transport"];

/** Build an INVALID_INPUT error. */
function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

/** True for a plain (non-array, non-null) object. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Find the matching closing brace of the object starting at `start`, honoring
 * JSON strings and escapes.
 *
 * @param text - source text.
 * @param start - index of the opening `{`.
 * @returns the index of the closing brace, or -1.
 */
function matchBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Extract the first JSON object from text that may contain a code fence or
 * explanatory prose around it.
 *
 * @param text - pasted text.
 * @returns the parsed plain object.
 * @throws INVALID_INPUT when no object can be extracted.
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") throw invalid("json 必须是字符串");
  const trimmed = text.trim();
  if (trimmed.length === 0) throw invalid("json 不能为空");

  /* Fast path: the whole payload is the JSON document. */
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed;
  } catch {
    /* fall through to extraction */
  }

  /* Code fence first: it is the ordinary chat-copy shape. */
  const fenced = /```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenced !== null) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (isRecord(parsed)) return parsed;
    } catch {
      /* fall through to the balanced scan */
    }
  }

  /* Balanced-brace scan over every '{' so leading prose does not matter. */
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const end = matchBalanced(trimmed, start);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (isRecord(parsed)) return parsed;
    } catch {
      /* this candidate is not valid JSON; try the next opening brace */
    }
  }
  throw invalid("无法从文本中提取有效的 JSON 对象，请检查粘贴内容是否完整");
}

/** True when an object looks like one server entry rather than a name→server map. */
function looksLikeSingleServer(value) {
  return SERVER_SHAPE_FIELDS.some((field) => value[field] !== undefined);
}

/** Read the MCP endpoint from any accepted alias. */
function urlOf(entry) {
  for (const field of URL_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Fallback name for a single unnamed server object. */
function singleServerName(entry) {
  if (typeof entry.serverName === "string" && entry.serverName.trim().length > 0) return entry.serverName.trim();
  return "mcp";
}

/**
 * Turn one pasted config object into raw `{ serverName, entry }` pairs.
 *
 * Structural problems throw; a single malformed entry stays in the list so the
 * per-entry conversion can report it as skipped.
 *
 * @param root - extracted JSON object.
 * @param warnings - collector for non-fatal notes.
 * @returns raw server entries.
 */
function rawServerEntries(root, warnings) {
  if (isRecord(root.mcpServers)) {
    const entries = mapEntries(root.mcpServers);
    if (entries.length === 0) warnings.push("mcpServers 里没有任何 server 配置");
    return entries;
  }
  if (root.mcpServers !== undefined) throw invalid("mcpServers 必须是对象（名称 → server 配置的映射）");

  if (looksLikeSingleServer(root)) {
    return [{ serverName: singleServerName(root), entry: root }];
  }

  const entries = mapEntries(root);
  if (entries.length === 0) warnings.push("粘贴的 JSON 里没有任何 server 配置");
  return entries;
}

/** Map a `name → entry` record into raw pairs, preserving order. */
function mapEntries(record) {
  return Object.entries(record).map(([serverName, entry]) => ({ serverName, entry }));
}

/**
 * Normalize the transport declared by one entry, warning for lossy aliases.
 *
 * @param entry - raw server config.
 * @param serverName - owning name, for warnings and messages.
 * @param warnings - collector.
 * @returns `'stdio' | 'streamable-http'`.
 */
function normalizeTransport(entry, serverName, warnings) {
  const declared = entry.type ?? entry.transport;
  if (declared !== undefined) {
    if (typeof declared !== "string") throw invalid(`${serverName}: type/transport 必须是字符串`);
    const key = declared.trim().toLowerCase();
    if (key === "stdio") return "stdio";
    if (key === "sse") {
      warnings.push(`${serverName}: type "sse" 已按 streamable-http 处理（旧版 SSE 端点通常兼容）`);
      return "streamable-http";
    }
    if (key === "streamable-http" || key === "streamablehttp" || key === "streamable_http" || key === "http" || key === "https") {
      return "streamable-http";
    }
    throw invalid(`${serverName}: 不支持的 type/transport ${JSON.stringify(declared)}（支持 streamable-http/http/streamableHttp/stdio/sse）`);
  }
  if (typeof entry.command === "string" && entry.command.trim().length > 0) return "stdio";
  if (urlOf(entry) !== undefined) return "streamable-http";
  throw invalid(`${serverName}: 无法判断传输方式（缺少 type/transport，且既没有 command 也没有 url）`);
}

/**
 * Convert one raw server entry into the manager's ServerInput shape.
 *
 * @param serverName - name from the surrounding map key or fallback.
 * @param entry - raw server config.
 * @param warnings - collector for non-fatal notes.
 * @returns a ServerInput-compatible object (still needs `validateServerInput`).
 */
export function toServerInput(serverName, entry, warnings = []) {
  if (!isRecord(entry)) throw invalid(`${serverName}: server 配置必须是对象`);
  const transport = normalizeTransport(entry, serverName, warnings);
  if (!TRANSPORTS.has(transport)) throw invalid(`${serverName}: 不支持的传输方式 ${transport}`);

  const input = { serverName, transport };

  if (transport === "stdio") {
    input.command = entry.command;
    if (entry.args !== undefined) input.args = entry.args;
    if (entry.env !== undefined) input.env = entry.env;
    if (entry.cwd !== undefined) input.cwd = entry.cwd;
  } else {
    const url = urlOf(entry);
    if (url === undefined) throw invalid(`${serverName}: streamable-http 配置缺少 url/serverUrl/endpoint`);
    input.url = url;
    if (entry.headers !== undefined) input.headers = entry.headers;
  }

  if (entry.toolCallTimeoutMs !== undefined) input.toolCallTimeoutMs = entry.toolCallTimeoutMs;
  if (entry.enabled !== undefined) input.enabled = entry.enabled;
  return input;
}

/**
 * Convert a pasted config text into ServerInput candidates.
 *
 * Structural failures (not JSON, unrecognizable shape) throw INVALID_INPUT;
 * per-entry conversion failures are returned in `errors` so the import can
 * continue with the other entries.
 *
 * @param text - pasted text.
 * @returns `{ servers: [{serverName, input}], errors: [{serverName, reason}], warnings: string[] }`.
 */
export function convertMcpServersText(text) {
  const warnings = [];
  const root = extractJsonObject(text);
  const raw = rawServerEntries(root, warnings);
  const servers = [];
  const errors = [];
  for (const { serverName, entry } of raw) {
    try {
      servers.push({ serverName: String(serverName), input: toServerInput(String(serverName), entry, warnings) });
    } catch (error) {
      errors.push({
        serverName: String(serverName),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { servers, errors, warnings };
}

/**
 * Apply batch defaults to one ServerInput candidate.
 *
 * Defaults are defaults, not overrides: a field the pasted entry declares
 * itself always wins (an explicit `enabled: false` or `toolCallTimeoutMs` is
 * preserved).
 *
 * @param input - converted ServerInput candidate.
 * @param defaults - `{ enabled?, toolCallTimeoutMs? }` from the import payload.
 * @returns a copy with defaults filled in.
 */
export function applyImportDefaults(input, defaults = {}) {
  const effective = { ...input };
  if (effective.enabled === undefined && defaults.enabled !== undefined) effective.enabled = defaults.enabled;
  if (effective.toolCallTimeoutMs === undefined && defaults.toolCallTimeoutMs !== undefined) effective.toolCallTimeoutMs = defaults.toolCallTimeoutMs;
  return effective;
}

/**
 * Validate converted candidates and merge them against the current registry.
 *
 * Pure: the caller persists and mounts `specs`.
 *
 * @param options.servers - `[{serverName, input}]` from {@link convertMcpServersText}.
 * @param options.existingNames - names already in the manifest.
 * @param options.hostNames - names the host already mounts; those are skipped as
 *   `EXISTS_HOST_CONFIG` (the bridge would reject a duplicate namespace).
 * @param options.replace - overwrite existing manifest entries when true.
 * @param options.defaultToolCallTimeoutMs - plugin-level default per-server call timeout.
 * @param options.defaults - batch defaults from the import payload:
 *   `{ enabled?, toolCallTimeoutMs? }`. They only fill a field a pasted entry
 *   does not declare itself (entry wins).
 * @returns `{ specs: [{spec, replace}], added: string[], skipped: [{serverName, reason}] }`.
 */
export function mergeImportedServers(options) {
  const existing = new Set(options.existingNames ?? []);
  const hostNames = new Set(options.hostNames ?? []);
  const replace = options.replace === true;
  const defaults = options.defaults ?? {};
  const added = [];
  const skipped = [];
  const specs = [];
  for (const { serverName, input } of options.servers ?? []) {
    try {
      const effective = applyImportDefaults(input, defaults);
      const spec = validateServerInput(effective, { defaultToolCallTimeoutMs: options.defaultToolCallTimeoutMs });
      if (existing.has(spec.serverName) && !replace) {
        skipped.push({ serverName: spec.serverName, reason: "EXISTS" });
        continue;
      }
      if (hostNames.has(spec.serverName)) {
        skipped.push({ serverName: spec.serverName, reason: "EXISTS_HOST_CONFIG" });
        continue;
      }
      specs.push({ spec, replace: existing.has(spec.serverName) });
      added.push(spec.serverName);
    } catch (error) {
      skipped.push({
        serverName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { specs, added, skipped };
}

/**
 * Validate converted candidates without touching the registry (importTest).
 *
 * @param options.servers - `[{serverName, input}]` from {@link convertMcpServersText}.
 * @param options.defaults - batch defaults `{ enabled?, toolCallTimeoutMs? }`.
 * @param options.defaultToolCallTimeoutMs - plugin-level timeout default.
 * @returns `{ specs, errors: [{serverName, message}] }`.
 */
export function prepareImportedServers(options) {
  const defaults = options.defaults ?? {};
  const specs = [];
  const errors = [];
  for (const { serverName, input } of options.servers ?? []) {
    try {
      const effective = applyImportDefaults(input, defaults);
      specs.push(validateServerInput(effective, { defaultToolCallTimeoutMs: options.defaultToolCallTimeoutMs }));
    } catch (error) {
      errors.push({
        serverName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { specs, errors };
}

/**
 * Run a batch connectivity test without persisting anything.
 *
 * The caller injects `probe`, which owns secret resolution and the actual SDK
 * connection; this function only owns ordering, the 10-server cap, per-entry
 * isolation and the response shape.
 *
 * @param options.converted - result of {@link convertMcpServersText}.
 * @param options.prepared - result of {@link prepareImportedServers}.
 * @param options.probe - async `(spec) => probeResult`.
 * @param options.limit - maximum servers tested (default 10).
 * @returns `{ results, parseErrors, skipped }`.
 */
export async function runImportTest(options) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 10;
  const parseErrors = [
    ...(options.converted?.errors ?? []).map((entry) => ({ serverName: entry.serverName, message: entry.reason })),
    ...(options.prepared?.errors ?? []).map((entry) => ({ serverName: entry.serverName, message: entry.message })),
  ];
  const specs = options.prepared?.specs ?? [];
  const testable = specs.slice(0, limit);
  const skipped = specs.slice(limit).map((spec) => spec.serverName);
  const results = [];
  for (const spec of testable) {
    try {
      const probed = await options.probe(spec);
      results.push({
        serverName: spec.serverName,
        ok: probed?.ok === true,
        latencyMs: typeof probed?.latencyMs === "number" ? probed.latencyMs : 0,
        tools: Array.isArray(probed?.tools) ? probed.tools : [],
        ...(probed?.protocolVersion === undefined ? {} : { protocolVersion: probed.protocolVersion }),
        ...(probed?.serverInfo === undefined ? {} : { serverInfo: probed.serverInfo }),
        ...(probed?.error === undefined ? {} : { error: probed.error }),
      });
    } catch (error) {
      results.push({
        serverName: spec.serverName,
        ok: false,
        latencyMs: 0,
        tools: [],
        error: { code: "unknown", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return { results, parseErrors, skipped };
}
