import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLinkedInClient } from '../apps/linkedin/client.js';
import { createScheduler, runScheduler, encryptCredential, syncSchedulerCredential } from '../worker/scheduler.js';

const member = 'urn:li:person:scheduler_test';
const start = Date.parse('2026-10-05T07:00:00Z');
const time = start + 60000;
const day = 86400000;
const approval = { text: 'Exact approved text.\nKeep the spacing.', targetUrn: member, scheduledAt: new Date(time).toISOString(), approved: true };
const secret = 'mock-private-token-never-real';
const success = () => new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:12345' } });

async function fixture(t, { fetchImpl, grantedScopes = ['w_member_social'] } = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-10-03', d1Databases: ['SCHEDULER_DB'],
    outboundService: () => { throw new Error('Live network forbidden in scheduler tests'); } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('SCHEDULER_DB');
  const migration = ['0001_scheduler.sql', '0002_identities.sql', '0003_community_app.sql', '0004_fifo.sql', '0005_fifo_backfill.sql'].map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
  await db.batch(migration.split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
  let clock = start, calls = 0;
  const ctx = { auth: { token: 'mock-mcp-token', scope: ['linkedin:actions'] }, props: { grantedScopes, owner: true, personUrn: member, accessToken: secret, expiresAt: start + 10 * day } };
  let grants = [{ id: 'mock-grant', scope: ['linkedin:actions'], expiresAt: Math.floor((start + 10 * day) / 1000) }];
  const oauth = {
    unwrapToken: async () => ({ grantId: 'mock-grant', userId: encodeURIComponent(ctx.props.personUrn), grant: { props: { ...ctx.props } }, scope: ['linkedin:actions'] }),
    listUserGrants: async () => ({ items: grants }),
  };
  const env = { SCHEDULER_DB: db, SCHEDULER_ENCRYPTION_KEY: 'ab'.repeat(32), OAUTH_PROVIDER: oauth, LINKEDIN_WRITE_ENABLED: 'true', LINKEDIN_VERSION: '202609' };
  const scheduler = createScheduler({ env, ctx, now: () => clock, fetchImpl });
  const f = { db, env, ctx, oauth, scheduler,
    setTime: value => { clock = value; }, revoke: () => { grants = []; },
    schedule: async (input = approval) => (await scheduler.execute('linkedin_schedule_text_post', input)).posts[0],
    list: async () => (await scheduler.execute('linkedin_list_scheduled_posts', {})).posts,
    run: async (response = success) => runScheduler(env, oauth, { now: () => clock, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.linkedin.com/rest/posts'); assert.equal(init.headers.Authorization, 'Bearer ' + secret);
      assert.equal(JSON.parse(init.body).author, member); calls++; return response(url, init);
    } }),
    get calls() { return calls; },
  };
  return f;
}

async function dualScheduler(t) {
  const f = await fixture(t), writes = [];
  const secondaryToken = 'mock-community-token-never-real';
  const secondaryPerson = 'urn:li:person:community_test';
  f.env.LINKEDIN_COMMUNITY_CLIENT_ID = 'mock-community-app';
  f.ctx.props.community = { clientId: f.env.LINKEDIN_COMMUNITY_CLIENT_ID, accessToken: secondaryToken, personUrn: secondaryPerson,
    expiresAt: start + 10 * day, grantedScopes: ['rw_organization_admin', 'w_organization_social'] };
  const base = organizationNetwork({ writes });
  const fetchImpl = async (url, init) => {
    const personal = init.method === 'POST' && JSON.parse(init.body).author === member;
    assert.equal(init.headers.Authorization, 'Bearer ' + (personal ? secret : secondaryToken));
    const response = await base(url, init);
    if (init.method === 'GET') return new Response((await response.text()).replaceAll(member, secondaryPerson), { status: response.status });
    return response;
  };
  f.scheduler = createScheduler({ env: f.env, ctx: f.ctx, now: () => start, fetchImpl });
  return { ...f, writes, fetchImpl, secondaryToken };
}

