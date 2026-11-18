import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerLinkedInTools } from '../apps/linkedin/tools.js';
import { createLinkedInClient } from '../apps/linkedin/client.js';
export function createMcpServer(client = createLinkedInClient()) {
  const server = new McpServer({ name: 'linkedin-agent', version: '0.2.0' }, {
    instructions: 'Read relevant skills and brand/abdul context resources before drafting; brand/centrisec contains product facts. Map Claude voice.md to brand/abdul/voice.md, plan.md to storage/plans/plan.md, log.md to storage/logs/log.md. Preserve original content rules, then request separate explicit approval before an API action. Never invent proof. Connection status is configuration-only.',
  });
  registerLinkedInTools(server, client);
  // Fixed repository resources, never arbitrary filesystem paths or credentials.
  for (const directory of ['skills', 'brand/abdul', 'brand/centrisec']) {
    const base = new URL('../' + directory + '/', import.meta.url);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relative = directory === 'skills' ? entry.name + '/SKILL.md' : entry.name;
      if (directory === 'skills' ? !entry.isDirectory() : !entry.name.endsWith('.md')) continue;
      const uri = 'linkedin-agent://context/' + directory + '/' + relative;
      server.registerResource(directory + '/' + relative, uri, { mimeType: 'text/markdown' }, async () => ({
        contents: [{ uri, mimeType: 'text/markdown', text: readFileSync(new URL(relative, base), 'utf8') }],
      }));
    }
  }
  return server;
}
// Local foundation only; public deployment requires MCP authentication first.
export function createHttpServer({ client = createLinkedInClient() } = {}) {
  return createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) { res.writeHead(403).end('Invalid host'); return; }
    if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.origin)) { res.writeHead(403).end('Invalid origin'); return; }
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400).end('Invalid request URL'); return; }
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', service: 'linkedin-agent', mcp: '/mcp' })); return;
    }
    if (path !== '/mcp') { res.writeHead(404).end('Not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end('Stateless MCP supports POST only'); return; }
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end('MCP request failed'); else res.end(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env'); }
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const server = createHttpServer();
  server.on('error', () => { console.error('Local MCP server could not listen. Check port availability.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('LinkedIn Agent: http://127.0.0.1:' + port + '/mcp'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
