/**
 * Connectivity testing for dsh-mcp-manager.
 *
 * The probe is deliberately independent of the mounted bridge: it opens its own
 * MCP SDK client, performs `initialize` + `tools/list`, records latency,
 * protocol version, server info and the tool list, then closes. A running
 * mounted connection is never touched, so "test connection" cannot disturb a
 * live server.
 *
 * The SDK package used by the harness (`@modelcontextprotocol/client`) is
 * loaded dynamically: this module stays importable in unit tests that do not
 * have the harness dependency closure on their resolution path.
 *
 * @module dsh-mcp-manager/probe
 */
import { resolveEnvValue } from "./manifest.js";

/** Error classes surfaced by a probe. */
export const PROBE_ERROR_CODES = Object.freeze(["timeout", "auth", "transport", "protocol", "unknown"]);

/** Node/undici error codes that mean "could not reach or keep the transport". */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_INVALID_URL",
  "ERR_MODULE_NOT_FOUND",
  "ENOENT",
  "EACCES",
  "EPERM",
]);

/** Message fragments that identify each class, checked in this order. */
const AUTH_PATTERN = /(?:\bHTTP\b|\bstatus\b)?[\s:]*\b401\b|(?:\bHTTP\b|\bstatus\b)?[\s:]*\b403\b|unauthori[sz]ed|forbidden|invalid[_ -]?token|authentication (?:failed|required)|missing (?:api )?key/i;
const TIMEOUT_PATTERN = /timed out|timeout|TimeoutError|ETIMEDOUT/i;
const TRANSPORT_PATTERN = /fetch failed|socket hang up|connection (?:closed|reset|refused|failed)|network|transport|spawn|terminated|not connected|disconnected|ECONNREFUSED|ENOTFOUND/i;
const PROTOCOL_PATTERN = /JSON-?RPC|protocol|negotiat|unsupported protocol|invalid (?:message|response|result|params)|initialize|schema|Malformed/i;

/**
 * Scrub the ambient environment the same way the in-box bridge does before
 * spawning a stdio server: credential-shaped names and `DSH_*` are dropped, and
 * the server's own configured `env` merges on top.
 *
 * @param env - source environment (defaults to `process.env`).
 * @returns a plain record of string values.
 */
export function scrubParentEnv(env = process.env) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
    if (/^DSH_/.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

/**
 * Wrap one promise with a timeout that rejects with a `MCP_MANAGER_TIMEOUT`
 * error (recognisable by {@link classifyProbeError}).
 *
 * @param promise - work to bound.
 * @param ms - timeout in milliseconds (non-positive = unbounded).
 * @param what - label for the message.
 * @returns the wrapped promise.
 */
export function withTimeout(promise, ms, what) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`mcp-manager: ${what} timed out after ${ms}ms`);
      error.code = "MCP_MANAGER_TIMEOUT";
      reject(error);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** True for an HTTP status carried by an SDK error object rather than a message. */
function httpStatusOf(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status];
  for (const candidate of candidates) {
    if (candidate === 401 || candidate === 403) return candidate;
  }
  return undefined;
}

/**
 * Classify a probe failure into the contract's five classes.
 *
 * @param error - anything thrown by the SDK/transport.
 * @returns `'timeout' | 'auth' | 'transport' | 'protocol' | 'unknown'`.
 */
export function classifyProbeError(error) {
  if (error === null || error === undefined) return "unknown";
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "MCP_MANAGER_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "ABORT_ERR") {
    return "timeout";
  }
  if (httpStatusOf(error) !== undefined) return "auth";
  const message = error instanceof Error ? error.message : String(error?.message ?? error);
  if (TIMEOUT_PATTERN.test(message)) return "timeout";
  if (AUTH_PATTERN.test(message)) return "auth";
  /* JSON-RPC error codes live in [-32768, -32000]. */
  if (typeof error?.code === "number" && error.code <= -32000 && error.code >= -32768) return "protocol";
  if (typeof code === "string" && TRANSPORT_CODES.has(code)) return "transport";
  if (code === "ERR_BAD_REQUEST" || code === "UND_ERR_SOCKET" || code === "UND_ERR_CLOSED") return "transport";
  if (TRANSPORT_PATTERN.test(message)) return "transport";
  if (PROTOCOL_PATTERN.test(message)) return "protocol";
  return "unknown";
}

/** Read the connected server's reported implementation, defensively. */
function readServerInfo(client) {
  try {
    const version = typeof client.getServerVersion === "function" ? client.getServerVersion() : undefined;
    if (version === null || version === undefined) return undefined;
    if (typeof version === "object") {
      const info = {};
      if (typeof version.name === "string") info.name = version.name;
      if (typeof version.version === "string") info.version = version.version;
      return Object.keys(info).length > 0 ? info : undefined;
    }
    if (typeof version === "string") return { name: version };
  } catch {
    /* optional metadata */
  }
  return undefined;
}

