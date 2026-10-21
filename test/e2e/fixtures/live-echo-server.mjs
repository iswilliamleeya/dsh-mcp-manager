/**
 * Dependency-free MCP stdio server used for a live smoke test of dsh-mcp-manager.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and implements the
 * minimum a client needs: initialize, notifications/initialized, tools/list,
 * tools/call, ping. No npm packages, so the host can spawn it directly.
 */
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'mcp-live-echo', version: '0.0.1' };
const PROTOCOL_FALLBACK = '2025-06-18';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message ?? {};
  if (typeof method !== 'string') return;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      result(id, {
        protocolVersion: typeof requested === 'string' && requested.length > 0 ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, {
        tools: [{
          name: 'echo',
          description: 'Return the given text (live smoke test tool).',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo back.' } },
          },
        }],
      });
      return;
    case 'tools/call': {
      const name = params?.name;
      if (name !== 'echo') {
        result(id, { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true });
        return;
      }
      const text = params?.arguments?.text;
      result(id, { content: [{ type: 'text', text: `echo: ${typeof text === 'string' ? text : '(no text)'}` }] });
      return;
    }
    default:
      if (id !== undefined) error(id, -32601, `method not found: ${method}`);
  }
});