test('dual app schedules encrypt both credentials and use the correct publishing app', async t => {
  const f = await dualScheduler(t);
  const posts = ['personal', 'First page'].map(actor => ({ actor, text: 'Exact approved dual-app post', scheduledAt: new Date(time).toISOString() }));
  await f.scheduler.execute('linkedin_schedule_text_posts', { posts, approved: true });
  const row = await f.db.prepare('SELECT * FROM scheduler_credentials').first();
  assert.ok(row.community_ciphertext && row.ciphertext);
  assert.ok(!JSON.stringify(row).includes(f.secondaryToken)); assert.ok(!JSON.stringify(row).includes(secret));
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl: f.fetchImpl });
  await runScheduler(f.env, f.oauth, { now: () => time + day, fetchImpl: f.fetchImpl });
  assert.equal(f.writes.length, 2);
  assert.ok((await f.scheduler.execute('linkedin_list_scheduled_posts', {})).posts.every(p => p.status === 'published'));
});

test('expired Community credentials retain blocked page schedules and permit personal publication', async t => {
  const f = await dualScheduler(t);
  await f.scheduler.execute('linkedin_schedule_text_posts', { posts: ['personal', 'First page'].map(actor => ({ actor, text: 'Approved expiry test', scheduledAt: new Date(time).toISOString() })), approved: true });
  await f.db.prepare('UPDATE scheduler_credentials SET community_expires_at=?').bind(time).run();
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl: f.fetchImpl });
  await runScheduler(f.env, f.oauth, { now: () => time + day, fetchImpl: f.fetchImpl });
  const posts = (await f.scheduler.execute('linkedin_list_scheduled_posts', {})).posts;
  assert.equal(posts.find(p => p.targetType === 'person').status, 'published');
  assert.equal(posts.find(p => p.targetType === 'organization').reason, 'community_reconnection_required');
  assert.equal(f.writes.length, 1);
});

test('Community 401 invalidates only its own credential and prevents blind retry', async t => {
  const f = await dualScheduler(t);
  await f.scheduler.execute('linkedin_schedule_text_post', { actor: 'First page', text: 'Approved auth test', scheduledAt: new Date(time).toISOString(), approved: true });
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') { attempts++; return new Response('', { status: 401 }); }
    return f.fetchImpl(url, init);
  };
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl });
  const credential = await f.db.prepare('SELECT * FROM scheduler_credentials').first();
  assert.equal(credential.invalid, 0); assert.equal(credential.community_invalid, 1);
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl }); assert.equal(attempts, 1);
});

test('ambiguous Community publishing outcomes stop for review and are never retried', async t => {
  const f = await dualScheduler(t);
  await f.scheduler.execute('linkedin_schedule_text_post', { actor: 'First page', text: 'Approved uncertainty test', scheduledAt: new Date(time).toISOString(), approved: true });
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') { attempts++; throw new Error(f.secondaryToken); }
    return f.fetchImpl(url, init);
  };
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl });
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl }); assert.equal(attempts, 1);
  assert.equal((await f.scheduler.execute('linkedin_list_scheduled_posts', {})).posts[0].status, 'needs_review');
});

test('approved exact post is stored with encrypted credentials and safe status', async t => {
  const f = await fixture(t);
  const post = await f.schedule();
  assert.equal(post.status, 'scheduled'); assert.equal(post.text, approval.text); assert.equal(post.targetUrn, member);
  assert.equal(post.scheduledAt, new Date(time).toISOString());
  const stored = await f.db.prepare('SELECT * FROM scheduler_credentials').first();
  assert.ok(!JSON.stringify(stored).includes(secret)); assert.ok(stored.ciphertext.includes(':'));
  const another = await encryptCredential(f.env, member, secret); assert.notEqual(stored.ciphertext, another);
  const status = await f.scheduler.execute('linkedin_scheduler_status', {});
  assert.equal(status.configured, true); assert.equal(status.counts.scheduled, 1); assert.equal(status.reconnectionRequired, false);
  assert.ok(!JSON.stringify(status).includes(secret)); assert.equal(f.calls, 0);
});

