import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultHandler, exchangeLinkedInCode, matchesOwnerKey, mcpHandler } from '../worker/application.js';
const origin = 'https://agent.example';
const env = { PUBLIC_ORIGIN: origin, LINKEDIN_CLIENT_ID: 'test-app', LINKEDIN_CLIENT_SECRET: 'test-app-secret', OWNER_SETUP_KEY: 'owner-key-for-test-only-32-chars-long', LINKEDIN_WRITE_ENABLED: 'false' };
const request = (path, init) => new Request(origin + path, init);
test('owner key fails closed and uses exact value', async () => {
  assert.equal(await matchesOwnerKey(env.OWNER_SETUP_KEY, env.OWNER_SETUP_KEY), true);
  for (const bad of ['', null, 'wrong', env.OWNER_SETUP_KEY + ' ', 'x'.repeat(600)]) assert.equal(await matchesOwnerKey(bad, env.OWNER_SETUP_KEY), false);
  assert.equal(await matchesOwnerKey('short', 'short'), false);
});
test('worker health is safe and writes default off', async () => {
  const response = await defaultHandler(request('/health'), env, {});
  assert.deepEqual(await response.json(), { status: 'ok', service: 'linkedin-agent', writesEnabled: false });
});
test('callback refuses missing configuration', async () => {
  assert.equal((await defaultHandler(request('/oauth/linkedin/callback?code=secret'), {}, {})).status, 503);
});
test('callback refuses missing or replayed state without network', async () => {
  let network = 0;
  const response = await defaultHandler(request('/oauth/linkedin/callback?code=secret'), { ...env, OAUTH_PROVIDER: { finishUpstream: async () => { throw new Error('invalid state secret'); } } }, {}, async () => { network++; });
  assert.equal(response.status, 400); assert.equal(network, 0); assert.ok(!(await response.text()).includes('invalid state secret'));
});
test('consent page escapes client name and requires owner key', async () => {
  const oauth = {
    parseAuthRequest: async () => ({ scope: ['linkedin:actions'] }),
    describeConsent: async () => ({ clientName: '<script>bad</script>', redirectHost: 'client.example', clientDomain: null }),
    beginConsent: async () => ({ handle: 'test-handle', headers: new Headers({ 'set-cookie': 'test=browser-bound' }) }),
  };
  const response = await defaultHandler(request('/authorize'), { ...env, OAUTH_PROVIDER: oauth }, {});
  const body = await response.text();
  assert.ok(!body.includes('<script>bad</script>')); assert.ok(body.includes('Owner setup key'));
  assert.ok(body.includes('client.example')); assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
});
test('unrecognized MCP permissions refused before consent', async () => {
  const oauth = { parseAuthRequest: async () => ({ scope: ['admin:all'] }), describeConsent: async () => ({}) };
  assert.equal((await defaultHandler(request('/authorize'), { ...env, OAUTH_PROVIDER: oauth }, {})).status, 400);
});
test('cross-origin consent cannot submit', async () => {
  for (const suppliedOrigin of ['https://evil.example', 'null', null]) {
    const headers = suppliedOrigin === null ? {} : { origin: suppliedOrigin };
    assert.equal((await defaultHandler(request('/authorize', { method: 'POST', headers, body: new URLSearchParams({}) }), env, {})).status, 403);
  }
});
test('wrong owner key cannot start LinkedIn OAuth', async () => {
  let called = false;
  const response = await defaultHandler(request('/authorize', { method: 'POST', headers: { origin }, body: new URLSearchParams({ ownerKey: 'wrong', decision: 'approve', handle: 'test' }) }), { ...env, OAUTH_PROVIDER: { approveConsent() { called = true; } } }, {});
  assert.equal(response.status, 403); assert.equal(called, false);
});
test('approved owner consent uses browser-bound state and exact callback', async () => {
  const oauth = { approveConsent: async () => ({ request: { scope: ['linkedin:actions'] }, headers: new Headers() }), beginUpstream: async () => ({ state: 'browser-bound-test', headers: new Headers() }) };
  const response = await defaultHandler(request('/authorize', { method: 'POST', headers: { origin }, body: new URLSearchParams({ ownerKey: env.OWNER_SETUP_KEY, decision: 'approve', handle: 'test' }) }), { ...env, OAUTH_PROVIDER: oauth }, {});
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin, 'https://www.linkedin.com');
  assert.equal(target.searchParams.get('redirect_uri'), origin + '/oauth/linkedin/callback');
  assert.equal(target.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(target.searchParams.get('state'), 'browser-bound-test');
  assert.ok(!target.toString().includes(env.LINKEDIN_CLIENT_SECRET));
});
test('mock token exchange validates identity and expiry', async () => {
  const calls = [];
  const props = await exchangeLinkedInCode('test-code', env, async (url, init) => {
    calls.push([url, init]);
    return Response.json(url.includes('accessToken') ? { access_token: 'mock-member-token', expires_in: 3600 } : { sub: 'member_123' });
  });
  assert.equal(props.personUrn, 'urn:li:person:member_123'); assert.ok(props.expiresAt > Date.now());
  assert.equal(calls[0][1].body.get('redirect_uri'), origin + '/oauth/linkedin/callback');
  assert.equal(calls[0][1].body.get('client_secret'), env.LINKEDIN_CLIENT_SECRET);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer mock-member-token');
});
test('failed exchange never leaks upstream credentials', async () => {
  await assert.rejects(exchangeLinkedInCode('test-code', env, async () => new Response(env.LINKEDIN_CLIENT_SECRET, { status: 400 })), error => !error.stack.includes(env.LINKEDIN_CLIENT_SECRET));
});
for (const value of [{}, { access_token: '', expires_in: 300 }, { access_token: 'mock', expires_in: -1 }]) test('reject malformed OAuth token ' + JSON.stringify(value), async () => {
  await assert.rejects(exchangeLinkedInCode('test-code', env, async () => Response.json(value)), /invalid token/);
});
test('missing OIDC access fails before account link', async () => {
  let calls = 0;
  await assert.rejects(exchangeLinkedInCode('test-code', env, async () => ++calls === 1 ? Response.json({ access_token: 'mock', expires_in: 300 }) : new Response('', { status: 403 })), /OpenID Connect/);
});
test('worker MCP refuses invalid owner, scope and expiry', async () => {
  for (const ctx of [{}, { auth: { scope: ['linkedin:actions'] }, props: { owner: false } }, { auth: { scope: ['linkedin:actions'] }, props: { owner: true, expiresAt: 1 } }]) {
    assert.ok([401, 403].includes((await mcpHandler(request('/mcp', { method: 'POST' }), env, ctx)).status));
  }
});
test('Worker-native MCP lists six tools and refuses approved write when toggle off', async () => {
  const ctx = { auth: { scope: ['linkedin:actions'] }, props: { owner: true, expiresAt: Date.now() + 3600000, accessToken: 'mock-private-token', personUrn: 'urn:li:person:member123' } };
  const rpc = async (method, params) => {
    const response = await mcpHandler(request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env, ctx);
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await rpc('tools/list', {})).result.tools.length, 6);
  assert.equal((await rpc('resources/list', {})).result.resources.length, 18);
  const result = await rpc('tools/call', { name: 'linkedin_publish_text_post', arguments: { text: 'Test draft', approved: true } });
  assert.equal(result.result.isError, true); assert.ok(!JSON.stringify(result).includes('mock-private-token'));
});

