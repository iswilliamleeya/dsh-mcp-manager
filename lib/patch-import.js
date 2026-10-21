/**
 * Patch-file import for dsh-mcp-manager.
 *
 * Reads a Cordis patch layer (`cordis.patch.yml`) and extracts the rows that mount
 * `@deepseek-ai/dsh-mcp-client`, translating each into the manager's tool-input spec
 * shape so an existing hand-written row can be adopted instead of retyped.
 *
 * The harness patch format allows `!!js` expressions (the in-box MCP layer uses one for
 * `Bearer ${process.env.MCP_UNIFUNCS_API_KEY}`). This reader keeps such an expression as
 * its raw source and only translates the `${process.env.VAR}` form into the manager's
 * `env:VAR` indirection; anything it cannot translate is reported instead of guessed.
 *
 * @module dsh-mcp-manager/patch-import
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";

/** YAML tag used by patch files for embedded JavaScript expressions. */
const JS_TAG = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value) => ({ __dshJsExpression: String(value) })
};

/** The plugin name a mountable MCP row uses in a patch file. */
const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";

/** Environment reference inside a `!!js` expression. */
const PROCESS_ENV_PATTERN = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/;

/** Read one patch value that may be a plain string or a `!!js` expression. */
function readValue(value, what) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && typeof value.__dshJsExpression === "string") {
    const match = PROCESS_ENV_PATTERN.exec(value.__dshJsExpression);
    if (match === null) {
      throw new Error(`${what} uses a !!js expression this importer cannot translate (${value.__dshJsExpression}); add the server with mcp_manager_add and env: indirection instead`);
    }
    return `env:${match[1]}`;
  }
  throw new Error(`${what} must be a string`);
}

/** Convert one record field into the manager's `[{name, value}]` entry array. */
function recordToEntries(record, what) {
  if (record === undefined) return undefined;
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error(`${what} must be a mapping`);
  return Object.entries(record).map(([key, value]) => ({ name: key, value: readValue(value, `${what}.${key}`) }));
}

/**
 * Read the MCP rows out of one patch file.
 * @param file - absolute path of the patch file.
 * @returns one spec-shaped row per `@deepseek-ai/dsh-mcp-client` insert row.
 */
function parsePatchFile(file) {
  const text = readFileSync(file, "utf8");
  const document = YAML.parse(text, { customTags: [JS_TAG] });
  const entries = Array.isArray(document) ? document : [];
  const rows = [];
  for (const entry of entries) {
    const inserts = entry?.insert;
    if (!Array.isArray(inserts)) continue;
    for (const row of inserts) {
      if (row?.name !== MCP_CLIENT_PLUGIN) continue;
      const config = row.config ?? {};
      const spec = {
        serverName: config.serverName,
        transport: config.transport,
        enabled: true
      };
      if (config.toolCallTimeoutMs !== undefined) spec.toolCallTimeoutMs = config.toolCallTimeoutMs;
      if (config.transport === "stdio") {
        spec.command = readValue(config.command, `${config.serverName}.command`);
        if (Array.isArray(config.args)) spec.args = config.args.map((argument) => readValue(argument, `${config.serverName}.args`));
        if (config.cwd !== undefined) spec.cwd = String(config.cwd);
        const env = recordToEntries(config.env, `${config.serverName}.env`);
        if (env !== undefined) spec.env = env;
      } else {
        spec.url = readValue(config.url, `${config.serverName}.url`);
        const headers = recordToEntries(config.headers, `${config.serverName}.headers`);
        if (headers !== undefined) spec.headers = headers;
      }
      rows.push(spec);
    }
  }
  return rows;
}

export { parsePatchFile };