test('unapproved, invalid, other-member and company posts cannot be scheduled', async t => {
  const f = await fixture(t);
  for (const input of [{ ...approval, approved: undefined }, { ...approval, approved: false }, { ...approval, approved: 'true' },
    { ...approval, text: ' ' }, { ...approval, text: 'x'.repeat(3001) }, { ...approval, targetUrn: 'urn:li:organization:123' },
    { ...approval, targetUrn: 'urn:li:person:other' }, { ...approval, scheduledAt: '2026-10-05T08:00:00' },
    { ...approval, scheduledAt: new Date(start).toISOString() }]) await assert.rejects(f.schedule(input));
  assert.equal((await f.list()).length, 0); assert.equal(f.calls, 0);
});

test('batch is atomic and supports seven posts plus duplicate items', async t => {
  const f = await fixture(t);
  const { approved, ...first } = approval;
  const posts = Array.from({ length: 7 }, (_, index) => ({ ...first, text: 'Day ' + index, scheduledAt: new Date(time + index * 86400000).toISOString() }));
  await assert.rejects(f.scheduler.execute('linkedin_schedule_text_posts', { posts: [...posts, { ...first, targetUrn: 'urn:li:person:other' }], approved: true }));
  assert.equal((await f.list()).length, 0);
  await assert.rejects(f.scheduler.execute('linkedin_schedule_text_posts', { posts, approved: false }));
  const result = await f.scheduler.execute('linkedin_schedule_text_posts', { posts: [...posts, posts[0]], approved: true });
  assert.equal(result.posts.length, 8); assert.equal(result.posts[0].scheduleId, result.posts[7].scheduleId);
  assert.equal((await f.list()).length, 7);
  const retry = await f.scheduler.execute('linkedin_schedule_text_posts', { posts, approved: true });
  assert.deepEqual(retry.posts.map(p => p.scheduleId), result.posts.slice(0, 7).map(p => p.scheduleId));
});

test('concurrent duplicate requests and equivalent offset times share one schedule', async t => {
  const f = await fixture(t);
  const posts = await Promise.all([f.schedule(), f.schedule({ ...approval, scheduledAt: '2026-10-05T08:01:00+01:00' }), f.schedule()]);
  assert.equal(new Set(posts.map(p => p.scheduleId)).size, 1); assert.equal((await f.list()).length, 1);
});

test('future posts are not sent; concurrent due runs publish exactly once and retain ID', async t => {
  const f = await fixture(t); await f.schedule();
  await f.run(); assert.equal(f.calls, 0);
  f.setTime(time); await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(f.calls, 1);
  const [post] = await f.list(); assert.equal(post.status, 'published'); assert.equal(post.linkedinPostId, 'urn:li:share:12345');
  assert.equal(post.publishedAt, new Date(time).toISOString());
  await f.run(); assert.equal(f.calls, 1);
});

test('cancelled posts never publish or reactivate from duplicate scheduling', async t => {
  const f = await fixture(t); const post = await f.schedule();
  await assert.rejects(f.scheduler.execute('linkedin_cancel_scheduled_post', { scheduleId: post.scheduleId, approved: false }));
  await f.scheduler.execute('linkedin_cancel_scheduled_post', { scheduleId: post.scheduleId, approved: true });
  assert.equal((await f.schedule()).status, 'cancelled');
  f.setTime(time); await f.run(); assert.equal(f.calls, 0);
});

test('rescheduling requires approval and preserves old dedupe keys', async t => {
  const f = await fixture(t); const post = await f.schedule();
  const scheduledAt = new Date(time + 60000).toISOString();
  await assert.rejects(f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt, approved: false }));
  const result = await f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt, approved: true });
  assert.equal(result.post.text, post.text); assert.equal(result.post.scheduledAt, scheduledAt);
  assert.equal((await f.schedule()).scheduleId, post.scheduleId); assert.equal((await f.list()).length, 1);
  f.setTime(time); await f.run(); assert.equal(f.calls, 0);
  f.setTime(time + 60000); await f.run(); assert.equal(f.calls, 1);
});

