import { z } from 'zod';
import { actorSchema, LinkedInInputError } from '../apps/linkedin/identity.js';
import { createLinkedInClient, LinkedInApiError } from '../apps/linkedin/client.js';
import { getLinkedInConfig, getOwnerLinkedInConfigs, assertWriteAllowed, PERSON_URN, POST_URN } from '../apps/linkedin/config.js';

// Only fixed application errors may reach MCP responses. Never trust error text.
class SchedulerError extends Error {}

const approved = z.literal(true).describe('Set only after the user explicitly approves the exact text, identity and daily FIFO cadence, including any supplied earliest time.');
const scheduledAt = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Explicit UTC offset required');
const item = z.object({ text: z.string().min(1).max(3000).refine(value => value.trim().length > 0), targetUrn: z.string().regex(PERSON_URN).optional(), actor: actorSchema.optional(), scheduledAt: scheduledAt.optional() }).strict();
export const schedulerSchemas = {
  linkedin_schedule_text_post: item.extend({ approved }).strict(),
  linkedin_schedule_text_posts: z.object({ posts: z.array(item).min(1).max(50), approved }).strict(),
  linkedin_list_scheduled_posts: z.object({ status: z.enum(['scheduled', 'publishing', 'published', 'cancelled', 'blocked', 'failed', 'needs_review']).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  linkedin_cancel_scheduled_post: z.object({ scheduleId: z.string().uuid(), approved }).strict(),
  linkedin_reschedule_scheduled_post: z.object({ scheduleId: z.string().uuid(), scheduledAt, approved }).strict(),
  linkedin_scheduler_status: z.object({}).strict(),
};
// One Cloudflare trigger covers the 08:00 Lagos run and the recovery checks.
export const FIFO_CRON = '*/15 7-22 * * *';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STALE_MS = 5 * 60 * 1000;
const lagosDay = time => new Date(time + HOUR).toISOString().slice(0, 10);
function publishingWindow(time) {
  const localTime = (time + HOUR) % DAY;
  // Leave time for the bounded LinkedIn request to complete before midnight.
  return localTime >= 8 * HOUR && localTime < DAY - MINUTE;
}
const encoder = new TextEncoder();
const iso = value => value == null ? null : new Date(value).toISOString();
const keyReady = env => typeof env.SCHEDULER_ENCRYPTION_KEY === 'string' && /^[0-9a-f]{64}$/i.test(env.SCHEDULER_ENCRYPTION_KEY);
export const schedulerConfigured = env => Boolean(env.SCHEDULER_DB && keyReady(env));
const safeRow = row => ({ scheduleId: row.id, text: row.text, targetType: row.target_type, targetUrn: row.target_urn, targetName: row.target_name, author: { type: row.target_type, urn: row.target_urn },
  scheduledAt: iso(row.scheduled_at || null), status: row.status, approvedAt: iso(row.approved_at), publishedAt: iso(row.published_at), linkedinPostId: row.linkedin_post_id, reason: row.reason,
  queuePosition: row.queue_position, attemptCount: row.attempt_count, lastAttemptAt: iso(row.attempted_at), retryAt: iso(row.retry_at), publicationDay: row.publish_day });
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
async function encryptionKey(env) {
  if (!keyReady(env)) throw new SchedulerError('Scheduler encryption is not configured.');
  return crypto.subtle.importKey('raw', unhex(env.SCHEDULER_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptCredential(env, member, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(member) }, await encryptionKey(env), encoder.encode(token));
  return hex(iv) + ':' + hex(new Uint8Array(ciphertext));
}
async function decryptCredential(env, row) {
  const [iv, data] = row.ciphertext.split(':');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv), additionalData: encoder.encode(row.target_urn) }, await encryptionKey(env), unhex(data));
  return new TextDecoder().decode(decrypted);
}
async function dedupe(text, member, time, owner) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(owner && owner !== member ? [text, member, time, owner] : [text, member, time])))));
}
const setupRequired = () => new SchedulerError('Scheduler unavailable. Configure D1, apply migrations and set SCHEDULER_ENCRYPTION_KEY.');