/** Read the negotiated protocol version, defensively (SDK shape varies). */
function readProtocolVersion(client) {
  const readers = ["getNegotiatedProtocolVersion", "negotiatedProtocolVersion"];
  for (const reader of readers) {
    try {
      const value = typeof client?.[reader] === "function" ? client[reader]() : client?.[reader];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      /* optional metadata */
    }
  }
  if (typeof client?.protocolVersion === "string" && client.protocolVersion.length > 0) return client.protocolVersion;
  return undefined;
}

/**
 * Close an SDK client without letting a broken transport wedge the caller.
 * @param client - SDK client (may be undefined).
 * @param timeoutMs - bound for the close operation.
 */
export async function closeClientQuietly(client, timeoutMs = 2000) {
  if (client === null || client === undefined) return;
  try {
    await withTimeout(Promise.resolve(client.close()), timeoutMs, "closing the probe client");
  } catch {
    /* the probe owns nothing the caller depends on */
  }
}

/**
 * Build one standalone SDK client/transport for a server spec.
 *
 * @param spec - canonical server spec (as stored in the manifest).
 * @param options.timeoutMs - connect bound.
 * @param options.env - environment source for `env:` resolution (defaults to `process.env`).
 * @param options.name - client implementation name.
 * @param options.version - client implementation version.
 * @returns `{ client, transport, connectMs }`.
 */
export async function openClient(spec, options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 60000;
  const [{ Client, StreamableHTTPClientTransport }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);
  const client = new Client(
    { name: options.name ?? "dsh-mcp-manager", version: options.version ?? "0.2.0" },
    { capabilities: {} },
  );
  let transport;
  if (spec.transport === "stdio") {
    const extraEnv = {};
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      extraEnv[key] = resolveEnvValue(value, `env.${key}`, env);
    }
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...scrubParentEnv(env), ...extraEnv },
      cwd: typeof spec.cwd === "string" && spec.cwd.length > 0 ? spec.cwd : undefined,
      stderr: "ignore",
    });
  } else {
    const headers = {};
    for (const [key, value] of Object.entries(spec.headers ?? {})) {
      headers[key] = resolveEnvValue(value, `headers.${key}`, env);
    }
    transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers } });
  }
  const started = Date.now();
  try {
    await withTimeout(Promise.resolve(client.connect(transport)), timeoutMs, `connect to "${spec.serverName}"`);
  } catch (error) {
    await closeClientQuietly(client);
    throw error;
  }
  return { client, transport, connectMs: Date.now() - started };
}

/** Normalize one `tools/list` entry for the RPC contract. */
function toolView(tool) {
  const view = { name: typeof tool?.name === "string" ? tool.name : String(tool?.name ?? "") };
  if (typeof tool?.description === "string" && tool.description.length > 0) view.description = tool.description.slice(0, 400);
  return view;
}

/**
 * Probe one server: connect, `tools/list`, report, close.
 *
 * Never throws; the failure shape is `{ ok: false, error: { code, message }, latencyMs }`.
 *
 * @param spec - canonical spec (an unsaved ServerInput is normalized by the caller).
 * @param options.timeoutMs - per-phase bound (connect and tools/list).
 * @param options.env - environment source.
 * @returns the probe value.
 */
export async function probeServer(spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const started = Date.now();
  let client;
  try {
    const opened = await openClient(spec, { ...options, timeoutMs });
    client = opened.client;
    /* Optional metadata is read while the connection is live. */
    const protocolVersion = readProtocolVersion(client);
    const serverInfo = readServerInfo(client);
    let tools = [];
    let capabilities;
    try {
      capabilities = typeof client.getServerCapabilities === "function" ? client.getServerCapabilities() : undefined;
    } catch {
      capabilities = undefined;
    }
    /* A server that does not advertise the tools capability has no tools to
       list; calling tools/list anyway would report a healthy server as broken. */
    if (capabilities === undefined || capabilities?.tools !== undefined) {
      const listed = await withTimeout(
        Promise.resolve(client.listTools(undefined, { cacheMode: "refresh" })),
        timeoutMs,
        `tools/list on "${spec.serverName}"`,
      );
      tools = Array.isArray(listed?.tools) ? listed.tools.map(toolView) : [];
    }
    await closeClientQuietly(client);
    client = undefined;
    return {
      ok: true,
      latencyMs: opened.connectMs,
      totalMs: Date.now() - started,
      tools,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(serverInfo === undefined ? {} : { serverInfo }),
    };
  } catch (error) {
    await closeClientQuietly(client);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      tools: [],
      error: {
        code: classifyProbeError(error),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