test('rescheduling cannot collide with another reserved schedule', async t => {
  const f = await fixture(t); const post = await f.schedule();
  const later = new Date(time + 60000).toISOString();
  await f.schedule({ ...approval, scheduledAt: later });
  await assert.rejects(f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt: later, approved: true }));
  assert.equal((await f.list())[0].scheduledAt, approval.scheduledAt);
});

test('expired auth blocks and retains post; same-member reconnection recovers within grace', async t => {
  const f = await fixture(t); await f.schedule();
  await f.db.prepare('UPDATE scheduler_credentials SET expires_at=?').bind(time).run();
  f.setTime(time); await f.run(); assert.equal(f.calls, 0);
  assert.equal((await f.list())[0].status, 'blocked');
  assert.equal((await f.scheduler.execute('linkedin_scheduler_status', {})).reconnectionRequired, true);
  await syncSchedulerCredential(f.env, f.ctx, time); await f.run();
  assert.equal(f.calls, 1); assert.equal((await f.list())[0].status, 'published');
});

test('HTTP 401 blocks without daily retries until fresh auth replaces invalid credential', async t => {
  const f = await fixture(t); await f.schedule(); f.setTime(time);
  await f.run(() => new Response('', { status: 401 })); await f.run();
  assert.equal(f.calls, 1); assert.equal((await f.list())[0].status, 'blocked');
  // The same old MCP token must not clear an invalid LinkedIn credential.
  await syncSchedulerCredential(f.env, f.ctx, time); await f.run(); assert.equal(f.calls, 1);
  f.ctx.props.expiresAt += 86400000; await syncSchedulerCredential(f.env, f.ctx, time); await f.run();
  assert.equal(f.calls, 2); assert.equal((await f.list())[0].status, 'published');
});

test('revoked grants and disabled writes block before LinkedIn network access', async t => {
  const f = await fixture(t); await f.schedule(); f.setTime(time);
  f.env.LINKEDIN_WRITE_ENABLED = 'false'; await f.run();
  assert.equal((await f.list())[0].reason, 'writes_disabled');
  f.env.LINKEDIN_WRITE_ENABLED = 'true'; f.revoke(); await f.run();
  assert.equal((await f.list())[0].reason, 'grant_revoked_or_expired'); assert.equal(f.calls, 0);
});

test('late fallback and downtime recover in FIFO order with one post per Lagos day', async t => {
  const f = await fixture(t);
  const items = [await f.schedule(), await f.schedule({ ...approval, text: 'Second' }), await f.schedule({ ...approval, text: 'Third', scheduledAt: undefined })];
  assert.deepEqual(items.map(post => post.queuePosition), [1, 2, 3]);
  await f.db.prepare("UPDATE scheduled_posts SET status='blocked',reason='missed_time_requires_reschedule' WHERE id=?").bind(items[0].scheduleId).run();
  f.setTime(time + 5 * 3600000);
  await Promise.all([f.run(), f.run(), f.run()]);
  const statuses = async () => (await f.list()).map(post => post.status);
  assert.deepEqual(await statuses(), ['published', 'scheduled', 'scheduled']);
  f.setTime(start + 3 * day - 7 * 3600000);
  await f.run(); assert.equal(f.calls, 1);
  f.setTime(start + 3 * day);
  await Promise.all([f.run(), f.run()]);
  assert.deepEqual(await statuses(), ['published', 'published', 'scheduled']);
  await f.run(); assert.equal(f.calls, 2);
  f.setTime(start + 4 * day);
  await f.run(); await f.run(); assert.equal(f.calls, 3);
  assert.deepEqual((await f.list()).map(post => post.publicationDay), ['2026-10-05','2026-10-08','2026-10-09']);
});

test('rate limit retries after backoff and preserves attempt metadata', async t => {
  const f = await fixture(t); await f.schedule(); f.setTime(time);
  await f.run(() => new Response('', { status: 429 }));
  await f.run(); assert.equal(f.calls, 1);
  const [pending] = await f.list();
  assert.equal(pending.attemptCount, 1);
  assert.equal(pending.retryAt, new Date(time + 15 * 60000).toISOString());
  f.setTime(time + 15 * 60000); await f.run();
  assert.equal((await f.list())[0].attemptCount, 2); assert.equal(f.calls, 2);
});

