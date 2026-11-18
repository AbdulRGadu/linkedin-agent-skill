import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

for (const dual of [false, true]) test('workerd OAuth discovery, registration, consent and protected MCP smoke: ' + (dual ? 'dual app' : 'single app'), async t => {
  const origin = 'https://agent.example';
  let published = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-agent', modules: true, scriptPath: '.wrangler/test-bundle/index.js', compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], d1Databases: ['SCHEDULER_DB'],
    outboundService: async request => {
      if (request.url === 'https://www.linkedin.com/oauth/v2/introspectToken') {
        const form = await request.formData(); return Response.json({ active: true, client_id: form.get('client_id'), scope: form.get('client_id') === 'mock-community-app' ? 'rw_organization_admin,w_organization_social' : 'openid,profile,w_member_social,w_member_social_feed' });
      }
      if (request.url === 'https://www.linkedin.com/oauth/v2/accessToken') {
        const form = await request.formData(); return Response.json({ access_token: form.get('client_id') === 'mock-community-app' ? 'mock-private-community-token' : 'mock-private-member-token', expires_in: 3600 });
      }
      if (request.url.startsWith('https://api.linkedin.com/rest/organizationAcls?')) {
        assert.equal(request.headers.get('authorization'), 'Bearer mock-private-community-token'); return Response.json({ elements: [{ organization: 'urn:li:organization:123', roleAssignee: 'urn:li:person:community_member', state: 'APPROVED', role: 'ADMINISTRATOR' }] });
      }
      if (request.url === 'https://api.linkedin.com/v2/userinfo') return Response.json({ sub: 'mock_member123' });
      if (request.url === 'https://api.linkedin.com/rest/posts') {
        assert.equal(request.headers.get('authorization'), 'Bearer mock-private-member-token');
        const body = await request.json(); assert.equal(body.author, 'urn:li:person:mock_member123'); assert.equal(body.commentary, 'Exact batch-approved runtime post');
        published++; return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:99999' } });
      }
      throw new Error('Unexpected outbound request; live network is forbidden in tests');
    },
    bindings: { PUBLIC_ORIGIN: origin, LINKEDIN_CLIENT_ID: 'mock-app', LINKEDIN_CLIENT_SECRET: 'mock-secret', OWNER_SETUP_KEY: 'owner-key-for-test-only-32-chars-long', LINKEDIN_WRITE_ENABLED: 'true', SCHEDULER_ENCRYPTION_KEY: 'ab'.repeat(32), ...(dual ? { LINKEDIN_COMMUNITY_CLIENT_ID: 'mock-community-app', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'mock-community-secret', LINKEDIN_COMMUNITY_SCOPES: 'rw_organization_admin w_organization_social' } : {}) } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('SCHEDULER_DB');
  const migration = ['0001_scheduler.sql', '0002_identities.sql', '0003_community_app.sql', '0004_fifo.sql', '0005_fifo_backfill.sql'].map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
  await db.batch(migration.split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
  const health = await mf.dispatchFetch(origin + '/health'); assert.equal(health.status, 200);
  assert.equal((await health.json()).writesEnabled, true);
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
  const verifier = 'test-verifier-at-least-43-characters-long-for-PKCE-1234';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL(origin + '/authorize');
  authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', scope: 'linkedin:actions', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp', state: 'test-state' }).toString();
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
  // Exercise successful completion with the real provider and mocked LinkedIn.
  const freshConsent = await mf.dispatchFetch(authorizeUrl.toString());
  const freshBody = await freshConsent.text();
  const freshApproval = await mf.dispatchFetch(origin + '/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: freshConsent.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') },
    body: new URLSearchParams({ connectCommunity: dual ? 'true' : 'false', handle: freshBody.match(/name="handle" value="([^"]+)"/)[1], decision: 'approve', ownerKey: 'owner-key-for-test-only-32-chars-long' }),
  });
  assert.equal(freshApproval.status, 302);
  const freshUpstream = new URL(freshApproval.headers.get('location'));
  const completedUrl = new URL(origin + '/oauth/linkedin/callback');
  completedUrl.search = new URLSearchParams({ state: freshUpstream.searchParams.get('state'), code: 'mock-linkedin-code' }).toString();
  let completed = await mf.dispatchFetch(completedUrl.toString(), { redirect: 'manual', headers: { Cookie: freshApproval.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') } });
  assert.equal(completed.status, 302, await completed.text());
  if (dual) {
    const next = new URL(completed.headers.get('location')); assert.equal(next.searchParams.get('client_id'), 'mock-community-app');
    assert.equal(next.searchParams.get('scope'), 'rw_organization_admin w_organization_social');
    assert.equal(next.searchParams.get('redirect_uri'), origin + '/oauth/linkedin/community/callback');
    assert.ok(!next.href.includes('mock-private-member-token'));
    const kv = await mf.getKVNamespace('OAUTH_KV');
    const pending = await kv.list({ prefix: 'transaction:' });
    for (const key of pending.keys) assert.ok(!(await kv.get(key.name)).includes('mock-private-member-token'));
    const secondary = new URL(origin + '/oauth/linkedin/community/callback'); secondary.search = new URLSearchParams({ state: next.searchParams.get('state'), code: 'mock-community-code' }).toString();
    completed = await mf.dispatchFetch(secondary.toString(), { redirect: 'manual', headers: { Cookie: completed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') } });
    assert.equal(completed.status, 302, await completed.text());
    const replay = await mf.dispatchFetch(secondary.toString(), { headers: { Cookie: 'invalid=browser-cookie' } }); assert.equal(replay.status, 400);
  }
  const returnedTo = new URL(completed.headers.get('location'));
  assert.equal(returnedTo.origin, 'https://client.example');
  assert.ok(returnedTo.searchParams.get('code'));
  assert.equal(returnedTo.searchParams.get('state'), 'test-state');
  assert.ok(!returnedTo.href.includes('mock-private-member-token'));
  const tokenResponse = await mf.dispatchFetch(origin + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
    code: returnedTo.searchParams.get('code'), redirect_uri: 'https://client.example/callback', code_verifier: verifier, resource: origin + '/mcp' }) });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  const rpc = async (method, params) => {
    const response = await mf.dispatchFetch(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  assert.equal((await rpc('tools/list', {})).tools.length, 27);
  const posts = [{ text: 'Exact batch-approved runtime post', targetUrn: 'urn:li:person:mock_member123', scheduledAt: new Date(Date.now() + 60000).toISOString() }];
  const rejected = await rpc('tools/call', { name: 'linkedin_schedule_text_posts', arguments: { posts, approved: false } });
  assert.equal(rejected.isError, true);
  const scheduled = await rpc('tools/call', { name: 'linkedin_schedule_text_posts', arguments: { posts, approved: true } });
  assert.equal(scheduled.isError, undefined, JSON.stringify(scheduled));
  assert.equal(scheduled.structuredContent.posts[0].status, 'scheduled');
  const credentials = await db.prepare('SELECT * FROM scheduler_credentials').first();
  assert.ok(credentials.grant_id); assert.ok(!credentials.ciphertext.includes('mock-private-member-token'));
  if (dual) { assert.equal(credentials.community_person_urn, 'urn:li:person:community_member'); assert.equal(credentials.community_client_id, 'mock-community-app'); assert.ok(credentials.community_ciphertext); assert.ok(!JSON.stringify(credentials).includes('mock-private-community-token')); }
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }); assert.equal(published, 0);
  // Advance the local test record only; never change production schedules or call LinkedIn.
  await db.prepare('UPDATE scheduled_posts SET scheduled_at=?').bind(Date.now() - 1000).run();
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(published, 0);
  const utcHour = new Date().getUTCHours();
  const expected = utcHour >= 7 && utcHour < 23 && !(utcHour === 22 && new Date().getUTCMinutes() === 59) ? 1 : 0;
  await worker.scheduled({ cron: '*/15 7-22 * * *', scheduledTime: Date.now() });
  await worker.scheduled({ cron: '*/15 7-22 * * *', scheduledTime: Date.now() });
  assert.equal(published, expected);
  const listing = await rpc('tools/call', { name: 'linkedin_list_scheduled_posts', arguments: {} });
  assert.equal(listing.structuredContent.posts[0].status, expected ? 'published' : 'scheduled');
  assert.equal(listing.structuredContent.posts[0].linkedinPostId, 'urn:li:share:99999');
  assert.ok(!JSON.stringify(listing).includes('mock-private-member-token'));
  const callback = await mf.dispatchFetch(origin + '/oauth/linkedin/callback?code=mock&state=wrong');
  assert.equal(callback.status, 400);
});
