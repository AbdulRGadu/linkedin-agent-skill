import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('workerd OAuth discovery, registration, consent and protected MCP smoke', async t => {
  const origin = 'https://agent.example';
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-agent', modules: true, scriptPath: '.wrangler/test-bundle/index.js', compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'],
    bindings: { PUBLIC_ORIGIN: origin, LINKEDIN_CLIENT_ID: 'mock-app', LINKEDIN_CLIENT_SECRET: 'mock-secret', OWNER_SETUP_KEY: 'owner-key-for-test-only-32-chars-long', LINKEDIN_WRITE_ENABLED: 'false' } }));
  t.after(() => mf.dispose());
  const health = await mf.dispatchFetch(origin + '/health'); assert.equal(health.status, 200);
  assert.equal((await health.json()).writesEnabled, false);
  const blocked = await mf.dispatchFetch(origin + '/mcp', { method: 'POST' });
  assert.equal(blocked.status, 401); assert.ok(blocked.headers.get('www-authenticate').includes('resource_metadata'));
  const discovery = await mf.dispatchFetch(origin + '/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json(); assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.equal(metadata.authorization_endpoint, origin + '/authorize');
  const protectedMetadata = await mf.dispatchFetch(origin + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(protectedMetadata.status, 200);
  assert.equal((await protectedMetadata.json()).resource, origin + '/mcp');
  const register = await mf.dispatchFetch(origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Smoke test client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(register.status, 201);
  const client = await register.json();
  const authorizeUrl = new URL(origin + '/authorize');
  authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', scope: 'linkedin:actions', code_challenge: 'test-challenge-that-is-43-characters-long-1234', code_challenge_method: 'S256', resource: origin + '/mcp', state: 'test-state' }).toString();
  const consent = await mf.dispatchFetch(authorizeUrl.toString());
  assert.equal(consent.status, 200);
  const body = await consent.text(); assert.ok(body.includes('Smoke test client')); assert.ok(body.includes('Owner setup key'));
  assert.ok(consent.headers.get('set-cookie').includes('HttpOnly'));
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
  const cookie = consent.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const handle = body.match(/name="handle" value="([^"]+)"/)[1];
  const approved = await mf.dispatchFetch(origin + '/authorize', {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve', ownerKey: 'owner-key-for-test-only-32-chars-long' }),
  });
  assert.equal(approved.status, 302);
  const upstream = new URL(approved.headers.get('location'));
  assert.equal(upstream.origin, 'https://www.linkedin.com');
  assert.equal(upstream.pathname, '/oauth/v2/authorization');
  assert.equal(upstream.searchParams.get('redirect_uri'), origin + '/oauth/linkedin/callback');
  assert.ok(upstream.searchParams.get('state'));
  const upstreamCookie = approved.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const refusedUrl = new URL(origin + '/oauth/linkedin/callback');
  refusedUrl.search = new URLSearchParams({ state: upstream.searchParams.get('state'), error: 'unauthorized_scope_error', error_description: 'private-value-must-not-appear' }).toString();
  const refused = await mf.dispatchFetch(refusedUrl.toString(), { headers: { Cookie: upstreamCookie } });
  assert.equal(refused.status, 400);
  const refusalText = await refused.text();
  assert.ok(refusalText.includes('unauthorized_scope_error'));
  assert.ok(!refusalText.includes('private-value-must-not-appear'));
  const callback = await mf.dispatchFetch(origin + '/oauth/linkedin/callback?code=mock&state=wrong');
  assert.equal(callback.status, 400);
});