for (const [label, response, status] of [
  ['timeout', () => { throw new Error(secret); }, 'needs_review'],
  ['server error', () => new Response(secret, { status: 500 }), 'needs_review'],
  ['HTTP timeout', () => new Response('', { status: 408 }), 'needs_review'],
  ['redirect', () => new Response('', { status: 302 }), 'needs_review'],
  ['unreadable success', () => new Response('{invalid', { status: 201 }), 'needs_review'],
  ['missing ID', () => new Response('', { status: 201 }), 'needs_review'],
  ['permission refusal', () => new Response(secret, { status: 403 }), 'failed'],
]) test(label + ' is recorded safely without automatic retries', async t => {
  const f = await fixture(t); const post = await f.schedule(); f.setTime(time);
  await f.run(response); await f.run(); assert.equal(f.calls, 1);
  const [result] = await f.list(); assert.equal(result.status, status); assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt: new Date(time + 60000).toISOString(), approved: true }));
});

test('stale claimed posts require review and are never reclaimed', async t => {
  const f = await fixture(t); await f.schedule();
  await f.db.prepare("UPDATE scheduled_posts SET status='publishing', attempted_at=?").bind(time).run();
  f.setTime(time + 5 * 60000); await f.run(); await f.run();
  assert.equal((await f.list())[0].reason, 'stale_publish_attempt'); assert.equal(f.calls, 0);
});

test('cancel and reschedule refuse a claimed post while publishing', async t => {
  const f = await fixture(t); const post = await f.schedule(); f.setTime(time);
  await f.run(async () => {
    await assert.rejects(f.scheduler.execute('linkedin_cancel_scheduled_post', { scheduleId: post.scheduleId, approved: true }));
    await assert.rejects(f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt: new Date(time + 60000).toISOString(), approved: true }));
    return success();
  });
  assert.equal(f.calls, 1); assert.equal((await f.list())[0].status, 'published');
});

test('encryption tampering, wrong keys and member swaps fail closed', async t => {
  const f = await fixture(t); await f.schedule(); f.setTime(time);
  f.env.SCHEDULER_ENCRYPTION_KEY = 'cd'.repeat(32); await f.run();
  assert.equal(f.calls, 0); assert.equal((await f.list())[0].reason, 'credential_unavailable_reconnect');
  f.env.SCHEDULER_ENCRYPTION_KEY = 'ab'.repeat(32);
  const other = await encryptCredential(f.env, 'urn:li:person:other', secret);
  await f.db.prepare('UPDATE scheduler_credentials SET ciphertext=?').bind(other).run();
  await f.run(); assert.equal(f.calls, 0);
});

test('scheduler setup and owner checks fail closed without breaking status', async t => {
  const f = await fixture(t);
  delete f.env.SCHEDULER_ENCRYPTION_KEY; await assert.rejects(f.schedule());
  assert.equal((await f.scheduler.execute('linkedin_scheduler_status', {})).configured, false);
  f.ctx.props.owner = false; await assert.rejects(f.schedule());
});

test('listing is scoped to the connected member and paginated', async t => {
  const f = await fixture(t); await f.schedule(); await f.schedule({ ...approval, text: 'Second post' });
  const first = await f.scheduler.execute('linkedin_list_scheduled_posts', { status: 'scheduled', limit: 1 });
  assert.equal(first.posts.length, 1); assert.equal(first.nextOffset, 1);
  const second = await f.scheduler.execute('linkedin_list_scheduled_posts', { limit: 1, offset: 1 });
  assert.equal(second.nextOffset, null); assert.notEqual(first.posts[0].scheduleId, second.posts[0].scheduleId);
  const other = createScheduler({ env: f.env, ctx: { ...f.ctx, props: { ...f.ctx.props, personUrn: 'urn:li:person:other' } }, now: () => start });
  assert.deepEqual((await other.execute('linkedin_list_scheduled_posts', {})).posts, []);
});

