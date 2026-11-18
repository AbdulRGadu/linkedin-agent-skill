import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultHandler, exchangeCommunityCode } from '../worker/application.js';
import { createLinkedInClient } from '../apps/linkedin/client.js';
import { getOwnerLinkedInConfigs } from '../apps/linkedin/config.js';
import { communityConfigured, requestedCommunityScopes } from '../apps/linkedin/identity.js';
const origin = 'https://agent.example';
const env = { PUBLIC_ORIGIN: origin, LINKEDIN_VERSION: '202609', LINKEDIN_WRITE_ENABLED: 'true', LINKEDIN_CLIENT_ID: 'primary-app', LINKEDIN_CLIENT_SECRET: 'primary-secret', LINKEDIN_COMMUNITY_CLIENT_ID: 'community-app', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'community-secret', LINKEDIN_COMMUNITY_SCOPES: 'rw_organization_admin w_organization_social', OWNER_SETUP_KEY: 'mock-owner-key-for-test-only-32-chars' };
const primary = { owner: true, accessToken: 'mock-primary-token', personUrn: 'urn:li:person:primary_member', expiresAt: Date.now() + 86400000, grantedScopes: ['w_member_social'] };
const communityPerson = 'urn:li:person:community_member';
const organization = 'urn:li:organization:123';
function network() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/accessToken')) {
      const secondary = init.body.get('client_id') === env.LINKEDIN_COMMUNITY_CLIENT_ID;
      assert.equal(init.body.get('client_secret'), secondary ? env.LINKEDIN_COMMUNITY_CLIENT_SECRET : env.LINKEDIN_CLIENT_SECRET);
      assert.equal(init.body.get('redirect_uri'), origin + (secondary ? '/oauth/linkedin/community/callback' : '/oauth/linkedin/callback'));
      return Response.json({ access_token: secondary ? 'mock-community-token' : primary.accessToken, expires_in: 3600 });
    }
    if (url.endsWith('/introspectToken')) return Response.json({ active: true, client_id: init.body.get('client_id'), scope: init.body.get('client_id') === env.LINKEDIN_COMMUNITY_CLIENT_ID ? env.LINKEDIN_COMMUNITY_SCOPES : 'openid,profile,w_member_social' });
    if (url.endsWith('/userinfo')) { assert.equal(init.headers.Authorization, 'Bearer ' + primary.accessToken); return Response.json({ sub: 'primary_member' }); }
    assert.ok(url.startsWith('https://api.linkedin.com/rest/'), 'Live requests forbidden');
    if (url.includes('/organizationAcls')) return Response.json({ elements: [{ organization, roleAssignee: communityPerson, state: 'APPROVED', role: 'ADMINISTRATOR' }] });
    if (url.includes('/organizationsLookup')) return Response.json({ results: { 123: { localizedName: 'Managed page' } } });
    if (url.includes('/organizationAuthorizations/')) { assert.ok(decodeURIComponent(url).includes(communityPerson)); return Response.json({ organization, impersonator: communityPerson, status: { 'com.linkedin.organization.Approved': {} } }); }
    assert.equal(url, 'https://api.linkedin.com/rest/posts'); return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } });
  };
  return { fetchImpl, calls };
}
test('Community app needs only explicitly granted organization scopes, not OIDC/Share', async () => {
  assert.equal(communityConfigured({}), false); assert.equal(communityConfigured({ ...env, LINKEDIN_COMMUNITY_SCOPES: '' }), false);
  assert.throws(() => requestedCommunityScopes({ LINKEDIN_COMMUNITY_SCOPES: 'openid profile w_member_social' }));
  const f = network(), props = await exchangeCommunityCode('mock-code', env, f.fetchImpl);
  assert.equal(props.personUrn, communityPerson); assert.equal(props.clientId, env.LINKEDIN_COMMUNITY_CLIENT_ID);
  assert.ok(f.calls.every(c => !c.url.endsWith('/userinfo'))); assert.ok(props.grantedScopes.includes('w_organization_social'));
});
test('unverified grants and absent/ambiguous Community member identity fail closed', async () => {
  for (const elements of [[], [{ state: 'APPROVED', roleAssignee: communityPerson }, { state: 'APPROVED', roleAssignee: 'urn:li:person:other' }]]) {
    const f = network(); await assert.rejects(exchangeCommunityCode('mock-code', env, async (url, init) => url.includes('/organizationAcls') ? Response.json({ elements }) : f.fetchImpl(url, init)), /identity/);
  }
  const f = network(); await assert.rejects(exchangeCommunityCode('mock-code', env, async (url, init) => url.endsWith('/introspectToken') ? Response.json({ active: false, scope: env.LINKEDIN_COMMUNITY_SCOPES }) : f.fetchImpl(url, init)), /verified/);
});
test('primary callback stages Community authorization in encrypted provider state without exposing tokens', async () => {
  let pending, completed = false;
  const oauth = { finishUpstream: async () => ({ data: { owner: true, app: 'personal', connectCommunity: true }, request: { scope: ['linkedin:actions'] }, headers: new Headers() }),
    beginUpstream: async (request, options) => { pending = options.data; return { state: 'sealed-community-handle', headers: options.headers }; }, completeAuthorization: async () => { completed = true; } };
  const response = await defaultHandler(new Request(origin + '/oauth/linkedin/callback?code=mock-code'), { ...env, OAUTH_PROVIDER: oauth }, {}, network().fetchImpl);
  assert.equal(response.status, 302); assert.equal(completed, false); assert.equal(pending.app, 'community'); assert.equal(pending.primary.personUrn, primary.personUrn);
  const redirect = new URL(response.headers.get('location')); assert.equal(redirect.searchParams.get('client_id'), env.LINKEDIN_COMMUNITY_CLIENT_ID); assert.equal(redirect.searchParams.get('scope'), env.LINKEDIN_COMMUNITY_SCOPES);
  assert.equal(redirect.searchParams.get('redirect_uri'), origin + '/oauth/linkedin/community/callback'); assert.ok(!redirect.href.includes(primary.accessToken));
});
test('second callback combines credentials under the original owner and primary identity', async () => {
  let completed;
  const oauth = { finishUpstream: async () => ({ data: { owner: true, app: 'community', primary }, request: { scope: ['linkedin:actions'] }, headers: new Headers() }), completeAuthorization: async input => { completed = input; return { redirectTo: 'https://client.example/callback?code=mock' }; } };
  const response = await defaultHandler(new Request(origin + '/oauth/linkedin/community/callback?code=mock-code'), { ...env, OAUTH_PROVIDER: oauth }, {}, network().fetchImpl);
  assert.equal(response.status, 302); assert.equal(completed.userId, encodeURIComponent(primary.personUrn)); assert.equal(completed.props.personUrn, primary.personUrn); assert.equal(completed.props.community.personUrn, communityPerson);
  assert.ok(!response.headers.get('location').includes('mock-community-token'));
});
test('denied or failed secondary authorization preserves personal authorization without leaking upstream errors', async () => {
  for (const suffix of ['?error=unauthorized_scope_error&error_description=private-secret', '?code=mock-code']) {
    let completed;
    const oauth = { finishUpstream: async () => ({ data: { owner: true, app: 'community', primary }, request: { scope: ['linkedin:actions'] }, headers: new Headers() }), completeAuthorization: async input => { completed = input; return { redirectTo: 'https://client.example/callback' }; } };
    const response = await defaultHandler(new Request(origin + '/oauth/linkedin/community/callback' + suffix), { ...env, OAUTH_PROVIDER: oauth }, {}, async () => { throw new Error('private-secret'); });
    assert.equal(response.status, 302); assert.equal(completed.props.accessToken, primary.accessToken); assert.equal(completed.props.community, undefined); assert.ok(completed.props.communityProblem); assert.ok(!JSON.stringify(completed).includes('private-secret'));
  }
});
test('callbacks cannot swap app states or bypass the original owner connection', async () => {
  for (const [path, data] of [['/oauth/linkedin/community/callback', { owner: true, app: 'personal' }], ['/oauth/linkedin/callback', { owner: true, app: 'community', primary }], ['/oauth/linkedin/community/callback', { owner: true, app: 'community', primary: { ...primary, owner: false } }]]) {
    let called = false;
    const response = await defaultHandler(new Request(origin + path + '?code=mock'), { ...env, OAUTH_PROVIDER: { finishUpstream: async () => ({ data, headers: new Headers() }), completeAuthorization: async () => { called = true; } } }, {}, async () => { called = true; });
    assert.equal(response.status, 400); assert.equal(called, false);
  }
});
test('Community selection cannot start until config is eligible and owner consent passes', async () => {
  let called = false;
  const response = await defaultHandler(new Request(origin + '/authorize', { method: 'POST', headers: { origin }, body: new URLSearchParams({ ownerKey: env.OWNER_SETUP_KEY, decision: 'approve', connectCommunity: 'true' }) }), { ...env, LINKEDIN_COMMUNITY_SCOPES: '', OAUTH_PROVIDER: { approveConsent: async () => { called = true; } } }, {});
  assert.equal(response.status, 503); assert.equal(called, false);
});
test('routing uses primary token for personal and Community token/member ID for organizations', async () => {
  const f = network(), community = await exchangeCommunityCode('mock-code', env, f.fetchImpl);
  f.calls.length = 0;
  const configs = getOwnerLinkedInConfigs(env, { ...primary, community });
  const client = createLinkedInClient({ ...configs, fetchImpl: f.fetchImpl });
  await client.execute('linkedin_publish_text_post', { text: 'Approved personal', approved: true });
  await client.execute('linkedin_publish_text_post', { actor: 'Managed page', text: 'Approved page', approved: true });
  const writes = f.calls.filter(c => c.init.method === 'POST');
  assert.equal(writes[0].init.headers.Authorization, 'Bearer ' + primary.accessToken); assert.equal(JSON.parse(writes[0].init.body).author, primary.personUrn);
  assert.equal(writes[1].init.headers.Authorization, 'Bearer ' + community.accessToken); assert.equal(JSON.parse(writes[1].init.body).author, organization);
  const caps = await client.execute('linkedin_capabilities', {}); assert.equal(caps.personal.publish, true); assert.equal(caps.connections.community.connected, true); assert.equal(caps.organizations.organizations[0].capabilities.publish, true);
  assert.ok(!JSON.stringify(caps).includes(primary.accessToken)); assert.ok(!JSON.stringify(caps).includes(community.accessToken));
});
test('expired or different-app Community credentials never fall back to primary for page writes', async () => {
  for (const change of [{ expiresAt: 1 }, { clientId: 'wrong-app' }]) {
    const f = network(), community = { ...(await exchangeCommunityCode('mock-code', env, f.fetchImpl)), ...change }; f.calls.length = 0;
    const client = createLinkedInClient({ ...getOwnerLinkedInConfigs(env, { ...primary, community }), fetchImpl: f.fetchImpl });
    await assert.rejects(client.execute('linkedin_publish_text_post', { actor: 'Managed page', text: 'Approved page', approved: true })); assert.equal(f.calls.length, 0);
    await client.execute('linkedin_publish_text_post', { text: 'Approved personal', approved: true }); assert.equal(f.calls.length, 1);
  }
});
