import { z } from 'zod';
import { assertWriteAllowed, configurationIssues, getLinkedInConfig, POST_URN, COMMENT_URN } from './config.js';
export const REACTIONS = Object.freeze({ LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny' });
const post = z.string().regex(POST_URN, 'Expected share, ugcPost, or activity URN');
const comment = z.string().regex(COMMENT_URN, 'Expected composite comment URN');
const target = z.union([post, comment]);
const text = max => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Text cannot be blank');
const approved = z.literal(true).describe('True only after explicit approval of this exact action, target and content.');
// Rest.li tuple components must escape parentheses and commas inside comment URNs.
const encodeUrn = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
export const schemas = {
  linkedin_connection_status: z.object({}).strict(),
  linkedin_publish_text_post: z.object({ text: text(3000), approved }).strict(),
  linkedin_create_comment: z.object({ targetUrn: post, text: text(1250), approved }).strict(),
  linkedin_reply_to_comment: z.object({ parentCommentUrn: comment, rootPostUrn: post, text: text(1250), approved }).strict(),
  linkedin_add_reaction: z.object({ targetUrn: target, reactionType: z.enum(Object.keys(REACTIONS)), approved }).strict(),
  linkedin_remove_reaction: z.object({ targetUrn: target, approved }).strict(),
};
export class LinkedInApiError extends Error {
  constructor(status) {
    const advice = { 401: 'Token expired or invalid; reauthorize.', 403: 'Check approved LinkedIn products, member scopes, and target access.', 429: 'Rate limited; wait before trying again.' }[status] || 'Check LinkedIn availability and request permissions.';
    super('LinkedIn API returned HTTP ' + status + '. ' + advice);
    this.name = 'LinkedInApiError'; this.status = status;
  }
}
// Both gates protect direct client calls as well as MCP calls.
export function createLinkedInClient({ config = getLinkedInConfig(), fetchImpl = globalThis.fetch } = {}) {
  async function request(path, method, payload) {
    let response;
    try {
      response = await fetchImpl('https://api.linkedin.com' + path, {
        // Workers supports manual redirects; all non-2xx responses fail below.
        method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + config.accessToken, 'Linkedin-Version': config.version, 'X-Restli-Protocol-Version': '2.0.0', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
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
    return { id: safeId(response.headers.get('x-restli-id') || body?.commentUrn || body?.id), status: response.status };
  }
  return {
    connectionStatus() {
      const issues = configurationIssues(config);
      return { configured: issues.length === 0, writeEnabled: config.writeEnabled === true, issues,
        version: /^\d{6}$/.test(config.version) ? config.version : null, connectionVerified: false };
    },
    async execute(name, input) {
      if (!Object.hasOwn(schemas, name)) throw new Error('Unknown LinkedIn tool');
      if (name === 'linkedin_connection_status') { schemas[name].parse(input); return this.connectionStatus(); }
      assertWriteAllowed(config, input?.approved);
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) throw new Error('Invalid LinkedIn action input: check identifiers, text length, reaction, and approval.');
      const data = parsed.data;
      switch (name) {
        case 'linkedin_publish_text_post':
          return request('/rest/posts', 'POST', { author: config.personUrn, commentary: data.text, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false });
        case 'linkedin_create_comment':
          return request('/rest/socialActions/' + encodeUrn(data.targetUrn) + '/comments', 'POST', { actor: config.personUrn, object: data.targetUrn, message: { text: data.text } });
        case 'linkedin_reply_to_comment':
          // Share and activity IDs may differ; compare only activity URNs.
          if (data.rootPostUrn.startsWith('urn:li:activity:') && !data.parentCommentUrn.startsWith('urn:li:comment:(' + data.rootPostUrn + ',')) throw new Error('Parent comment does not belong to supplied activity.');
          return request('/rest/socialActions/' + encodeUrn(data.parentCommentUrn) + '/comments', 'POST', { actor: config.personUrn, object: data.rootPostUrn, parentComment: data.parentCommentUrn, message: { text: data.text } });
        case 'linkedin_add_reaction':
          return request('/rest/reactions?actor=' + encodeUrn(config.personUrn), 'POST', { root: data.targetUrn, reactionType: data.reactionType });
        case 'linkedin_remove_reaction':
          await request('/rest/reactions/(actor:' + encodeUrn(config.personUrn) + ',entity:' + encodeUrn(data.targetUrn) + ')', 'DELETE');
          return { removed: true, targetUrn: data.targetUrn };
      }
    },
  };
}