test('a failed D1 batch rolls back all posts and redacts storage errors', async t => {
  const f = await fixture(t);
  const real = f.db;
  f.env.SCHEDULER_DB = {
    prepare: sql => real.prepare(sql),
    // Execute an invalid statement within the real transactional batch.
    batch: statements => real.batch([...statements, real.prepare('SELECT * FROM missing_table')]),
  };
  const scheduler = createScheduler({ env: f.env, ctx: f.ctx, now: () => start });
  const { approved, ...post } = approval;
  await assert.rejects(scheduler.execute('linkedin_schedule_text_posts', { posts: [post, { ...post, text: 'Second post' }], approved: true }), error => {
    assert.ok(!error.message.includes('missing_table')); return true;
  });
  assert.deepEqual(await f.list(), []);
  f.env.OAUTH_PROVIDER = { unwrapToken: async () => { throw new Error('Scheduler ' + secret); } };
  await assert.rejects(scheduler.execute('linkedin_schedule_text_post', approval), error => !error.message.includes(secret));
});

test('database failure after LinkedIn success leaves a claim that is never retried', async t => {
  const f = await fixture(t); await f.schedule(); f.setTime(time);
  const real = f.db;
  f.env.SCHEDULER_DB = { prepare: sql => {
    if (sql.startsWith('UPDATE scheduled_posts SET status=?,reason=?')) throw new Error('private database error');
    return real.prepare(sql);
  } };
  await assert.rejects(f.run(), /Scheduler run failed/);
  assert.equal(f.calls, 1); assert.equal((await f.list())[0].status, 'publishing');
  f.env.SCHEDULER_DB = real; f.setTime(time + 5 * 60000); await f.run();
  assert.equal(f.calls, 1); assert.equal((await f.list())[0].status, 'needs_review');
});

test('cancellation during preflight prevents the atomic publish claim', async t => {
  const f = await fixture(t); const post = await f.schedule(); f.setTime(time);
  const listGrants = f.oauth.listUserGrants;
  f.oauth.listUserGrants = async (...args) => {
    await f.scheduler.execute('linkedin_cancel_scheduled_post', { scheduleId: post.scheduleId, approved: true });
    return listGrants(...args);
  };
  await f.run(); assert.equal(f.calls, 0); assert.equal((await f.list())[0].status, 'cancelled');
});

test('rescheduling during preflight prevents publishing at the old time', async t => {
  const f = await fixture(t); const post = await f.schedule(); f.setTime(time);
  const listGrants = f.oauth.listUserGrants;
  const later = new Date(time + 60000).toISOString();
  f.oauth.listUserGrants = async (...args) => {
    await f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt: later, approved: true });
    return listGrants(...args);
  };
  await f.run(); assert.equal(f.calls, 0); assert.equal((await f.list())[0].scheduledAt, later);
});

