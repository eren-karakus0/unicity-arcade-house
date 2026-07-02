/**
 * Minimal MCP stdio client: drives `astrid mcp serve` to list the capsule's
 * tools and execute them — no LLM involved, pure kernel tool dispatch.
 * Usage: node mcp-drive.mjs <toolName> '<jsonArgs>'
 */
import { spawn } from 'node:child_process';

const [, , toolName = '', argsJson = '{}'] = process.argv;
const srv = spawn('/opt/astrid9/astrid', ['mcp', 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* non-JSON line */
    }
  }
});
srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

let nextId = 1;
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
}
function notify(method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'arcade-qa', version: '1.0' },
});
console.log('INIT:', JSON.stringify(init.result?.serverInfo ?? init.error));
notify('notifications/initialized');

const tools = await rpc('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log('TOOLS:', JSON.stringify(names));

if (toolName) {
  const call = await rpc('tools/call', { name: toolName, arguments: JSON.parse(argsJson) }, 180000);
  console.log('CALL RESULT:', JSON.stringify(call.result ?? call.error, null, 1));
}
srv.kill();
process.exit(0);
