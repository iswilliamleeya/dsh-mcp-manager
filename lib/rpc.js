/**
 * `/mcp-manager` RPC dispatch.
 *
 * The host plugin registers a prefix route and forwards each endpoint to this
 * framework-free dispatcher. The endpoint names and response shapes are the
 * contract the Desktop page (lib/client.js) is written against, so this module
 * validates payloads strictly and never leaks a raw exception to the wire.
 *
 * Envelope:
 *
 * - success: `{ ok: true, value }`
 * - failure: `{ ok: false, error: { code, message, details } }`
 *
 * `details` is always present (empty object) because the browser-side
 * `connection.rpc.call` response validator requires an object there.
 *
 * @module dsh-mcp-manager/rpc
 */
import { MAX_TOOL_CALL_TIMEOUT_MS } from "./manifest.js";

/** Endpoints served on `/mcp-manager`. */
export const RPC_ENDPOINTS = Object.freeze([
  "state",
  "server.add",
  "server.update",
  "server.remove",
  "server.toggle",
  "server.test",
  "server.import",
  "server.importTest",
  "status",
]);

/** Build an Error carrying an RPC error code. */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Reject malformed input. */
function invalid(message) {
  throw codedError("INVALID_INPUT", message);
}

/** True for a plain object payload. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Require an object payload. */
function requirePayload(payload) {
  if (!isRecord(payload)) invalid("payload must be an object");
  return payload;
}

/** Require a non-empty serverName. */
function requireServerName(payload) {
  const value = requirePayload(payload).serverName;
  if (typeof value !== "string" || value.trim().length === 0) invalid("serverName is required");
  return value.trim();
}

/** Normalize one failure into the contract's error object. */
function failure(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "MCP_MANAGER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}

/** Normalize one success value. */
function success(value) {
  return { ok: true, value };
}

/**
 * Validate and normalize the shared `{json, enabled?, toolCallTimeoutMs?}`
 * import payload used by `server.import` and `server.importTest`.
 *
 * @param input - RPC payload.
 * @param options.allowReplace - accept/pass `replace` (server.import only).
 * @returns the request object forwarded to the manager bridge.
 */
function buildImportRequest(input, options) {
  if (typeof input.json !== "string" || input.json.trim().length === 0) invalid("json is required");
  const request = { json: input.json };
  if (options.allowReplace === true) {
    if (input.replace !== undefined && typeof input.replace !== "boolean") invalid("replace must be a boolean");
    request.replace = input.replace === true;
  } else if (input.replace !== undefined) {
    invalid("replace is not accepted by server.importTest");
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") invalid("enabled must be a boolean");
    request.enabled = input.enabled;
  }
  if (input.toolCallTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(input.toolCallTimeoutMs) || input.toolCallTimeoutMs <= 0 || input.toolCallTimeoutMs > MAX_TOOL_CALL_TIMEOUT_MS) {
      invalid(`toolCallTimeoutMs must be an integer between 1 and ${MAX_TOOL_CALL_TIMEOUT_MS}`);
    }
    request.toolCallTimeoutMs = input.toolCallTimeoutMs;
  }
  return request;
}

/**
 * Create the RPC handler.
 *
 * @param bridge - the manager surface; every method may be async:
 *   `state()`, `addServer(input)`, `updateServer(input)`,
 *   `removeServer(serverName)`, `toggleServer(serverName, enabled)`,
 *   `testServer(input)`, `importServers({json, replace, enabled, toolCallTimeoutMs})`,
 *   `importTest({json, enabled, toolCallTimeoutMs})`, `status()`.
 * @returns `(endpoint, payload, signal?, peer?) => Promise<result>`.
 */
export function createManagerRpcHandler(bridge) {
  if (bridge === null || typeof bridge !== "object") throw new TypeError("createManagerRpcHandler requires a manager bridge");

  /** @param {string} endpoint @param {unknown} payload */
  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case "state":
        return success(await bridge.state());

      case "server.add": {
        return success(await bridge.addServer(requirePayload(payload)));
      }

      case "server.update": {
        const input = requirePayload(payload);
        requireServerName(input);
        return success(await bridge.updateServer(input));
      }

      case "server.remove": {
        const serverName = requireServerName(payload);
        await bridge.removeServer(serverName);
        return success({ removed: true });
      }

      case "server.toggle": {
        const serverName = requireServerName(payload);
        if (typeof payload.enabled !== "boolean") invalid("enabled must be a boolean");
        const enabled = await bridge.toggleServer(serverName, payload.enabled);
        return success({ enabled: typeof enabled === "boolean" ? enabled : payload.enabled });
      }

      case "server.test": {
        return success(await bridge.testServer(requirePayload(payload)));
      }

      case "server.import": {
        const input = requirePayload(payload);
        const request = buildImportRequest(input, { allowReplace: true });
        return success(await bridge.importServers(request));
      }

      case "server.importTest": {
        const input = requirePayload(payload);
        return success(await bridge.importTest(buildImportRequest(input, { allowReplace: false })));
      }

      case "status":
        return success({ status: await bridge.status() });

      default:
        throw codedError("UNKNOWN_ENDPOINT", `unknown endpoint: ${String(endpoint)}`);
    }
  }

  /**
   * @param endpoint - URL endpoint segment.
   * @param payload - parsed request payload.
   * @param _signal - request cancellation signal (unused; probe has its own bound).
   * @param peer - admitted peer; only the workspace owner may manage MCP servers.
   */
  return async function handleRpc(endpoint, payload, _signal, peer) {
    if (peer !== undefined && peer !== null && peer.principal !== undefined && peer.principal?.kind !== "owner") {
      return {
        ok: false,
        error: { code: "FORBIDDEN", message: "only the workspace owner may manage MCP servers", details: {} },
      };
    }
    try {
      return await dispatch(endpoint, payload ?? {});
    } catch (error) {
      return failure(error);
    }
  };
}