// Call only from the verified owner MCP handler. Never accept credentials in tool inputs.
export async function syncSchedulerCredential(env, ctx, now = Date.now()) {
  if (!schedulerConfigured(env)) return null;
  if (ctx.props?.owner !== true || !ctx.auth?.scope?.includes('linkedin:actions') || !PERSON_URN.test(ctx.props.personUrn) || !Number.isFinite(ctx.props.expiresAt) || ctx.props.expiresAt <= now) throw new SchedulerError('Scheduler requires a current owner connection.');
  const token = await env.OAUTH_PROVIDER.unwrapToken(ctx.auth.token);
  const props = token?.grant?.props;
  if (!token || token.userId !== encodeURIComponent(ctx.props.personUrn) || !token.grantId || props?.owner !== true || props.personUrn !== ctx.props.personUrn || props.accessToken !== ctx.props.accessToken || !token.scope?.includes('linkedin:actions')) throw new SchedulerError('Scheduler requires a valid owner grant.');
  const ciphertext = await encryptCredential(env, ctx.props.personUrn, ctx.props.accessToken);
  const c = props.community;
  const community = c?.clientId === env.LINKEDIN_COMMUNITY_CLIENT_ID && typeof c?.accessToken === 'string' && c.accessToken && PERSON_URN.test(c.personUrn) && Array.isArray(c.grantedScopes) && Number.isFinite(c.expiresAt) && c.expiresAt > now ? c : null;
  const communityCipher = community ? await encryptCredential(env, ctx.props.personUrn + ':community:' + community.clientId, community.accessToken) : null;
  await env.SCHEDULER_DB.prepare(`INSERT INTO scheduler_credentials(target_urn, ciphertext, expires_at, user_id, grant_id, scopes, community_ciphertext, community_person_urn, community_scopes, community_expires_at, community_client_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_urn) DO UPDATE SET ciphertext=excluded.ciphertext,
    expires_at=excluded.expires_at, user_id=excluded.user_id, grant_id=excluded.grant_id, scopes=excluded.scopes, invalid=0, community_ciphertext=excluded.community_ciphertext, community_person_urn=excluded.community_person_urn,
    community_scopes=excluded.community_scopes, community_expires_at=excluded.community_expires_at, community_client_id=excluded.community_client_id, community_invalid=0
    WHERE excluded.expires_at > scheduler_credentials.expires_at OR
    (excluded.expires_at = scheduler_credentials.expires_at AND excluded.grant_id <> scheduler_credentials.grant_id)`)
    .bind(ctx.props.personUrn, ciphertext, ctx.props.expiresAt, token.userId, token.grantId, Array.isArray(ctx.props.grantedScopes) ? JSON.stringify(ctx.props.grantedScopes) : null, communityCipher, community?.personUrn || null, community ? JSON.stringify(community.grantedScopes) : null, community?.expiresAt || null, community?.clientId || null).run();
  return token.grantId;
}

