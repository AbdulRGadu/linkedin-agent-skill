import { z } from 'zod';
import { POST_URN, COMMENT_URN } from './config.js';

export const ORGANIZATION_URN = /^urn:li:organization:[1-9][0-9]*$/;
export const actorSchema = z.union([
  z.string().min(1).max(200).describe('personal, or the exact name/vanity name of one managed page'),
  z.object({ type: z.literal('personal') }).strict(),
  z.object({ type: z.literal('organization'), organizationUrn: z.string().regex(ORGANIZATION_URN).optional(), organizationName: z.string().min(1).max(200).optional() }).strict()
    .refine(value => value.organizationUrn || value.organizationName, 'Organization selector required'),
]);
export const BASE_SCOPES = ['openid', 'profile', 'w_member_social'];
export const SUPPORTED_SCOPES = [...BASE_SCOPES, 'w_member_social_feed', 'r_member_social', 'r_member_social_feed',
  'w_organization_social', 'r_organization_social', 'w_organization_social_feed', 'r_organization_social_feed', 'r_organization_admin', 'rw_organization_admin'];
export const parseScopes = value => typeof value === 'string' ? [...new Set(value.split(/[\s,]+/).filter(scope => SUPPORTED_SCOPES.includes(scope)))] : [];
export function requestedScopes(env) {
  const extra = String(env.LINKEDIN_OPTIONAL_SCOPES || '').split(/[\s,]+/).filter(Boolean);
  if (extra.some(scope => !SUPPORTED_SCOPES.includes(scope))) throw new Error('Unsupported LinkedIn OAuth scope configuration.');
  return [...new Set([...BASE_SCOPES, ...extra])];
}
export class LinkedInInputError extends Error {}
export function resolvePostReference(value) {
  if (POST_URN.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new LinkedInInputError('Invalid post target: supply a LinkedIn post URL or known URN.'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.port || url.username || url.password) throw new LinkedInInputError('Invalid LinkedIn post URL.');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { throw new LinkedInInputError('Invalid LinkedIn post URL.'); }
  const feed = path.match(/^\/feed\/update\/(urn:li:(?:activity|share|ugcPost):[1-9][0-9]*)\/?$/);
  const post = path.startsWith('/posts/') && path.match(/[_-]activity-([1-9][0-9]*)(?:-|\/|$)/);
  if (feed) return feed[1];
  if (post) return 'urn:li:activity:' + post[1];
  throw new LinkedInInputError('This URL does not expose a reliable post identifier. Supply a canonical post URL or an API-returned target; no scraping is used.');
}
export const postReferenceSchema = z.string().min(1).max(2048).refine(value => { try { resolvePostReference(value); return true; } catch { return false; } }, 'Expected LinkedIn post URL or post URN');
export const socialReferenceSchema = z.union([postReferenceSchema, z.string().regex(COMMENT_URN)]);
export function canonicalPost(value) {
  const urn = resolvePostReference(value);
  if (!/^urn:li:(share|ugcPost):/.test(urn)) throw new LinkedInInputError('The Posts API requires a share/ugcPost identifier. An activity URL can be used for social actions, but its ID cannot be assumed to be a share ID. Select a post returned by recent posts or the scheduler.');
  return urn;
}
export function commentParts(urn) {
  const parts = urn.match(/^urn:li:comment:\((urn:li:activity:[1-9][0-9]*),([1-9][0-9]*)\)$/);
  if (!parts) throw new LinkedInInputError('Invalid comment identifier; use a comment returned by this agent.');
  return { activityUrn: parts[1], id: parts[2] };
}

export function requestedCommunityScopes(env) {
  const scopes = String(env.LINKEDIN_COMMUNITY_SCOPES || '').split(/[\s,]+/).filter(Boolean);
  if (!scopes.length || scopes.some(scope => !SUPPORTED_SCOPES.includes(scope) || !scope.includes('_organization_'))) throw new LinkedInInputError('Community connection requires explicitly configured, eligible organization scopes.');
  return [...new Set(scopes)];
}
export function communityConfigured(env) {
  if (!env.LINKEDIN_COMMUNITY_CLIENT_ID || !env.LINKEDIN_COMMUNITY_CLIENT_SECRET) return false;
  try { return requestedCommunityScopes(env).length > 0; } catch { return false; }
}