test('callback explains allowlisted errors without reflecting upstream data or exchanging tokens', async () => {
  for (const error of ['unauthorized_scope_error', 'invalid_redirect_uri', 'user_cancelled_authorize', '<script>private-value</script>']) {
    let calls = 0;
    const oauth = { finishUpstream: async () => ({ data: { owner: true } }) };
    const query = new URLSearchParams({ error, error_description: 'private-description', code: 'private-code', state: 'private-state' });
    const response = await defaultHandler(request('/oauth/linkedin/callback?' + query), { ...env, OAUTH_PROVIDER: oauth }, {}, async () => { calls++; });
    const body = await response.text();
    assert.equal(response.status, 400); assert.equal(calls, 0);
    for (const secret of ['private-description', 'private-code', 'private-state', 'private-value']) assert.ok(!body.includes(secret));
    if (!error.startsWith('<')) assert.ok(body.includes(error));
  }
});
test('successful callback namespaces member identity safely for the OAuth provider', async () => {
  let completed;
  const oauth = {
    finishUpstream: async () => ({ data: { owner: true }, request: { scope: ['linkedin:actions'] }, headers: new Headers() }),
    completeAuthorization: async options => { completed = options; return { redirectTo: 'https://client.example/callback?code=mock-mcp-code' }; },
  };
  const response = await defaultHandler(request('/oauth/linkedin/callback?code=mock-code'), { ...env, OAUTH_PROVIDER: oauth }, {}, async url => Response.json(url.includes('accessToken') ? { access_token: 'mock-member-token', expires_in: 3600 } : { sub: 'member123' }));
  assert.equal(response.status, 302);
  assert.equal(completed.userId, 'urn%3Ali%3Aperson%3Amember123');
  assert.equal(completed.props.personUrn, 'urn:li:person:member123');
  assert.equal(response.headers.get('location'), 'https://client.example/callback?code=mock-mcp-code');
});

test('callback reports fixed safe failure stages without leaking errors', async () => {
  const secret = 'private-upstream-secret';
  const cases = [
    { oauth: { finishUpstream: async () => { throw new Error(secret); } }, fetch: async () => { throw new Error('must not call'); }, expected: 'Validating browser session' },
    { oauth: { finishUpstream: async () => ({ data: { owner: true } }) }, fetch: async () => Response.json({ error: 'invalid_client', error_description: secret }, { status: 401 }), expected: 'invalid_client' },
    { oauth: { finishUpstream: async () => ({ data: { owner: true } }) }, fetch: async url => url.includes('accessToken') ? Response.json({ access_token: secret, expires_in: 3600 }) : new Response(secret, { status: 403 }), expected: 'profile lookup failed' },
    { oauth: { finishUpstream: async () => ({ data: { owner: true }, request: { scope: [] } }), completeAuthorization: async () => { throw new Error(secret); } }, fetch: async url => Response.json(url.includes('accessToken') ? { access_token: secret, expires_in: 3600 } : { sub: 'member123' }), expected: 'Completing ChatGPT authorization' },
  ];
  for (const scenario of cases) {
    const response = await defaultHandler(request('/oauth/linkedin/callback?code=private-code&state=private-state'), { ...env, OAUTH_PROVIDER: scenario.oauth }, {}, scenario.fetch);
    const text = await response.text();
    assert.equal(response.status, 400); assert.ok(text.includes(scenario.expected));
    for (const value of [secret, 'private-code', 'private-state']) assert.ok(!text.includes(value));
  }
});
