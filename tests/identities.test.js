import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkedInClient, schemas, introspectLinkedInScopes } from '../apps/linkedin/client.js';
import { resolvePostReference, requestedScopes } from '../apps/linkedin/identity.js';

const person = 'urn:li:person:owner';
const org = 'urn:li:organization:123';
const grantedScopes = ['w_member_social', 'w_member_social_feed', 'r_member_social', 'r_member_social_feed', 'rw_organization_admin', 'w_organization_social', 'r_organization_social', 'w_organization_social_feed', 'r_organization_social_feed'];
function fixture({ grants = grantedScopes, denied = false, pages = [{ urn: org, name: 'Centrisec' }], reply = {}, db } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.ok(url.startsWith('https://api.linkedin.com/rest/'), 'Only mocked official endpoints are allowed');
    calls.push({ url, ...init, payload: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/organizationAcls')) return Response.json({ elements: pages.map(p => ({ organization: p.urn, roleAssignee: person, state: 'APPROVED', role: 'ADMINISTRATOR' })) });
    if (url.includes('/organizationsLookup')) return Response.json({ results: Object.fromEntries(pages.map(p => [p.urn.split(':').at(-1), { localizedName: p.name, vanityName: p.name.toLowerCase(), logoV2: { original: 'urn:li:digitalmediaAsset:logo' } }])) });
    if (url.includes('/organizationAuthorizations/')) return Response.json({ organization: org, impersonator: person, status: { [denied ? 'com.linkedin.organization.Denied' : 'com.linkedin.organization.Approved']: {} } });
    if (init.method === 'GET') return Response.json(reply);
    return Response.json({ commentUrn: 'urn:li:comment:(urn:li:activity:99,1)' }, { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } });
  };
  const client = createLinkedInClient({ config: { accessToken: 'mock-secret-token', personUrn: person, version: '202609', writeEnabled: true, grantedScopes: grants }, fetchImpl, db, schedulerAvailable: true });
  return { client, calls, fetchImpl };
}
test('managed pages are discovered by ACL and names resolve without hard-coded IDs', async () => {
  const f = fixture();
  const identity = await f.client.resolveActor('centrisec');
  assert.equal(identity.urn, org); assert.equal(identity.name, 'Centrisec'); assert.deepEqual(identity.roles, ['ADMINISTRATOR']);
  const list = await f.client.execute('linkedin_list_managed_organizations', {});
  assert.equal(list.organizations[0].capabilities.publish, true); assert.equal(list.organizations[0].capabilities.schedule, true);
  assert.equal(list.organizations[0].logo, 'urn:li:digitalmediaAsset:logo');
});
test('ambiguous names, arbitrary pages and mismatched name/URN never publish', async () => {
  for (const [pages, actor] of [[[{ urn: org, name: 'Centrisec' }, { urn: 'urn:li:organization:456', name: 'Centrisec' }], 'Centrisec'],
    [[{ urn: org, name: 'Centrisec' }], { type: 'organization', organizationUrn: 'urn:li:organization:999' }],
    [[{ urn: org, name: 'Centrisec' }], { type: 'organization', organizationUrn: org, organizationName: 'Wrong' }]]) {
    const f = fixture({ pages });
    await assert.rejects(f.client.execute('linkedin_publish_text_post', { text: 'Approved', actor, approved: true }));
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});
test('organization writes require approved content and verified per-action authorization', async () => {
  const f = fixture({ denied: true });
  await assert.rejects(f.client.execute('linkedin_publish_text_post', { text: 'Draft', actor: 'Centrisec', approved: false })); assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.execute('linkedin_publish_text_post', { text: 'Approved', actor: 'Centrisec', approved: true }), /denied/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal((await f.client.execute('linkedin_capabilities', {})).organizations.organizations[0].capabilities.publish, false);
});
test('personal and organization social writes use the approved actor without read permission', async () => {
  for (const actor of ['personal', 'Centrisec']) {
    const f = fixture({ grants: grantedScopes.filter(scope => !scope.startsWith('r_member') && !scope.startsWith('r_organization_social')) });
    const targetUrn = 'https://www.linkedin.com/posts/someone_activity-99-testing';
    await f.client.execute('linkedin_create_comment', { actor, targetUrn, text: 'Exact comment', approved: true });
    await f.client.execute('linkedin_reply_to_comment', { actor, parentCommentUrn: 'urn:li:comment:(urn:li:activity:99,1)', rootPostUrn: targetUrn, text: 'Exact reply', approved: true });
    await f.client.execute('linkedin_add_reaction', { actor, targetUrn: 'urn:li:comment:(urn:li:activity:99,1)', reactionType: 'LIKE', approved: true });
    const writes = f.calls.filter(c => c.method === 'POST');
    assert.equal(writes[0].payload.actor, actor === 'personal' ? person : org);
    assert.equal(writes[1].payload.actor, writes[0].payload.actor);
    assert.ok(writes[2].url.includes(encodeURIComponent(writes[0].payload.actor)));
    assert.ok(f.calls.every(c => !c.url.includes('/comments?')));
  }
});
test('capabilities reflect verified grants; messaging, invitations and uploads are unavailable', async () => {
  const f = fixture({ grants: ['openid', 'profile', 'w_member_social'] });
  const result = await f.client.execute('linkedin_capabilities', {});
  assert.equal(result.personal.publish, true); assert.equal(result.personal.comment, false); assert.equal(result.personal.read_recent_posts, false);
  assert.equal(result.organizations.available, false); assert.equal(result.messaging.available, false); assert.equal(result.invitations.available, false); assert.equal(result.media.uploads, false);
  assert.equal(schemas.linkedin_send_message, undefined); assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.execute('linkedin_create_comment', { targetUrn: 'urn:li:activity:99', text: 'Approved', approved: true }), /w_member_social_feed/);
});
test('URL parsing accepts explicit IDs only and never invents a canonical share ID', async () => {
  assert.equal(resolvePostReference('https://www.linkedin.com/posts/name_activity-123-abcd?utm_source=share'), 'urn:li:activity:123');
  assert.equal(resolvePostReference('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/'), 'urn:li:share:123');
  for (const value of ['https://evil.com/posts/a_activity-123-abc', 'https://linkedin.com.evil.com/feed/update/urn:li:share:1', 'https://www.linkedin.com/posts/no-identifier', 'https://lnkd.in/test']) assert.throws(() => resolvePostReference(value));
  const f = fixture();
  await assert.rejects(f.client.execute('linkedin_get_post', { targetUrn: 'https://www.linkedin.com/posts/name_activity-123-abcd' }), /share\/ugcPost/); assert.equal(f.calls.length, 0);
});
test('recent posts and comments expose pagination and latest-in-page limits', async () => {
  const f = fixture({ reply: { elements: [{ id: 1, object: 'urn:li:activity:99', actor: 'urn:li:person:other', message: { text: 'Comment' }, created: { time: 10 } }], paging: { links: [{ rel: 'next' }] } } });
  const result = await f.client.execute('linkedin_get_comments', { targetUrn: 'urn:li:share:99', count: 1 });
  assert.equal(result.latestInPage.commentUrn, 'urn:li:comment:(urn:li:activity:99,1)'); assert.equal(result.latestIsGlobal, false); assert.equal(result.nextStart, 1);
});
test('edit/delete reject content owned by another actor', async () => {
  const f = fixture({ reply: { actor: 'urn:li:person:other', author: 'urn:li:person:other' } });
  for (const name of ['linkedin_edit_comment', 'linkedin_delete_comment']) await assert.rejects(f.client.execute(name, { commentUrn: 'urn:li:comment:(urn:li:activity:99,1)', ...(name.includes('edit') ? { text: 'Updated' } : {}), approved: true }), /another identity/);
  for (const name of ['linkedin_edit_post', 'linkedin_delete_post']) await assert.rejects(f.client.execute(name, { targetUrn: 'urn:li:share:99', ...(name.includes('edit') ? { text: 'Updated' } : {}), approved: true }), /another identity/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('comment ownership reads authorize partial updates and deletion', async () => {
  const f = fixture({ reply: { actor: person } });
  await f.client.execute('linkedin_edit_comment', { commentUrn: 'urn:li:comment:(urn:li:activity:99,1)', text: 'Updated exact text', approved: true });
  const write = f.calls.find(c => c.method === 'POST');
  assert.deepEqual(write.payload, { patch: { message: { $set: { text: 'Updated exact text' } } } }); assert.equal(write.headers['X-RestLi-Method'], 'PARTIAL_UPDATE');
  await f.client.execute('linkedin_delete_comment', { commentUrn: 'urn:li:comment:(urn:li:activity:99,1)', approved: true }); assert.equal(f.calls.at(-1).method, 'DELETE');
});
test('article publishing reuses the existing Posts API payload and approval gates', async () => {
  const f = fixture();
  await f.client.execute('linkedin_publish_article_post', { text: 'Approved link post', title: 'Article', source: 'https://example.com/article', approved: true });
  assert.deepEqual(f.calls[0].payload.content, { article: { source: 'https://example.com/article', title: 'Article' } }); assert.equal(f.calls[0].payload.author, person);
});
test('OAuth requests only configured optional scopes and introspection verifies actual grants', async () => {
  assert.deepEqual(requestedScopes({}), ['openid', 'profile', 'w_member_social']);
  assert.ok(requestedScopes({ LINKEDIN_OPTIONAL_SCOPES: 'rw_organization_admin,w_organization_social' }).includes('w_organization_social'));
  assert.throws(() => requestedScopes({ LINKEDIN_OPTIONAL_SCOPES: 'messages' }));
  const config = { accessToken: 'mock-token', clientId: 'mock-app', clientSecret: 'mock-secret' };
  const fetchImpl = async (url, init) => { assert.equal(url, 'https://www.linkedin.com/oauth/v2/introspectToken'); assert.equal(init.body.get('token'), config.accessToken); return Response.json({ active: true, client_id: config.clientId, scope: 'openid,w_member_social' }); };
  assert.deepEqual(await introspectLinkedInScopes(config, fetchImpl), ['openid', 'w_member_social']);
  assert.equal(await introspectLinkedInScopes(config, async () => Response.json({ active: false, scope: 'w_organization_social' })), null);
});
