export const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]+$/;
export const POST_URN = /^urn:li:(?:share|ugcPost|activity):[1-9][0-9]*$/;
export const COMMENT_URN = /^urn:li:comment:\(urn:li:activity:[1-9][0-9]*,[1-9][0-9]*\)$/;
export function getLinkedInConfig(env = process.env) {
  return { accessToken: env.LINKEDIN_ACCESS_TOKEN || '', personUrn: env.LINKEDIN_PERSON_URN || '',
    version: env.LINKEDIN_VERSION || '202609', writeEnabled: env.LINKEDIN_WRITE_ENABLED === 'true' };
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
