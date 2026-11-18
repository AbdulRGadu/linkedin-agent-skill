import { z } from 'zod';
import { assertWriteAllowed, configurationIssues, getLinkedInConfig, POST_URN, COMMENT_URN } from './config.js';
import { actorSchema, ORGANIZATION_URN, parseScopes, postReferenceSchema, socialReferenceSchema, resolvePostReference, canonicalPost, commentParts, LinkedInInputError } from './identity.js';
export const REACTIONS = Object.freeze({ LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny' });
const post = postReferenceSchema;
const comment = z.string().regex(COMMENT_URN, 'Expected composite comment URN');
const target = socialReferenceSchema;
const text = max => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Text cannot be blank');
const approved = z.literal(true).describe('True only after explicit approval of this exact action, target and content.');
const actor = actorSchema.optional().describe('Identity explicitly approved by the user; defaults to the authenticated personal profile. Never change identity under a prior approval.');
const paging = { start: z.number().int().min(0).default(0), count: z.number().int().min(1).max(100).default(20) };
// Rest.li tuple components must escape parentheses and commas inside comment URNs.
const encodeUrn = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
export const schemas = {
  linkedin_connection_status: z.object({}).strict(),
  linkedin_publish_text_post: z.object({ text: text(3000), actor, approved }).strict(),
  linkedin_create_comment: z.object({ targetUrn: post, text: text(1250), actor, approved }).strict(),
  linkedin_reply_to_comment: z.object({ parentCommentUrn: comment, rootPostUrn: post, text: text(1250), actor, approved }).strict(),
  linkedin_add_reaction: z.object({ targetUrn: target, reactionType: z.enum(Object.keys(REACTIONS)), actor, approved }).strict(),
  linkedin_remove_reaction: z.object({ targetUrn: target, actor, approved }).strict(),
  linkedin_capabilities: z.object({}).strict(),
  linkedin_list_managed_organizations: z.object({}).strict(),
  linkedin_resolve_actor: z.object({ actor: actorSchema }).strict(),
  linkedin_resolve_post_target: z.object({ target: post }).strict(),
  linkedin_list_recent_posts: z.object({ actor, ...paging }).strict(),
  linkedin_get_post: z.object({ targetUrn: post, actor }).strict(),
  linkedin_get_comments: z.object({ targetUrn: post, actor, ...paging }).strict(),
  linkedin_get_replies: z.object({ parentCommentUrn: comment, actor, ...paging }).strict(),
  linkedin_find_unanswered_comments: z.object({ targetUrn: post, actor, ...paging }).strict(),
  linkedin_get_social_metadata: z.object({ targetUrn: target, actor }).strict(),
  linkedin_edit_comment: z.object({ commentUrn: comment, targetUrn: target.optional(), text: text(1250), actor, approved }).strict(),
  linkedin_delete_comment: z.object({ commentUrn: comment, targetUrn: target.optional(), actor, approved }).strict(),
  linkedin_edit_post: z.object({ targetUrn: post, text: text(3000), actor, approved }).strict(),
  linkedin_delete_post: z.object({ targetUrn: post, actor, approved }).strict(),
  linkedin_publish_article_post: z.object({ text: text(3000), source: z.string().url().refine(url => new URL(url).protocol === 'https:'), title: text(200), description: text(500).optional(), actor, approved }).strict(),
};
export const READ_TOOLS = new Set(['linkedin_connection_status', 'linkedin_capabilities', 'linkedin_list_managed_organizations', 'linkedin_resolve_actor', 'linkedin_resolve_post_target',
  'linkedin_list_recent_posts', 'linkedin_get_post', 'linkedin_get_comments', 'linkedin_get_replies', 'linkedin_find_unanswered_comments', 'linkedin_get_social_metadata']);
export class LinkedInApiError extends Error {
  constructor(status) {
    const advice = { 401: 'Token expired or invalid; reauthorize.', 403: 'Check approved LinkedIn products, member scopes, and target access.', 429: 'Rate limited; wait before trying again.' }[status] || 'Check LinkedIn availability and request permissions.';
    super('LinkedIn API returned HTTP ' + status + '. ' + advice);
    this.name = 'LinkedInApiError'; this.status = status;
  }
}
// Both gates protect direct client calls as well as MCP calls.
export async function introspectLinkedInScopes(config, fetchImpl = globalThis.fetch) {
  if (!config.clientId || !config.clientSecret || !config.accessToken) return null;
  try {
    const response = await fetchImpl('https://www.linkedin.com/oauth/v2/introspectToken', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: config.accessToken }) });
    if (!response.ok) return null;
    const result = await response.json();
    if (result.active !== true || (result.client_id && result.client_id !== config.clientId) || typeof result.scope !== 'string') return null;
    return parseScopes(result.scope);
  } catch { return null; }
}
// D1 is optional for local usage; it adds an ownership ledger, not a second publisher.
export function createLinkedInClient({ config = getLinkedInConfig(), fetchImpl = globalThis.fetch, db, schedulerAvailable = false, organizationConfig, connections, ownerUrn = config.personUrn } = {}) {
  const organizationClient = organizationConfig ? createLinkedInClient({ config: organizationConfig, fetchImpl, db, schedulerAvailable, ownerUrn }) : null;
  const isOrganization = selector => selector !== undefined && selector !== 'personal' && selector?.type !== 'personal';
  let scopesPromise;
  let organizationsPromise;
  const scrub = value => {
    let json = JSON.stringify(value);
    for (const secret of [config.accessToken, config.clientSecret, organizationConfig?.accessToken, organizationConfig?.clientSecret]) if (secret?.length >= 6) json = json.split(secret).join('[redacted]');
    return JSON.parse(json);
  };
  const scopes = async () => {
    if (Array.isArray(config.grantedScopes)) return config.grantedScopes;
    scopesPromise ||= introspectLinkedInScopes(config, fetchImpl);
    return scopesPromise;
  };
  async function requireScope(scope) {
    const grants = await scopes();
    // Preserve existing personal post publishing for legacy grants. Additional
    // capabilities require verified scope evidence, never requested scopes alone.
    if (grants === null && scope === 'w_member_social') return;
    if (!grants?.includes(scope)) throw new LinkedInInputError('Capability unavailable: LinkedIn has not verified required scope ' + scope + '. Enable the eligible product and reconnect; documented endpoints alone do not grant access.');
  }
  async function request(path, method, payload, extraHeaders = {}, raw = false) {
    let response;
    try {
      response = await fetchImpl('https://api.linkedin.com' + path, {
        // Workers supports manual redirects; all non-2xx responses fail below.
        method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + config.accessToken, 'Linkedin-Version': config.version, 'X-Restli-Protocol-Version': '2.0.0', ...extraHeaders, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new Error('LinkedIn network request failed or timed out. Outcome may be unknown; do not retry blindly.');
    }
    // Never expose upstream bodies/statusText or fetch exception causes.
    if (!response.ok) throw new LinkedInApiError(response.status);
    let body = null;
    try { const raw = await response.text(); body = raw ? JSON.parse(raw) : null; }
    catch { throw new Error('LinkedIn returned an unreadable response. Outcome may be unknown; verify before retrying.'); }
    const safeId = value => typeof value === 'string' && (POST_URN.test(value) || COMMENT_URN.test(value) || /^[0-9]+$/.test(value)) ? value : null;
    if (raw) return body;
    // Prefer canonical commentUrn; numeric ids and resourceidentity headers can
    // refer to different threads and must not be invented into composite URNs.
    return { id: safeId(body?.commentUrn || response.headers.get('x-restli-id') || body?.id), status: response.status };
  }
  const get = path => request(path, 'GET', undefined, {}, true);
  const authorizationAction = (action, urn) => `/rest/organizationAuthorizations/(impersonator:${encodeUrn(config.personUrn)},organization:${encodeUrn(urn)},action:(organizationContentAuthorizationAction:(actionType:${action})))`;
  async function organizationAllowed(urn, action) {
    await requireScope('rw_organization_admin');
    const result = await get(authorizationAction(action, urn));
    return result?.organization === urn && result?.impersonator === config.personUrn && Object.hasOwn(result.status || {}, 'com.linkedin.organization.Approved');
  }
  async function managedOrganizations() {
    const grants = await scopes();
    if (!grants?.some(scope => ['r_organization_admin', 'rw_organization_admin'].includes(scope))) return { available: false, organizations: [], reason: 'Organization discovery requires verified r_organization_admin or rw_organization_admin and Community Management access.' };
    const pages = new Map();
    let start = 0, more = true;
    while (more && start < 10000) {
      const response = await get('/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=' + start);
      if (!Array.isArray(response?.elements)) throw new LinkedInInputError('LinkedIn organization discovery returned invalid data.');
      for (const acl of response.elements) {
        const urn = acl.organization || acl.organizationTarget;
        if (!ORGANIZATION_URN.test(urn) || acl.state !== 'APPROVED' || acl.roleAssignee !== config.personUrn) continue;
        if (!pages.has(urn)) pages.set(urn, { type: 'organization', urn, organizationUrn: urn, name: null, vanityName: null, logo: null, roles: [] });
        if (typeof acl.role === 'string' && !pages.get(urn).roles.includes(acl.role)) pages.get(urn).roles.push(acl.role);
      }
      start += 100;
      more = Boolean(response.paging?.links?.some(link => link.rel === 'next')) || response.paging?.total > start || response.elements.length === 100;
    }
    const entries = [...pages.values()];
    for (let index = 0; index < entries.length; index += 100) {
      const batch = entries.slice(index, index + 100);
      try {
        const info = await get('/rest/organizationsLookup?ids=List(' + batch.map(page => page.urn.split(':').at(-1)).join(',') + ')');
        for (const page of batch) {
          const value = info?.results?.[page.urn.split(':').at(-1)];
          if (!value) continue;
          page.name = typeof value.localizedName === 'string' ? value.localizedName : Object.values(value.name?.localized || {}).find(value => typeof value === 'string') || null;
          page.vanityName = typeof value.vanityName === 'string' ? value.vanityName : null;
          page.logo = typeof value.logoV2?.original === 'string' && /^urn:li:digitalmediaAsset:/.test(value.logoV2.original) ? value.logoV2.original : null;
        }
      } catch { /* Keep authorized identities even when optional lookup is unavailable. */ }
    }
    return { available: true, organizations: entries, truncated: more, nextStart: more ? start : null };
  }
  const discover = () => organizationsPromise ||= managedOrganizations();
  async function resolveActor(selector) {
    if (selector === undefined || selector === 'personal' || selector?.type === 'personal') return { type: 'person', urn: config.personUrn, name: 'Your personal profile' };
    if (organizationClient) return organizationClient.resolveActor(selector);
    const parsed = actorSchema.safeParse(selector);
    if (!parsed.success) throw new LinkedInInputError('Invalid LinkedIn identity selector.');
    const list = await discover();
    if (!list.available) throw new LinkedInInputError(list.reason);
    if (list.truncated) throw new LinkedInInputError('Managed page discovery is incomplete. Narrowing a name could select the wrong identity; contact the operator.');
    const name = typeof selector === 'string' ? selector : selector.organizationName;
    const urn = typeof selector === 'object' ? selector.organizationUrn : null;
    const normalize = value => value?.normalize('NFKC').trim().toLocaleLowerCase('en-US');
    const matches = list.organizations.filter(page => urn ? page.urn === urn : [page.name, page.vanityName].some(value => value && normalize(value) === normalize(name)));
    if (matches.length !== 1) throw new LinkedInInputError(matches.length ? 'Organization name is ambiguous. List managed pages and ask which identity; never guess.' : 'Organization is not among the authenticated member\'s approved managed pages.');
    const page = matches[0];
    if (urn && name && ![page.name, page.vanityName].some(value => normalize(value) === normalize(name))) throw new LinkedInInputError('Organization name and identifier do not match. Confirm the actor again.');
    return page;
  }
  const scopeFor = (identity, operation) => (identity.type === 'person' ? {
    publish: 'w_member_social', edit_post: 'w_member_social', delete_post: 'w_member_social', social_write: 'w_member_social_feed', read_posts: 'r_member_social', social_read: 'r_member_social_feed',
  } : { publish: 'w_organization_social', edit_post: 'w_organization_social', delete_post: 'w_organization_social', social_write: 'w_organization_social_feed', read_posts: 'r_organization_social', social_read: 'r_organization_social_feed' })[operation];
  async function assertActorAllowed(identity, operation) {
    if (organizationClient && identity.type === "organization") return organizationClient.assertActorAllowed(identity, operation);
    await requireScope(scopeFor(identity, operation));
    if (identity.type === 'person') {
      if (identity.urn !== config.personUrn) throw new LinkedInInputError('Cannot act as another LinkedIn member.');
      return;
    }
    const action = { publish: 'ORGANIC_SHARE_CREATE', edit_post: 'ORGANIC_SHARE_EDIT', delete_post: 'ORGANIC_SHARE_DELETE', social_write: 'ORGANIC_SHARE_CREATE', read_posts: 'ORGANIC_SHARE_VIEW_AS_AUTHOR', social_read: 'ORGANIC_SHARE_VIEW_AS_AUTHOR' }[operation];
    if (!await organizationAllowed(identity.urn, action)) throw new LinkedInInputError('LinkedIn denied this action for the organization. Confirm current page permissions.');
    // Endpoint-specific role restrictions accompany the permission check.
    if (['social_write', 'social_read'].includes(operation)) {
      const roles = operation === 'social_write' ? ['ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER', 'RECRUITING_POSTER'] : ['ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER'];
      if (!identity.roles?.some(role => roles.includes(role))) throw new LinkedInInputError('The current page role is not eligible for this social-feed endpoint.');
    }
  }
  async function identityCapabilities(identity) {
    const grants = await scopes();
    const caps = {};
    const operations = { publish: 'publish', edit_post: 'edit_post', delete_post: 'delete_post', comment: 'social_write', reply: 'social_write', react: 'social_write', remove_reaction: 'social_write', edit_comment: 'social_write', delete_comment: 'social_write', read_recent_posts: 'read_posts', read_comments: 'social_read', read_replies: 'social_read', engagement: 'social_read' };
    const authorization = new Map();
    for (const [key, operation] of Object.entries(operations)) {
      const scope = scopeFor(identity, operation);
      if (!grants) { caps[key] = false; continue; }
      if (!grants.includes(scope) || (['publish', 'edit_post', 'delete_post', 'social_write'].includes(operation) && !config.writeEnabled)) { caps[key] = false; continue; }
      if (!authorization.has(operation)) {
        try { await assertActorAllowed(identity, operation); authorization.set(operation, true); }
        catch { authorization.set(operation, false); }
      }
      caps[key] = authorization.get(operation);
    }
    caps.schedule = caps.publish && schedulerAvailable;
    return { ...caps, grantsVerified: grants !== null, ownershipVerification: 'Edit/delete requires a stored creation record or an authorized ownership read.', requiredScopes: Object.fromEntries(Object.entries(operations).map(([key, value]) => [key, scopeFor(identity, value)])) };
  }
  async function listOrganizationsWithCapabilities() {
    if (organizationClient) return organizationClient.execute("linkedin_list_managed_organizations", {});
    try {
      const list = await discover();
      return { ...list, organizations: await Promise.all(list.organizations.map(async identity => ({ ...identity, capabilities: await identityCapabilities(identity) }))) };
    } catch (error) {
      return { available: false, organizations: [], reason: error instanceof LinkedInApiError ? 'LinkedIn organization discovery refused or unavailable (HTTP ' + error.status + '). Check products, grants and page access.' : 'LinkedIn organization discovery unavailable. Check verified grants and retry later.' };
    }
  }
  async function record(id, identity, kind, targetUrn) {
    if (!db || !id || (kind === 'comment' && !COMMENT_URN.test(id))) return;
    await db.prepare(`INSERT INTO linkedin_objects(member_urn,object_urn,actor_urn,kind,target_urn) VALUES(?,?,?,?,?)
      ON CONFLICT(member_urn,object_urn) DO NOTHING`).bind(ownerUrn, id, identity.urn, kind, targetUrn || null).run();
  }
  async function ownedObject(urn, identity, kind, suppliedTarget) {
    const stored = db ? await db.prepare('SELECT * FROM linkedin_objects WHERE member_urn=? AND object_urn=? AND actor_urn=? AND kind=?').bind(ownerUrn, urn, identity.urn, kind).first() : null;
    if (stored) {
      if (suppliedTarget && suppliedTarget !== stored.target_urn) throw new LinkedInInputError('Supplied comment target does not match its stored thread.');
      return stored.target_urn;
    }
    if (kind === 'post' && db) {
      const scheduled = await db.prepare('SELECT id FROM scheduled_posts WHERE owner_urn=? AND target_urn=? AND linkedin_post_id=? AND status=\'published\'').bind(ownerUrn, identity.urn, urn).first();
      if (scheduled) return null;
    }
    await assertActorAllowed(identity, kind === 'post' ? 'read_posts' : 'social_read');
    const thread = suppliedTarget || (kind === 'comment' ? commentParts(urn).activityUrn : null);
    const result = await get(kind === 'post' ? '/rest/posts/' + encodeUrn(urn) : '/rest/socialActions/' + encodeUrn(thread) + '/comments/' + commentParts(urn).id);
    if ((kind === 'post' ? result?.author : result?.actor) !== identity.urn) throw new LinkedInInputError('Cannot edit/delete content owned by another identity.');
    return thread;
  }
  const projectionPost = row => ({ id: POST_URN.test(row?.id) ? row.id : null, authorUrn: row?.author, text: row?.commentary,
    createdAt: row?.createdAt, publishedAt: row?.publishedAt, lastModifiedAt: row?.lastModifiedAt, status: row?.lifecycleState });
  const projectionComment = row => ({ commentUrn: COMMENT_URN.test(row?.commentUrn) ? row.commentUrn :
    (/^urn:li:activity:[1-9][0-9]*$/.test(row?.object) && /^[1-9][0-9]*$/.test(String(row?.id)) ? `urn:li:comment:(${row.object},${row.id})` : null),
    actorUrn: row?.actor, text: row?.message?.text, objectUrn: row?.object, parentCommentUrn: row?.parentComment,
    createdAt: row?.created?.time, modifiedAt: row?.lastModified?.time, replyCount: row?.commentsSummary?.totalFirstLevelComments ?? null });
  function paged(body, data, map) {
    if (!Array.isArray(body?.elements)) throw new LinkedInInputError('LinkedIn returned invalid collection data.');
    const more = Boolean(body.paging?.links?.some(link => link.rel === 'next')) || body.paging?.total > data.start + data.count || body.elements.length === data.count;
    return { items: body.elements.map(map), nextStart: more ? data.start + data.count : null, complete: data.start === 0 && !more };
  }
  async function commentsPage(targetUrn, data) {
    const body = await get('/rest/socialActions/' + encodeUrn(targetUrn) + '/comments?start=' + data.start + '&count=' + data.count);
    return paged(body, data, projectionComment);
  }
  async function publish(data, identity, content) {
    const result = await request('/rest/posts', 'POST', { author: identity.urn, commentary: data.text, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false, ...(content ? { content } : {}) });
    await record(result.id, identity, 'post'); return result;
  }
  return {
    resolveActor,
    assertActorAllowed,
    connectionStatus() {
      const issues = configurationIssues(config);
      return { configured: issues.length === 0, writeEnabled: config.writeEnabled === true, issues,
        version: /^\d{6}$/.test(config.version) ? config.version : null, connectionVerified: false, ...(connections ? { connections } : {}) };
    },
    async execute(name, input) {
      if (!Object.hasOwn(schemas, name)) throw new Error('Unknown LinkedIn tool');
      if (name === 'linkedin_connection_status') { schemas[name].parse(input); return this.connectionStatus(); }
      if (!READ_TOOLS.has(name)) assertWriteAllowed(config, input?.approved);
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) throw new LinkedInInputError('Invalid LinkedIn action input: check identifiers, text length, reaction, and approval.');
      const data = parsed.data;
      if (organizationClient && isOrganization(data.actor)) return scrub(await organizationClient.execute(name, input));
      if (name === 'linkedin_resolve_post_target') {
        const urn = resolvePostReference(data.target);
        return { socialTargetUrn: urn, postUrn: /^urn:li:(share|ugcPost):/.test(urn) ? urn : null, source: 'identifier_in_input', fetched: false, activityToPostMappingAvailable: false };
      }
      if (name === 'linkedin_list_managed_organizations') return scrub(await listOrganizationsWithCapabilities());
      if (name === 'linkedin_capabilities') {
        const organizations = await listOrganizationsWithCapabilities();
        return scrub({ personal: { type: 'person', urn: config.personUrn, name: 'Your personal profile', ...(await identityCapabilities({ type: 'person', urn: config.personUrn })) },
          organizations, ...(connections ? { connections } : {}), grantedScopes: await scopes(), writesEnabled: config.writeEnabled, scheduler: { available: schedulerAvailable },
          messaging: { available: false, reason: 'Messages API requires a separate LinkedIn approved-partner API agreement; no authorization for this app is configured.' },
          invitations: { available: false, reason: 'Invitations API requires a separate approved-partner API agreement; not implemented.' },
          follows: { available: false, reason: 'No supported follow permission/integration configured.' }, broader_feed: { available: false, reason: 'No general feed crawling API integration; no scraping.' },
          media: { article: { implemented: true, requiredScopes: ['w_member_social', 'w_organization_social'], availability: 'See publish capability for the selected identity.' }, uploads: false, reason: 'Images, multiple images, documents and video are documented but upload handling is deferred.' } });
      }
      const identity = await resolveActor(data.actor);
      if (name === 'linkedin_resolve_actor') return scrub({ actor: identity, capabilities: await identityCapabilities(identity) });
      const operation = name.includes('publish_') ? 'publish' : name === 'linkedin_edit_post' ? 'edit_post' : name === 'linkedin_delete_post' ? 'delete_post' :
        ['linkedin_list_recent_posts', 'linkedin_get_post'].includes(name) ? 'read_posts' : READ_TOOLS.has(name) ? 'social_read' : 'social_write';
      await assertActorAllowed(identity, operation);
      const targetUrn = data.targetUrn && (COMMENT_URN.test(data.targetUrn) ? data.targetUrn : resolvePostReference(data.targetUrn));
      switch (name) {
        case 'linkedin_publish_text_post':
          return publish(data, identity);
        case 'linkedin_publish_article_post':
          return publish(data, identity, { article: { source: data.source, title: data.title, ...(data.description ? { description: data.description } : {}) } });
        case 'linkedin_create_comment': {
          const result = await request('/rest/socialActions/' + encodeUrn(targetUrn) + '/comments', 'POST', { actor: identity.urn, object: targetUrn, message: { text: data.text } });
          await record(result.id, identity, 'comment', targetUrn); return result;
        }
        case 'linkedin_reply_to_comment':
          // Share and activity IDs may differ; compare only activity URNs.
          { const root = resolvePostReference(data.rootPostUrn);
            if (root.startsWith('urn:li:activity:') && !data.parentCommentUrn.startsWith('urn:li:comment:(' + root + ',')) throw new LinkedInInputError('Parent comment does not belong to supplied activity.');
            const result = await request('/rest/socialActions/' + encodeUrn(data.parentCommentUrn) + '/comments', 'POST', { actor: identity.urn, object: root, parentComment: data.parentCommentUrn, message: { text: data.text } });
            await record(result.id, identity, 'comment', data.parentCommentUrn); return result;
          }
        case 'linkedin_add_reaction':
          return request('/rest/reactions?actor=' + encodeUrn(identity.urn), 'POST', { root: targetUrn, reactionType: data.reactionType });
        case 'linkedin_remove_reaction':
          await request('/rest/reactions/(actor:' + encodeUrn(identity.urn) + ',entity:' + encodeUrn(targetUrn) + ')', 'DELETE');
          return { removed: true, targetUrn };
        case 'linkedin_list_recent_posts': {
          const body = await get('/rest/posts?q=author&author=' + encodeUrn(identity.urn) + '&sortBy=LAST_MODIFIED&start=' + data.start + '&count=' + data.count);
          const result = paged(body, data, projectionPost);
          if (result.items.some(post => post.authorUrn !== identity.urn)) throw new LinkedInInputError('LinkedIn returned a post from another identity.');
          return scrub({ ...result, ordering: 'LAST_MODIFIED', latestCreatedRequiresCompletePagination: true, actor: identity });
        }
        case 'linkedin_get_post': {
          const row = await get('/rest/posts/' + encodeUrn(canonicalPost(data.targetUrn)));
          if (row?.author !== identity.urn) throw new LinkedInInputError('Post does not belong to the selected identity.');
          return scrub(projectionPost(row));
        }
        case 'linkedin_get_comments':
        case 'linkedin_get_replies': {
          const page = await commentsPage(name === 'linkedin_get_replies' ? data.parentCommentUrn : targetUrn, data);
          const latest = [...page.items].filter(row => Number.isFinite(row.createdAt)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
          return scrub({ ...page, latestInPage: latest, latestIsGlobal: page.complete });
        }
        case 'linkedin_find_unanswered_comments': {
          const page = await commentsPage(targetUrn, data);
          const items = [];
          // Bounded page size; only claim unanswered when all replies were read.
          for (const row of page.items.slice(0, 20)) {
            if (!row.commentUrn || row.actorUrn === identity.urn) continue;
            let start = 0, answered = false, complete = false;
            for (let index = 0; index < 10; index++) {
              const replies = await commentsPage(row.commentUrn, { start, count: 100 });
              if (replies.items.some(reply => reply.actorUrn === identity.urn)) { answered = true; break; }
              if (replies.nextStart === null) { complete = true; break; }
              start = replies.nextStart;
            }
            items.push({ ...row, answeredByActor: answered ? true : complete ? false : null });
          }
          return scrub({ items, actor: identity, nextStart: page.items.length > 20 ? data.start + 20 : page.nextStart,
            complete: page.complete && page.items.length <= 20, unanswered: items.filter(row => row.answeredByActor === false) });
        }
        case 'linkedin_get_social_metadata': {
          const value = await get('/rest/socialMetadata/' + encodeUrn(targetUrn));
          return scrub({ targetUrn, reactionSummaries: value?.reactionSummaries, commentSummary: value?.commentSummary, commentsState: value?.commentsState });
        }
        case 'linkedin_edit_comment':
        case 'linkedin_delete_comment': {
          const thread = await ownedObject(data.commentUrn, identity, 'comment', targetUrn);
          const path = '/rest/socialActions/' + encodeUrn(thread) + '/comments/' + commentParts(data.commentUrn).id + (identity.type === 'organization' ? '?actor=' + encodeUrn(identity.urn) : '');
          await request(path, name === 'linkedin_delete_comment' ? 'DELETE' : 'POST', name === 'linkedin_delete_comment' ? undefined : { patch: { message: { $set: { text: data.text } } } }, name === 'linkedin_delete_comment' ? {} : { 'X-RestLi-Method': 'PARTIAL_UPDATE' });
          return { commentUrn: data.commentUrn, actorUrn: identity.urn, deleted: name === 'linkedin_delete_comment', edited: name === 'linkedin_edit_comment' };
        }
        case 'linkedin_edit_post':
        case 'linkedin_delete_post': {
          const urn = canonicalPost(data.targetUrn);
          await ownedObject(urn, identity, 'post');
          await request('/rest/posts/' + encodeUrn(urn), name === 'linkedin_delete_post' ? 'DELETE' : 'POST', name === 'linkedin_delete_post' ? undefined : { patch: { $set: { commentary: data.text } } }, name === 'linkedin_delete_post' ? {} : { 'X-RestLi-Method': 'PARTIAL_UPDATE' });
          return { postUrn: urn, actorUrn: identity.urn, deleted: name === 'linkedin_delete_post', edited: name === 'linkedin_edit_post' };
        }
      }
    },
  };
}