export function createScheduler({ env, ctx, now = () => Date.now(), fetchImpl = globalThis.fetch }) {
  const db = env.SCHEDULER_DB;
  const member = ctx.props?.personUrn;
  const configs = getOwnerLinkedInConfigs(env, ctx.props || {}, now());
  const client = createLinkedInClient({ ...configs, fetchImpl });
  async function actorFor(post) {
    if (post.targetUrn && post.targetUrn !== member) throw new SchedulerError('Personal target must match the connected member.');
    const identity = await client.resolveActor(post.actor);
    if (post.targetUrn && identity.urn !== post.targetUrn) throw new SchedulerError('Actor conflicts with the approved target.');
    await client.assertActorAllowed(identity, 'publish');
    return identity;
  }
  async function find(id) {
    return db.prepare('SELECT * FROM scheduled_posts WHERE id=? AND owner_urn=?').bind(id, member).first();
  }
  return {
    async execute(name, input) {
      if (ctx.props?.owner !== true || !ctx.auth?.scope?.includes('linkedin:actions') || !PERSON_URN.test(member) || !Number.isFinite(ctx.props.expiresAt) || ctx.props.expiresAt <= now()) throw new SchedulerError('Scheduler requires a current owner connection.');
      const parsed = schedulerSchemas[name]?.safeParse(input);
      if (!parsed?.success) throw new SchedulerError('Invalid scheduler input. Provide exact text, publishing identity and explicit approval. Any supplied timestamp requires a UTC offset.');
      const data = parsed.data;
      if (!db) {
        if (name === 'linkedin_scheduler_status') return { configured: false, targetUrn: member, writesEnabled: env.LINKEDIN_WRITE_ENABLED === 'true', problem: 'scheduler_setup_required' };
        throw setupRequired();
      }
      try {
        if (name === 'linkedin_scheduler_status') {
          const health = await db.prepare('SELECT * FROM scheduler_health WHERE id=1').first();
          const counts = await db.prepare('SELECT status, count(*) AS count FROM scheduled_posts WHERE owner_urn=? GROUP BY status').bind(member).all();
          const credential = await db.prepare('SELECT expires_at, invalid, community_expires_at, community_invalid, community_client_id FROM scheduler_credentials WHERE target_urn=?').bind(member).first();
          const reasons = await db.prepare("SELECT DISTINCT reason FROM scheduled_posts WHERE owner_urn=? AND status='blocked' AND reason IS NOT NULL").bind(member).all();
          const blockingReasons = reasons.results.map(row => row.reason);
          return { configured: schedulerConfigured(env), targetUrn: member, writesEnabled: env.LINKEDIN_WRITE_ENABLED === 'true', cron: FIFO_CRON, firstRunLocalTime: '08:00', recoveryIntervalMinutes: 15, timezone: 'Africa/Lagos',
            communityConnection: { configured: Boolean(env.LINKEDIN_COMMUNITY_CLIENT_ID), expiresAt: iso(credential?.community_expires_at), reconnectionRequired: Boolean(env.LINKEDIN_COMMUNITY_CLIENT_ID) && (!credential?.community_expires_at || credential.community_invalid === 1 || credential.community_expires_at <= now() || credential.community_client_id !== env.LINKEDIN_COMMUNITY_CLIENT_ID) },
            lastRunAt: iso(health?.last_run_at), lastCompletedAt: iso(health?.last_completed_at), problem: health?.problem || null,
            counts: Object.fromEntries(counts.results.map(row => [row.status, row.count])), credentialExpiresAt: iso(credential?.expires_at),
            blockingReasons, reconnectionRequired: !credential || credential.invalid === 1 || credential.expires_at <= now() || blockingReasons.some(reason => ['grant_revoked_or_expired', 'credential_unavailable_reconnect', 'community_reconnection_required'].includes(reason)) };
        }
        if (name === 'linkedin_list_scheduled_posts') {
          const rows = await db.prepare(`SELECT * FROM scheduled_posts WHERE owner_urn=? ${data.status ? 'AND status=?' : ''} ORDER BY queue_position LIMIT ? OFFSET ?`)
            .bind(member, ...(data.status ? [data.status] : []), data.limit + 1, data.offset).all();
          return { posts: rows.results.slice(0, data.limit).map(safeRow), nextOffset: rows.results.length > data.limit ? data.offset + data.limit : null };
        }
        if (name === 'linkedin_cancel_scheduled_post') {
          const row = await db.prepare(`UPDATE scheduled_posts SET status='cancelled', reason=NULL, updated_at=? WHERE id=? AND owner_urn=?
            AND status IN ('scheduled', 'blocked', 'failed') RETURNING *`).bind(now(), data.scheduleId, member).first();
          if (row) return { post: safeRow(row) };
          const existing = await find(data.scheduleId);
          if (existing?.status === 'cancelled') return { post: safeRow(existing) };
          throw new SchedulerError('Post not found or already publishing/published; cancellation cannot stop an in-flight request.');
        }
        if (!schedulerConfigured(env)) throw setupRequired();
        try { assertWriteAllowed(getLinkedInConfig({ ...env, LINKEDIN_ACCESS_TOKEN: ctx.props.accessToken, LINKEDIN_PERSON_URN: member }), data.approved); }
        catch { throw new SchedulerError('Scheduler requires enabled LinkedIn writes and valid publishing configuration.'); }
        const grantId = await syncSchedulerCredential(env, ctx, now());
        if (name === 'linkedin_reschedule_scheduled_post') {
          const old = await find(data.scheduleId);
          if (!old || !['scheduled', 'blocked'].includes(old.status)) throw new SchedulerError('Only scheduled or blocked posts can be rescheduled.');
          await actorFor({ actor: old.target_type === "person" ? "personal" : { type: "organization", organizationUrn: old.target_urn } });
          const time = Date.parse(data.scheduledAt);
          if (time <= now()) throw new SchedulerError('Scheduled time must be in the future.');
          const key = await dedupe(old.text, old.target_urn, time, member);
          const approvalTime = now();
          const update = db.prepare(`UPDATE scheduled_posts SET dedupe_key=?, scheduled_at=?, approved_at=?, approval_grant_id=?, status='scheduled', reason=NULL, retry_at=NULL, updated_at=?
            WHERE id=? AND owner_urn=? AND status IN ('scheduled','blocked') AND dedupe_key=?
            AND NOT EXISTS (SELECT 1 FROM schedule_keys WHERE dedupe_key=? AND schedule_id<>?) RETURNING *`)
            .bind(key, time, approvalTime, grantId, approvalTime, old.id, member, old.dedupe_key, key, old.id);
          const reserve = db.prepare(`INSERT INTO schedule_keys(dedupe_key,schedule_id)
            SELECT ?,id FROM scheduled_posts WHERE id=? AND dedupe_key=? ON CONFLICT(dedupe_key) DO NOTHING`).bind(key, old.id, key);
          const results = await db.batch([update, reserve]);
          const row = results[0].results[0];
          if (!row) throw new SchedulerError('Post changed, conflicts with a reserved schedule, or is publishing; refresh the schedule list.');
          return { post: safeRow(row) };
        }
        const posts = name === 'linkedin_schedule_text_post' ? [data] : data.posts;
        const prepared = [];
        const timeNow = now();
        for (const post of posts) {
          const identity = await actorFor(post);
          const time = post.scheduledAt ? Date.parse(post.scheduledAt) : 0;
          if (post.scheduledAt && time <= timeNow) throw new SchedulerError('Scheduled time must be in the future.');
          prepared.push({ ...post, identity, time, key: await dedupe(post.text, identity.urn, time, member) });
        }
        const statements = prepared.flatMap(post => [db.prepare(`INSERT INTO scheduled_posts
          (id,dedupe_key,text,target_urn,target_type,owner_urn,target_name,scheduled_at,approved_at,approval_grant_id,status,updated_at,queue_position)
          SELECT ?,?,?,?,?,?,?,?,?,?,'scheduled',?,(SELECT COALESCE(MAX(queue_position),0)+1 FROM scheduled_posts)
          WHERE NOT EXISTS (SELECT 1 FROM schedule_keys WHERE dedupe_key=?) ON CONFLICT(dedupe_key) DO NOTHING`)
          .bind(crypto.randomUUID(), post.key, post.text, post.identity.urn, post.identity.type, member, post.identity.name, post.time, timeNow, grantId, timeNow, post.key),
          db.prepare(`INSERT INTO schedule_keys(dedupe_key,schedule_id) SELECT dedupe_key,id FROM scheduled_posts WHERE dedupe_key=? ON CONFLICT(dedupe_key) DO NOTHING`).bind(post.key)]);
        const results = await db.batch([...statements, ...prepared.map(post => db.prepare('SELECT p.* FROM scheduled_posts p JOIN schedule_keys k ON k.schedule_id=p.id WHERE k.dedupe_key=? AND p.owner_urn=?').bind(post.key, member))]);
        return { posts: results.slice(statements.length).map(result => safeRow(result.results[0])), credentialExpiresAt: iso(ctx.props.expiresAt),
          authMayExpireBeforeSomePosts: prepared.some(post => post.time >= (post.identity.type === 'organization' && env.LINKEDIN_COMMUNITY_CLIENT_ID ? ctx.props.community?.expiresAt || 0 : ctx.props.expiresAt)) };
      } catch (error) {
        // D1 errors can include SQL/bindings; never expose raw exceptions.
        if (error instanceof SchedulerError || error instanceof LinkedInInputError || error instanceof LinkedInApiError) throw error;
        throw new SchedulerError('Scheduler operation could not complete. Check configuration, migrations or a conflicting schedule; list posts before retrying.');
      }
    },
  };
}