function organizationNetwork({ denied = () => false, writes = [] } = {}) {
  return async (url, init) => {
    assert.ok(url.startsWith('https://api.linkedin.com/rest/'));
    if (url.includes('/organizationAcls')) return Response.json({ elements: [{ organization: 'urn:li:organization:123', roleAssignee: member, state: 'APPROVED', role: 'ADMINISTRATOR' }, { organization: 'urn:li:organization:456', roleAssignee: member, state: 'APPROVED', role: 'ADMINISTRATOR' }] });
    if (url.includes('/organizationsLookup')) return Response.json({ results: { 123: { localizedName: 'First page' }, 456: { localizedName: 'Second page' } } });
    if (url.includes('/organizationAuthorizations/')) {
      const organization = decodeURIComponent(url).includes('urn:li:organization:456') ? 'urn:li:organization:456' : 'urn:li:organization:123';
      return Response.json({ organization, impersonator: member, status: { [denied() ? 'com.linkedin.organization.Denied' : 'com.linkedin.organization.Approved']: {} } });
    }
    assert.equal(url, 'https://api.linkedin.com/rest/posts'); assert.equal(init.method, 'POST');
    writes.push(JSON.parse(init.body));
    return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:' + (1000 + writes.length) } });
  };
}
const organizationScopes = ['w_member_social', 'rw_organization_admin', 'w_organization_social'];
test('mixed identity batch stores exact actors and publishes each approved identity once', async t => {
  const writes = [], fetchImpl = organizationNetwork({ writes });
  const f = await fixture(t, { fetchImpl, grantedScopes: organizationScopes });
  const posts = ['personal', 'First page', 'Second page'].map(actor => ({ actor, text: 'Same approved exact text', scheduledAt: new Date(time).toISOString() }));
  const result = await f.scheduler.execute('linkedin_schedule_text_posts', { posts, approved: true });
  assert.equal(result.posts.length, 3); assert.equal(new Set(result.posts.map(p => p.scheduleId)).size, 3);
  assert.deepEqual(result.posts.map(p => p.targetUrn), [member, 'urn:li:organization:123', 'urn:li:organization:456']);
  assert.deepEqual((await f.scheduler.execute('linkedin_schedule_text_posts', { posts, approved: true })).posts.map(p => p.scheduleId), result.posts.map(p => p.scheduleId));
  await runScheduler(f.env, f.oauth, { now: () => start, fetchImpl }); assert.equal(writes.length, 0);
  await Promise.all([runScheduler(f.env, f.oauth, { now: () => time, fetchImpl }), runScheduler(f.env, f.oauth, { now: () => time, fetchImpl })]);
  assert.equal(writes.length, 1);
  await runScheduler(f.env, f.oauth, { now: () => time + day, fetchImpl });
  await runScheduler(f.env, f.oauth, { now: () => time + 2 * day, fetchImpl });
  assert.equal(writes.length, 3); assert.deepEqual(new Set(writes.map(p => p.author)), new Set(result.posts.map(p => p.targetUrn)));
  assert.ok((await f.list()).every(p => p.status === 'published' && p.linkedinPostId));
});
test('revoked organization authority blocks the stored post before publishing', async t => {
  let denied = false; const writes = [], fetchImpl = organizationNetwork({ denied: () => denied, writes });
  const f = await fixture(t, { fetchImpl, grantedScopes: organizationScopes });
  const post = await f.schedule({ text: 'Approved page post', actor: 'First page', scheduledAt: new Date(time).toISOString(), approved: true });
  denied = true;
  await runScheduler(f.env, f.oauth, { now: () => time, fetchImpl });
  const [stored] = await f.list(); assert.equal(stored.scheduleId, post.scheduleId); assert.equal(stored.status, 'blocked'); assert.equal(stored.reason, 'identity_permission_unavailable'); assert.equal(writes.length, 0);
});
test('organization rescheduling retains its actor and cancellation prevents publication', async t => {
  const writes = [], fetchImpl = organizationNetwork({ writes }); const f = await fixture(t, { fetchImpl, grantedScopes: organizationScopes });
  const post = await f.schedule({ actor: 'First page', text: 'Exact approved post', scheduledAt: new Date(time).toISOString(), approved: true });
  const result = await f.scheduler.execute('linkedin_reschedule_scheduled_post', { scheduleId: post.scheduleId, scheduledAt: new Date(time + 60000).toISOString(), approved: true });
  assert.equal(result.post.targetUrn, post.targetUrn);
  await f.scheduler.execute('linkedin_cancel_scheduled_post', { scheduleId: post.scheduleId, approved: true });
  await runScheduler(f.env, f.oauth, { now: () => time + 60000, fetchImpl }); assert.equal(writes.length, 0);
});

