import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLinkedInClient, schemas, REACTIONS } from '../apps/linkedin/client.js';
import { getLinkedInConfig } from '../apps/linkedin/config.js';
import { createHttpServer } from '../server/index.js';

const config = { accessToken: 'test-secret-never-real', personUrn: 'urn:li:person:abc123', version: '202609', writeEnabled: true };
const inputs = {
  linkedin_publish_text_post: { text: 'Practical security lesson.', approved: true },
  linkedin_create_comment: { targetUrn: 'urn:li:share:123', text: 'A useful question.', approved: true },
  linkedin_reply_to_comment: { parentCommentUrn: 'urn:li:comment:(urn:li:activity:123,456)', rootPostUrn: 'urn:li:activity:123', text: 'A useful reply.', approved: true },
  linkedin_add_reaction: { targetUrn: 'urn:li:share:123', reactionType: 'LIKE', approved: true },
  linkedin_remove_reaction: { targetUrn: 'urn:li:share:123', approved: true },
};
function fixture(overrides = {}, response = () => new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:987' } })) {
  const calls = [];
  const client = createLinkedInClient({ config: { ...config, ...overrides }, fetchImpl: async (...args) => { calls.push(args); return response(); } });
  return { client, calls };
}
test('default config and status work without credentials or network', async () => {
  const value = getLinkedInConfig({});
  const { client, calls } = fixture(value);
  assert.equal(value.writeEnabled, false);
  const status = await client.execute('linkedin_connection_status', {});
  assert.equal(status.configured, false); assert.equal(status.connectionVerified, false);
  assert.deepEqual(status.issues, ['Missing LINKEDIN_ACCESS_TOKEN', 'Missing LINKEDIN_PERSON_URN']);
  assert.equal(calls.length, 0);
});
for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ']) test('write flag fails closed: ' + String(value), () => {
  assert.equal(getLinkedInConfig({ LINKEDIN_WRITE_ENABLED: value }).writeEnabled, false);
});
for (const [name, input] of Object.entries(inputs)) {
  test(name + ' refuses disabled writes even with approval', async () => {
    const { client, calls } = fixture({ writeEnabled: false });
    await assert.rejects(client.execute(name, input), /disabled/); assert.equal(calls.length, 0);
  });
  for (const approved of [undefined, false, 'true', 1, null, {}]) test(name + ' refuses approval ' + JSON.stringify(approved), async () => {
    const { client, calls } = fixture();
    await assert.rejects(client.execute(name, { ...input, approved }), /approval/); assert.equal(calls.length, 0);
  });
  for (const missing of ['accessToken', 'personUrn']) test(name + ' refuses missing ' + missing, async () => {
    const { client, calls } = fixture({ [missing]: '' });
    await assert.rejects(client.execute(name, input), /Missing/); assert.equal(calls.length, 0);
  });
}
for (const personUrn of ['urn:li:organization:1', 'urn:li:person:', 'urn:li:person:abc/../', 'https://linkedin.com/in/abc']) test('reject malformed member ' + personUrn, async () => {
  const { client, calls } = fixture({ personUrn });
  await assert.rejects(client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), /personal member/);
  assert.equal(calls.length, 0);
});
for (const [name, field] of [['linkedin_create_comment', 'targetUrn'], ['linkedin_reply_to_comment', 'parentCommentUrn'], ['linkedin_reply_to_comment', 'rootPostUrn'], ['linkedin_add_reaction', 'targetUrn'], ['linkedin_remove_reaction', 'targetUrn']]) {
  for (const bad of ['', 'urn:li:person:abc', 'urn:li:share:123?token=bad', 'urn:li:comment:123']) test(name + ' validates ' + field + ': ' + bad, async () => {
    const { client, calls } = fixture();
    await assert.rejects(client.execute(name, { ...inputs[name], [field]: bad }), /Invalid/); assert.equal(calls.length, 0);
  });
}
test('reject invalid version before network', async () => {
  const { client, calls } = fixture({ version: '202613' });
  await assert.rejects(client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), /YYYYMM/); assert.equal(calls.length, 0);
});
test('reject inconsistent reply activity', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.execute('linkedin_reply_to_comment', { ...inputs.linkedin_reply_to_comment, rootPostUrn: 'urn:li:activity:999' }), /does not belong/); assert.equal(calls.length, 0);
});
test('mock post uses exact approved text, author and required headers', async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), { id: 'urn:li:share:987', status: 201 });
  const [url, init] = calls[0]; const payload = JSON.parse(init.body);
  assert.equal(url, 'https://api.linkedin.com/rest/posts');
  assert.equal(payload.commentary, inputs.linkedin_publish_text_post.text);
  assert.equal(payload.author, config.personUrn); assert.equal(payload.lifecycleState, 'PUBLISHED');
  assert.equal(payload.visibility, 'PUBLIC'); assert.equal(payload.distribution.feedDistribution, 'MAIN_FEED');
  assert.equal(init.headers['Linkedin-Version'], '202609');
  assert.equal(init.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
});
test('mock comment has encoded target and actor', async () => {
  const { client, calls } = fixture();
  await client.execute('linkedin_create_comment', inputs.linkedin_create_comment);
  assert.equal(calls[0][0], 'https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A123/comments');
  assert.deepEqual(JSON.parse(calls[0][1].body), { actor: config.personUrn, object: 'urn:li:share:123', message: { text: 'A useful question.' } });
});
test('mock nested reply preserves parent and root', async () => {
  const { client, calls } = fixture();
  await client.execute('linkedin_reply_to_comment', inputs.linkedin_reply_to_comment);
  assert.equal(calls[0][0], 'https://api.linkedin.com/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A123%2C456%29/comments');
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.parentComment, inputs.linkedin_reply_to_comment.parentCommentUrn);
  assert.equal(payload.object, 'urn:li:activity:123');
});
test('reaction labels match documented enum', () => {
  assert.deepEqual(REACTIONS, { LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny' });
});
for (const reactionType of Object.keys(REACTIONS)) test('mock reaction ' + reactionType, async () => {
  const { client, calls } = fixture();
  await client.execute('linkedin_add_reaction', { ...inputs.linkedin_add_reaction, reactionType });
  assert.equal(calls[0][0], 'https://api.linkedin.com/rest/reactions?actor=urn%3Ali%3Aperson%3Aabc123');
  assert.deepEqual(JSON.parse(calls[0][1].body), { root: 'urn:li:share:123', reactionType });
});
for (const reactionType of ['MAYBE', 'LOVE', 'like', '', null]) test('reject unsupported reaction ' + reactionType, async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.execute('linkedin_add_reaction', { ...inputs.linkedin_add_reaction, reactionType }), /Invalid/); assert.equal(calls.length, 0);
});
test('mock comment reaction and removal encode composite identifier', async () => {
  const { client, calls } = fixture({}, () => new Response(null, { status: 204 }));
  const targetUrn = inputs.linkedin_reply_to_comment.parentCommentUrn;
  await client.execute('linkedin_add_reaction', { ...inputs.linkedin_add_reaction, targetUrn });
  assert.equal(JSON.parse(calls[0][1].body).root, targetUrn);
  assert.deepEqual(await client.execute('linkedin_remove_reaction', { targetUrn, approved: true }), { removed: true, targetUrn });
  assert.equal(calls[1][1].method, 'DELETE'); assert.equal(calls[1][1].body, undefined);
  assert.equal(calls[1][0], 'https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aperson%3Aabc123,entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A123%2C456%29)');
});
for (const status of [301, 302, 307, 400, 401, 403, 429, 500]) test('safe failed post HTTP ' + status, async () => {
  const { client } = fixture({}, () => new Response(config.accessToken, { status, statusText: config.accessToken }));
  await assert.rejects(client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), error => {
    assert.ok(error.message.includes('HTTP ' + status));
    assert.ok(!JSON.stringify(error).includes(config.accessToken)); assert.ok(!error.stack.includes(config.accessToken));
    assert.equal(error.body, undefined); assert.equal(error.cause, undefined); return true;
  });
});
test('network exception never leaks token', async () => {
  const { client } = fixture({}, () => { throw new Error(config.accessToken); });
  await assert.rejects(client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), error => !error.stack.includes(config.accessToken) && !error.cause);
});
test('successful response echoes are not returned', async () => {
  const { client } = fixture({}, () => new Response(JSON.stringify({ id: config.accessToken, access_token: config.accessToken }), { status: 201 }));
  assert.deepEqual(await client.execute('linkedin_publish_text_post', inputs.linkedin_publish_text_post), { id: null, status: 201 });
});
for (const value of ['', '   ', 'x'.repeat(3001)]) test('post rejects empty/oversize text: ' + value.length, async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.execute('linkedin_publish_text_post', { text: value, approved: true }), /Invalid/); assert.equal(calls.length, 0);
});
test('HTTP MCP handshake lists all six tools and refuses unapproved writes', async t => {
  const { client, calls } = fixture();
  const http = createHttpServer({ client });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = 'http://127.0.0.1:' + http.address().port;
  const mcp = new Client({ name: 'local-test', version: '1.0.0' });
  t.after(async () => { await mcp.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  assert.equal((await fetch(url + '/health')).status, 200);
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), Object.keys(schemas).sort());
  const resources = await mcp.listResources();
  assert.equal(resources.resources.length, 18);
  const voice = await mcp.readResource({ uri: 'linkedin-agent://context/brand/abdul/voice.md' });
  assert.ok(voice.contents[0].text.includes('Gadu Abdul'));
  const status = await mcp.callTool({ name: 'linkedin_connection_status', arguments: {} });
  assert.equal(status.structuredContent.connectionVerified, false);
  for (const [name, input] of Object.entries(inputs)) {
    for (const approved of [false, undefined, 'true']) {
      const result = await mcp.callTool({ name, arguments: { ...input, approved } });
      assert.equal(result.isError, true);
    }
  }
  assert.equal(calls.length, 0);
  const good = await mcp.callTool({ name: 'linkedin_publish_text_post', arguments: inputs.linkedin_publish_text_post });
  assert.equal(good.structuredContent.success, true); assert.equal(calls.length, 1);
  const blocked = await fetch(url + '/mcp', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(url + '/health', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(url + '/mcp')).status, 405);
});
test('actual entrypoint starts with missing LinkedIn credentials', async t => {
  const probe = createHttpServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), LINKEDIN_ACCESS_TOKEN: '', LINKEDIN_PERSON_URN: '', LINKEDIN_WRITE_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Startup timeout')), 5000).unref())]);
  assert.ok(output.includes('/mcp'));
  assert.equal((await fetch('http://127.0.0.1:' + port + '/health')).status, 200);
});

for (const overrides of [{ writeEnabled: false }, { accessToken: '' }, { personUrn: '' }]) test('MCP refuses all writes for ' + JSON.stringify(overrides), async t => {
  const { client, calls } = fixture(overrides);
  const http = createHttpServer({ client }); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const mcp = new Client({ name: 'safety-test', version: '1.0.0' });
  t.after(async () => { await mcp.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + http.address().port + '/mcp')));
  for (const [name, input] of Object.entries(inputs)) assert.equal((await mcp.callTool({ name, arguments: input })).isError, true);
  assert.equal(calls.length, 0);
});

test('MCP API errors do not expose access tokens', async t => {
  const { client } = fixture({}, () => new Response(config.accessToken, { status: 403, statusText: config.accessToken }));
  const http = createHttpServer({ client }); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const mcp = new Client({ name: 'error-test', version: '1.0.0' });
  t.after(async () => { await mcp.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + http.address().port + '/mcp')));
  const result = await mcp.callTool({ name: 'linkedin_publish_text_post', arguments: inputs.linkedin_publish_text_post });
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(config.accessToken));
});