async function activeGrant(oauth, row, now) {
  let cursor;
  do {
    const page = await oauth.listUserGrants(row.user_id, { limit: 100, ...(cursor ? { cursor } : {}) });
    const grant = page.items.find(grant => grant.id === row.grant_id);
    if (grant) return grant.scope.includes('linkedin:actions') && (!grant.expiresAt || grant.expiresAt * 1000 > now);
    cursor = page.cursor;
  } while (cursor);
  return false;
}

export async function runScheduler(env, oauth, { now = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const db = env.SCHEDULER_DB;
  if (!db) return;
  const started = now();
  const setHealth = async (completed, problem) => db.prepare(`INSERT INTO scheduler_health(id,last_run_at,last_completed_at,problem) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_completed_at=excluded.last_completed_at,problem=excluded.problem
    WHERE excluded.last_run_at>=scheduler_health.last_run_at`)
    .bind(started, completed, problem).run();
  const finish = async (outcome, problem = null) => {
    await setHealth(now(), problem);
    return outcome;
  };
  const occupied = `SELECT 1 FROM scheduled_posts WHERE status='publishing'
    OR (publish_day=? AND status IN ('published','needs_review'))`;
  const eligible = `status IN ('scheduled','blocked') AND queue_position IS NOT NULL AND linkedin_post_id IS NULL AND scheduled_at<=?`;
  try {
    if (env.FIFO_START_AT && !(started >= Date.parse(env.FIFO_START_AT))) return await finish('paused');
    if (!publishingWindow(started)) return await finish('outside_publishing_window');
    await db.prepare(`UPDATE scheduled_posts SET status='needs_review',reason='stale_publish_attempt',updated_at=? WHERE status='publishing' AND attempted_at<=?`).bind(started, started - STALE_MS).run();
    const day = lagosDay(started);
    const post = await db.prepare(`SELECT * FROM scheduled_posts WHERE ${eligible} AND NOT EXISTS (${occupied})
      ORDER BY queue_position LIMIT 1`).bind(started, day).first();
    if (!post) return await finish('no_available_slot_or_post');
    if (post.retry_at > started) return await finish('waiting_for_retry', post.reason);
    let reason = null;
    let accessToken;
    const credential = await db.prepare('SELECT * FROM scheduler_credentials WHERE target_urn=?').bind(post.owner_urn).first();
    const useCommunity = post.target_type === 'organization' && Boolean(env.LINKEDIN_COMMUNITY_CLIENT_ID);
    const selected = credential && (useCommunity ? { ciphertext: credential.community_ciphertext, target_urn: post.owner_urn + ':community:' + credential.community_client_id, expires_at: credential.community_expires_at, invalid: credential.community_invalid, person_urn: credential.community_person_urn, scopes: credential.community_scopes } : { ...credential, person_urn: post.owner_urn });
    const reconnectReason = useCommunity ? 'community_reconnection_required' : 'reconnection_required';
    const invalidColumn = useCommunity ? 'community_invalid' : 'invalid';
    const cipherColumn = useCommunity ? 'community_ciphertext' : 'ciphertext';
    const invalidate = () => db.prepare(`UPDATE scheduler_credentials SET ${invalidColumn}=1 WHERE target_urn=? AND ${cipherColumn}=?`).bind(post.owner_urn, selected.ciphertext).run();
    if (env.LINKEDIN_WRITE_ENABLED !== 'true') reason = 'writes_disabled';
    else if (!keyReady(env)) reason = 'encryption_unavailable';
    else if (!selected?.ciphertext || selected.invalid || !Number.isFinite(selected.expires_at) || selected.expires_at <= now() || (useCommunity && (!PERSON_URN.test(selected.person_urn) || credential.community_client_id !== env.LINKEDIN_COMMUNITY_CLIENT_ID))) reason = reconnectReason;
    else if (!await activeGrant(oauth, credential, now())) reason = 'grant_revoked_or_expired';
    else {
      try { accessToken = await decryptCredential(env, selected); }
      catch { reason = 'credential_unavailable_reconnect'; }
    }
    let client;
    if (!reason) {
      client = createLinkedInClient({ config: getLinkedInConfig({ ...env, LINKEDIN_ACCESS_TOKEN: accessToken, LINKEDIN_PERSON_URN: selected.person_urn, LINKEDIN_GRANTED_SCOPES: selected.scopes ? JSON.parse(selected.scopes) : null }), fetchImpl, ownerUrn: post.owner_urn });
      try {
        const identity = await client.resolveActor(post.target_type === 'person' ? 'personal' : { type: 'organization', organizationUrn: post.target_urn });
        await client.assertActorAllowed(identity, 'publish');
      } catch (error) {
        reason = error instanceof LinkedInApiError && error.status === 401 ? reconnectReason : 'identity_permission_unavailable';
        if (reason === reconnectReason) await invalidate();
      }
    }
    if (reason) {
      await db.prepare(`UPDATE scheduled_posts SET status='blocked',reason=?,updated_at=? WHERE id=? AND scheduled_at=? AND status IN ('scheduled','blocked')`).bind(reason, now(), post.id, post.scheduled_at).run();
      return await finish('blocked', reason);
    }
    const current = now();
    if (!publishingWindow(current) || lagosDay(current) !== day) return await finish('outside_publishing_window');
    const attemptId = crypto.randomUUID();
    // A single D1 write checks the FIFO head and the daily slot and claims both.
    const claimed = await db.prepare(`UPDATE scheduled_posts SET status='publishing',attempted_at=?,attempt_id=?,attempt_count=attempt_count+1,publish_day=?,reason=NULL,retry_at=NULL,updated_at=?
      WHERE id=? AND scheduled_at=? AND approval_grant_id=? AND approved_at=? AND COALESCE(retry_at,0)<=?
      AND id=(SELECT id FROM scheduled_posts WHERE ${eligible} ORDER BY queue_position LIMIT 1)
      AND NOT EXISTS (${occupied}) RETURNING *`)
      .bind(current, attemptId, day, current, post.id, post.scheduled_at, post.approval_grant_id, post.approved_at, current, current, day).first();
    if (!claimed) return await finish('claim_unavailable');
    let status, failure, publishedId = null, retryAt = null;
    try {
      // This approval comes exclusively from the immutable, approved database record.
      const result = await client.execute('linkedin_publish_text_post', { text: claimed.text, actor: claimed.target_type === 'person' ? 'personal' : { type: 'organization', organizationUrn: claimed.target_urn }, approved: true });
      if (!result.id || !POST_URN.test(result.id)) { status = 'needs_review'; failure = 'published_id_missing'; }
      else { status = 'published'; publishedId = result.id; }
    } catch (error) {
      if (error instanceof LinkedInApiError && error.status === 401) {
        status = 'blocked'; failure = reconnectReason;
        await invalidate();
      } else if (error instanceof LinkedInApiError && error.status === 429) {
        status = 'scheduled'; failure = 'linkedin_http_429';
        retryAt = now() + Math.min(4 * HOUR, 15 * MINUTE * 2 ** Math.min(claimed.attempt_count - 1, 4));
      } else if (error instanceof LinkedInApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        status = 'failed'; failure = 'linkedin_http_' + error.status;
      } else { status = 'needs_review'; failure = 'publish_outcome_unknown'; }
    }
    const finished = now();
    await db.prepare(`UPDATE scheduled_posts SET status=?,reason=?,linkedin_post_id=?,published_at=?,updated_at=?,retry_at=? WHERE id=? AND status='publishing' AND attempt_id=?`)
      .bind(status, failure || null, publishedId, status === 'published' ? finished : null, finished, retryAt, claimed.id, attemptId).run();
    return await finish(status, failure);
  } catch {
    // No raw D1, OAuth or crypto exceptions in logs/tool results.
    await setHealth(null, 'scheduler_run_failed').catch(() => {});
    throw new Error('Scheduler run failed; check scheduler status. In-flight posts will require review.');
  }
}

export function registerSchedulerTools(server, scheduler) {
  const descriptions = {
    linkedin_schedule_text_post: 'Queue one exact text post after explicit approval of the content, actor and daily 8 AM Africa/Lagos FIFO cadence. An optional scheduledAt sets the earliest eligible time. Stored approval authorizes automatic publishing.',
    linkedin_schedule_text_posts: 'Queue 1–50 exact posts in input order after explicit approval of all contents, actors and the daily FIFO cadence, including any optional earliest times. Stored approval authorizes automatic publishing.',
    linkedin_list_scheduled_posts: 'List your scheduled and historical posts with exact content, UTC times, status, safe reasons and published LinkedIn IDs.',
    linkedin_cancel_scheduled_post: 'Cancel a pending post after explicit approval. Cannot cancel publishing or published posts. Does not delete any LinkedIn post.',
    linkedin_reschedule_scheduled_post: 'Change only the time of a scheduled or blocked post after explicit approval of its exact existing content, target and new time. Cannot retry uncertain publish attempts.',
    linkedin_scheduler_status: 'Show scheduler configuration, last cron execution, post counts and whether reconnection is required. Does not contact LinkedIn.',
  };
  for (const [name, schema] of Object.entries(schedulerSchemas)) {
    const readOnly = ['linkedin_list_scheduled_posts', 'linkedin_scheduler_status'].includes(name);
    server.registerTool(name, { description: descriptions[name], inputSchema: schema.shape,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: name !== 'linkedin_reschedule_scheduled_post', openWorldHint: !readOnly } }, async input => {
      try {
        const data = await scheduler.execute(name, input);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { success: true, ...data } };
      } catch (error) {
        const message = error instanceof SchedulerError ? error.message : 'Scheduler operation could not complete; check scheduler status.';
        return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { success: false, error: message } };
      }
    });
  }
}