test('D1 ownership ledger permits editing newly created comments without restricted read grants', async t => {
  const f = await fixture(t), requests = [];
  const client = createLinkedInClient({ db: f.db, config: { accessToken: secret, personUrn: member, version: '202609', writeEnabled: true, grantedScopes: ['w_member_social_feed'] }, fetchImpl: async (url, init) => {
    assert.notEqual(init.method, 'GET'); requests.push({ url, init });
    return Response.json({ commentUrn: 'urn:li:comment:(urn:li:activity:99,1)' }, { status: 201 });
  } });
  const comment = await client.execute('linkedin_create_comment', { targetUrn: 'urn:li:activity:99', text: 'Approved comment', approved: true });
  await client.execute('linkedin_edit_comment', { commentUrn: comment.id, text: 'Approved update', approved: true });
  await client.execute('linkedin_delete_comment', { commentUrn: comment.id, approved: true });
  assert.equal(requests.length, 3); assert.equal(requests[2].init.method, 'DELETE');
  await assert.rejects(client.execute('linkedin_delete_comment', { commentUrn: comment.id, targetUrn: 'urn:li:activity:100', approved: true }), /stored thread/);
});
test('identity migration preserves existing schedules, credentials and reserved historical times', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-03', d1Databases: ['SCHEDULER_DB'], outboundService: () => { throw new Error('Live network forbidden'); } }));
  t.after(() => mf.dispose()); const db = await mf.getD1Database('SCHEDULER_DB');
  const apply = async name => db.batch(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8').split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
  await apply('0001_scheduler.sql');
  await db.prepare("INSERT INTO scheduled_posts(id,dedupe_key,text,target_urn,scheduled_at,approved_at,approval_grant_id,status,updated_at) VALUES('legacy','new-key','Exact legacy text',?,?,?,'grant','blocked',?)").bind(member, time, start, start).run();
  await db.prepare("INSERT INTO schedule_keys VALUES('historical-key','legacy')").run();
  await db.prepare("INSERT INTO scheduler_credentials(target_urn,ciphertext,expires_at,user_id,grant_id) VALUES(?,'encrypted-placeholder',?,'owner','grant')").bind(member, time).run();
  await apply('0002_identities.sql');
  const row = await db.prepare("SELECT * FROM scheduled_posts WHERE id='legacy'").first(); assert.equal(row.owner_urn, member); assert.equal(row.target_urn, member); assert.equal(row.text, 'Exact legacy text'); assert.equal(row.status, 'blocked');
  assert.equal((await db.prepare("SELECT * FROM schedule_keys WHERE dedupe_key='historical-key'").first()).schedule_id, 'legacy');
  assert.equal((await db.prepare('SELECT * FROM scheduler_credentials').first()).ciphertext, 'encrypted-placeholder');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('FIFO backfill preserves order and history and reconciles the manual publication on reruns', async t => {
  const f = await fixture(t);
  const manual = 'ad77a89f-0c8c-4ac9-abd1-2165c84b8598';
  const insert = f.db.prepare(`INSERT INTO scheduled_posts(id,dedupe_key,text,target_urn,owner_urn,scheduled_at,approved_at,approval_grant_id,status,reason,linkedin_post_id,updated_at)
    VALUES(?,?,?, ?,?, ?,?,'original-grant',?,?,?,?)`);
  const seed = (id, at, status, reason, postId = null) => insert.bind(id,id,'Exact ' + id,member,member,at,start,status,reason,postId,start);
  await f.db.batch([
    seed('newer',time + 10,'scheduled',null),
    seed(manual,time - 10,'blocked','missed_time_requires_reschedule'),
    seed('older',time,'blocked','missed_time_requires_reschedule'),
    seed('historical',time - 20,'published',null,'urn:li:share:1234'),
  ]);
  const sql = readFileSync(new URL('../migrations/0005_fifo_backfill.sql', import.meta.url), 'utf8');
  const backfill = () => f.db.batch(sql.split(';').filter(part => part.trim()).map(part => f.db.prepare(part)));
  await backfill();
  const read = async () => (await f.db.prepare('SELECT * FROM scheduled_posts ORDER BY queue_position').all()).results;
  const rows = await read();
  await backfill(); assert.deepEqual(await read(), rows);
  assert.deepEqual(rows.map(row => row.id), ['historical',manual,'older','newer']);
  assert.deepEqual(rows.map(row => row.status), ['published','published','scheduled','scheduled']);
  assert.equal(rows[0].linkedin_post_id, 'urn:li:share:1234');
  assert.equal(rows[1].linkedin_post_id, 'urn:li:share:7528913699189747714');
  assert.equal(rows[1].publish_day, '2026-11-18');
  assert.equal(rows[2].approval_grant_id, 'original-grant');
  assert.equal(rows[2].text, 'Exact older');
});
