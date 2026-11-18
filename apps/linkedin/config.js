export const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]+$/;
export const POST_URN = /^urn:li:(?:share|ugcPost|activity):[1-9][0-9]*$/;
export const COMMENT_URN = /^urn:li:comment:\(urn:li:activity:[1-9][0-9]*,[1-9][0-9]*\)$/;
export function getLinkedInConfig(env = process.env) {
  return { accessToken: env.LINKEDIN_ACCESS_TOKEN || '', personUrn: env.LINKEDIN_PERSON_URN || '',
    version: env.LINKEDIN_VERSION || '202609', writeEnabled: env.LINKEDIN_WRITE_ENABLED === 'true',
    clientId: env.LINKEDIN_CLIENT_ID || '', clientSecret: env.LINKEDIN_CLIENT_SECRET || '',
    grantedScopes: Array.isArray(env.LINKEDIN_GRANTED_SCOPES) ? env.LINKEDIN_GRANTED_SCOPES : null };
}
export function configurationIssues(config) {
  const issues = [];
  if (!config.accessToken.trim()) issues.push('Missing LINKEDIN_ACCESS_TOKEN');
  if (!config.personUrn) issues.push('Missing LINKEDIN_PERSON_URN');
  else if (!PERSON_URN.test(config.personUrn)) issues.push('Invalid LINKEDIN_PERSON_URN: personal member URN required');
  if (!/^20[0-9]{2}(0[1-9]|1[0-2])$/.test(config.version)) issues.push('Invalid LINKEDIN_VERSION: YYYYMM required');
  return issues;
}
export function assertWriteAllowed(config, approved) {
  if (config.writeEnabled !== true) throw new Error('LinkedIn writes are disabled (LINKEDIN_WRITE_ENABLED must be true).');
  if (approved !== true) throw new Error('Explicit approval of the exact action is required (approved must be true).');
  const issues = configurationIssues(config);
  if (issues.length) throw new Error(issues.join('; '));
}

// Secondary app IDs are app-scoped; never substitute the primary person's URN.
export function getOwnerLinkedInConfigs(env, props, now = Date.now()) {
  const config = getLinkedInConfig({ ...env, LINKEDIN_ACCESS_TOKEN: props.accessToken, LINKEDIN_PERSON_URN: props.personUrn, LINKEDIN_GRANTED_SCOPES: props.grantedScopes });
  const c = props.community;
  const secondary = Boolean(env.LINKEDIN_COMMUNITY_CLIENT_ID);
  const current = secondary && c?.clientId === env.LINKEDIN_COMMUNITY_CLIENT_ID && typeof c.accessToken === 'string' && c.accessToken.length > 0 && PERSON_URN.test(c.personUrn) && Array.isArray(c.grantedScopes) && Number.isFinite(c.expiresAt) && c.expiresAt > now;
  const organizationConfig = secondary ? getLinkedInConfig({ ...env, LINKEDIN_CLIENT_ID: env.LINKEDIN_COMMUNITY_CLIENT_ID, LINKEDIN_CLIENT_SECRET: env.LINKEDIN_COMMUNITY_CLIENT_SECRET,
    LINKEDIN_ACCESS_TOKEN: current ? c.accessToken : '', LINKEDIN_PERSON_URN: current ? c.personUrn : '', LINKEDIN_GRANTED_SCOPES: current ? c.grantedScopes : [] }) : undefined;
  const connections = { personal: { connected: props.expiresAt > now, expiresAt: Number.isFinite(props.expiresAt) ? new Date(props.expiresAt).toISOString() : null },
    community: { configured: secondary, connected: Boolean(current), expiresAt: Number.isFinite(c?.expiresAt) ? new Date(c.expiresAt).toISOString() : null,
      reason: current ? null : props.communityProblem || (secondary ? 'community_reconnection_or_setup_required' : 'community_app_not_configured'), personalActionsUse: 'primary_app' } };
  return { config, organizationConfig, connections };
}
