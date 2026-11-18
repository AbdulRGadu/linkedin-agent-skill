import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { requestedScopes, requestedCommunityScopes, communityConfigured } from '../apps/linkedin/identity.js';
import { createLinkedInClient, introspectLinkedInScopes } from '../apps/linkedin/client.js';
import { getLinkedInConfig, getOwnerLinkedInConfigs, PERSON_URN } from '../apps/linkedin/config.js';
import { registerLinkedInTools } from '../apps/linkedin/tools.js';
import resources from './context.generated.js';
import { createScheduler, registerSchedulerTools, schedulerConfigured, syncSchedulerCredential } from './scheduler.js';

const escape = value => String(value).replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
class SetupFailure extends Error {}
const securityHeaders = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
};
function page(title, content, status = 200, extraHeaders = {}) {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title><style>body{font:18px system-ui;max-width:650px;margin:60px auto;padding:20px;line-height:1.5}input,button{font:inherit;padding:10px;margin:8px 0}input[type=password]{width:90%}</style><h1>' + escape(title) + '</h1>' + content,
    { status, headers: { ...securityHeaders, ...extraHeaders } });
}
export async function matchesOwnerKey(value, expected) {
  if (typeof value !== 'string' || !expected || expected.length < 32 || value.length > 512) return false;
  const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(value), digest(expected)]);
  return a.reduce((diff, byte, index) => diff | (byte ^ b[index]), 0) === 0;
}
async function exchangeToken(code, env, fetchImpl, callback = '/oauth/linkedin/callback') {
  if (typeof code !== 'string' || !code || code.length > 4096) throw new SetupFailure('LinkedIn did not return a valid authorization code. Restart authorization from ChatGPT.');
  const response = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.PUBLIC_ORIGIN + callback, client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }),
  });
  if (!response.ok) {
    let error;
    try { error = (await response.json()).error; } catch { /* Never reflect raw upstream responses. */ }
    const reasons = new Map([
      ['invalid_client', 'LinkedIn rejected the app credentials (invalid_client). The Worker client ID and client secret must belong to the same LinkedIn app.'],
      ['invalid_client_id', 'LinkedIn rejected the app client ID (invalid_client_id). Check the Worker client ID matches your LinkedIn app.'],
      ['invalid_client_secret', 'LinkedIn rejected the app secret (invalid_client_secret). Update the Worker secret from the matching LinkedIn app.'],
      ['invalid_redirect_uri', 'LinkedIn rejected the callback URL during token exchange (invalid_redirect_uri). Verify the exact authorized redirect URL.'],
      ['invalid_grant', 'LinkedIn rejected the authorization code (invalid_grant). It may be expired or already used. Restart from ChatGPT without refreshing the callback page.'],
    ]);
    throw new SetupFailure(reasons.get(error) || 'LinkedIn token exchange failed. Check the matching app credentials and exact redirect URL, then restart authorization.');
  }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new SetupFailure('LinkedIn returned invalid token configuration.');
  return token;
}
export async function exchangeLinkedInCode(code, env, fetchImpl = fetch) {
  const token = await exchangeToken(code, env, fetchImpl);
  const identityResponse = await fetchImpl('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + token.access_token }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (!identityResponse.ok) throw new SetupFailure('LinkedIn profile lookup failed after token exchange. Verify OpenID Connect is enabled and profile is granted, then reauthorize.');
  const identity = await identityResponse.json();
  if (typeof identity.sub !== 'string' || !/^[A-Za-z0-9_-]+$/.test(identity.sub)) throw new SetupFailure('LinkedIn returned invalid member identity.');
  const grantedScopes = await introspectLinkedInScopes(getLinkedInConfig({ ...env, LINKEDIN_ACCESS_TOKEN: token.access_token }), fetchImpl);
  return { grantedScopes, accessToken: token.access_token, personUrn: 'urn:li:person:' + identity.sub, expiresAt: Date.now() + token.expires_in * 1000, owner: true };
}
export async function exchangeCommunityCode(code, env, fetchImpl = fetch) {
  const appEnv = { ...env, LINKEDIN_CLIENT_ID: env.LINKEDIN_COMMUNITY_CLIENT_ID, LINKEDIN_CLIENT_SECRET: env.LINKEDIN_COMMUNITY_CLIENT_SECRET };
  const token = await exchangeToken(code, appEnv, fetchImpl, '/oauth/linkedin/community/callback');
  const config = getLinkedInConfig({ ...appEnv, LINKEDIN_ACCESS_TOKEN: token.access_token });
  const grantedScopes = await introspectLinkedInScopes(config, fetchImpl);
  if (!grantedScopes?.some(scope => ['r_organization_admin', 'rw_organization_admin'].includes(scope))) throw new SetupFailure('Community app has no verified organization discovery permission.');
  // Official roleAssignee finder identifies the member authenticated to THIS app.
  // No OIDC/Share product or cross-app member-ID assumptions are required.
  const response = await fetchImpl('https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=0', {
    headers: { Authorization: 'Bearer ' + token.access_token, 'Linkedin-Version': config.version, 'X-Restli-Protocol-Version': '2.0.0' }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new SetupFailure('Community app organization identity lookup is unavailable.');
  const body = await response.json();
  if (!Array.isArray(body?.elements)) throw new SetupFailure('Community app returned invalid organization identity data.');
  const members = [...new Set(body.elements.filter(row => row.state === 'APPROVED' && PERSON_URN.test(row.roleAssignee)).map(row => row.roleAssignee))];
  if (members.length !== 1) throw new SetupFailure('Community member identity unavailable or ambiguous. Connect an account with an approved managed page.');
  return { accessToken: token.access_token, personUrn: members[0], grantedScopes, expiresAt: Date.now() + token.expires_in * 1000, clientId: env.LINKEDIN_COMMUNITY_CLIENT_ID };
}
async function completeConnection(oauth, upstream, props) {
  const completed = await oauth.completeAuthorization({ request: upstream.request, userId: encodeURIComponent(props.personUrn), metadata: { label: 'Gadu Abdul LinkedIn' }, scope: upstream.request.scope, props });
  upstream.headers.set('Location', completed.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}
function upstreamRedirect(env, upstream, community = false) {
  const target = new URL('https://www.linkedin.com/oauth/v2/authorization');
  target.search = new URLSearchParams({ response_type: 'code', client_id: community ? env.LINKEDIN_COMMUNITY_CLIENT_ID : env.LINKEDIN_CLIENT_ID,
    redirect_uri: env.PUBLIC_ORIGIN + (community ? '/oauth/linkedin/community/callback' : '/oauth/linkedin/callback'),
    scope: (community ? requestedCommunityScopes(env) : requestedScopes(env)).join(' '), state: upstream.state }).toString();
  upstream.headers.set('Location', target.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}
export async function defaultHandler(request, env, ctx, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'linkedin-agent', writesEnabled: env.LINKEDIN_WRITE_ENABLED === 'true' }, { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/') return page('LinkedIn Agent', '<p>Protected MCP endpoint: <code>/mcp</code></p><p>LinkedIn callback: <code>' + escape(env.PUBLIC_ORIGIN) + '/oauth/linkedin/callback</code></p><p>Add the callback in your LinkedIn app. Enable Share on LinkedIn and Sign In with LinkedIn using OpenID Connect. Then connect ChatGPT to this server using OAuth.</p><p>Each write requires explicit approval of the exact action. Your private owner setup key is stored locally in .env.</p>');
  if (!['/authorize', '/oauth/linkedin/callback', '/oauth/linkedin/community/callback'].includes(url.pathname)) return page('Not found', '<p>Unknown route.</p>', 404);
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET || !env.OWNER_SETUP_KEY) return page('Setup incomplete', '<p>The server needs its LinkedIn app credentials and owner setup key.</p>', 503);
  let stage = 'Starting authorization';
  try {
    const oauth = env.OAUTH_PROVIDER;
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      if (auth.scope.some(scope => !['linkedin:actions', 'offline_access'].includes(scope))) return page('Unsupported access', '<p>This client requested unsupported permissions.</p>', 400);
      const consent = await oauth.beginConsent(auth);
      const headers = new Headers(consent.headers);
      for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
      // no-referrer can produce Origin: null on browser form POSTs. Preserve
      // same-origin submissions without disclosing OAuth URLs to other sites.
      headers.set('Referrer-Policy', 'same-origin');
      const communityChoice = communityConfigured(env) ? '<p><label><input type="checkbox" name="connectCommunity" value="true"> Also connect the Community app for managed company pages</label></p><p>The next step authorizes the separate Community app. Use the intended LinkedIn account. Personal actions continue using the first app.</p>' : '<p>Community app connection is unavailable until its credentials and eligible scopes are configured. Personal linking remains available.</p>';
      const content = '<p>Allow <strong>' + escape(details.clientName) + '</strong> to use your LinkedIn action tools?</p><p>Access returns to <strong>' + escape(details.redirectHost) + '</strong>.</p><p>' + (details.clientDomain ? 'Client domain: ' + escape(details.clientDomain) : 'This client name is self-reported.') + '</p><p>Requested access: ' + escape(auth.scope.join(', ')) + '. Actual LinkedIn writes also require your explicit approval and an enabled server write toggle.</p><form method="post"><input type="hidden" name="handle" value="' + escape(consent.handle) + '"><label>Owner setup key <input type="password" name="ownerKey" autocomplete="off" required></label>' + communityChoice + '<p><button name="decision" value="approve">Allow and connect LinkedIn</button> <button name="decision" value="deny" formnovalidate>Deny</button></p></form>';
      return new Response(page('Authorize LinkedIn Agent', content).body, { headers });
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) return page('Request refused', '<p>Invalid request origin.</p>', 403);
      if (Number(request.headers.get('content-length')) > 8192) return page('Request refused', '<p>Request too large.</p>', 413);
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get('decision') !== 'approve' || !await matchesOwnerKey(form.get('ownerKey'), env.OWNER_SETUP_KEY)) return page('Access refused', '<p>Owner setup key is incorrect. Restart authorization from your MCP client.</p>', 403);
      const connectCommunity = form.get('connectCommunity') === 'true';
      if (connectCommunity && !communityConfigured(env)) return page('Community setup incomplete', '<p>Configure the Community app credentials and only its granted scopes. You can reconnect personal LinkedIn without selecting the Community option.</p>', 503);
      const approved = await oauth.approveConsent(request, handle);
      const upstream = await oauth.beginUpstream(approved.request, { data: { owner: true, app: 'personal', connectCommunity }, headers: approved.headers });
      return upstreamRedirect(env, upstream);
    }
    if (['/oauth/linkedin/callback', '/oauth/linkedin/community/callback'].includes(url.pathname) && request.method === 'GET') {
      // Library consumes encrypted state and validates its browser-bound cookie.
      stage = 'Validating browser session';
      const upstream = await oauth.finishUpstream(request);
      if (upstream.data?.owner !== true) return page('Authorization session invalid', '<p>Restart authorization from your MCP client in the same browser.</p>', 400);
      if (url.pathname === '/oauth/linkedin/community/callback') {
        if (upstream.data.app !== 'community' || upstream.data.primary?.owner !== true || !PERSON_URN.test(upstream.data.primary.personUrn) || typeof upstream.data.primary.accessToken !== 'string' || !upstream.data.primary.accessToken || !Number.isFinite(upstream.data.primary.expiresAt) || upstream.data.primary.expiresAt <= Date.now()) throw new SetupFailure('Community authorization session invalid. Restart connection.');
        const props = { ...upstream.data.primary };
        if (url.searchParams.has('error') || !communityConfigured(env)) props.communityProblem = 'community_not_authorized_or_setup_required';
        else {
          try { props.community = await exchangeCommunityCode(url.searchParams.get('code'), env, fetchImpl); }
          catch { props.communityProblem = 'community_grants_or_member_identity_unavailable'; }
        }
        stage = 'Completing ChatGPT authorization';
        return await completeConnection(oauth, upstream, props);
      }
      if (upstream.data.app && upstream.data.app !== 'personal') throw new SetupFailure('Authorization callback does not match the approved application. Restart connection.');
      if (url.searchParams.has('error')) {
        // Display only fixed explanations. Upstream descriptions can contain
        // credentials or attacker-controlled text and must never be reflected.
        const reasons = new Map([
          ['user_cancelled_login', 'LinkedIn sign-in was cancelled. Restart and complete sign-in.'],
          ['user_cancelled_authorize', 'LinkedIn permission approval was cancelled. Restart and approve the requested permissions.'],
          ['access_denied', 'LinkedIn denied permission. Restart and approve consent; if it persists, check the app products and account access.'],
          ['unauthorized_scope_error', 'LinkedIn has not granted a requested scope. In your app Auth tab, verify baseline and configured optional scopes are granted. Remove unapproved optional scopes. Enable Sign In with LinkedIn using OpenID Connect and Share on LinkedIn, then restart authorization.'],
          ['invalid_scope', 'LinkedIn rejected the requested scopes. Verify baseline and configured optional scopes are granted in the app Auth tab, remove unapproved optional scopes, then restart authorization.'],
          ['invalid_redirect_uri', 'LinkedIn rejected the callback URL. Add the exact authorized redirect URL shown below, then restart authorization.'],
          ['invalid_request', 'LinkedIn rejected the authorization request. Check the app client ID, enabled products and exact redirect URL, then restart authorization.'],
          ['unauthorized_client', 'LinkedIn has not authorized this app for this flow. Check the app products and client ID, then restart authorization.'],
          ['server_error', 'LinkedIn encountered a server error. Restart authorization later.'],
          ['temporarily_unavailable', 'LinkedIn authorization is temporarily unavailable. Restart authorization later.'],
        ]);
        const error = url.searchParams.get('error');
        const reason = reasons.get(error) || 'LinkedIn returned an unrecognized authorization error. Check the app products and redirect URL, then restart authorization.';
        return page('LinkedIn authorization refused', '<p>' + reason + '</p>' + (reasons.has(error) ? '<p>Error: <code>' + escape(error) + '</code></p>' : '') + '<p>Required redirect URL: <code>' + escape(env.PUBLIC_ORIGIN) + '/oauth/linkedin/callback</code></p>', 400);
      }
      stage = 'Exchanging LinkedIn code and looking up profile';
      const props = await exchangeLinkedInCode(url.searchParams.get('code'), env, fetchImpl);
      if (upstream.data.connectCommunity && communityConfigured(env)) {
        const next = await oauth.beginUpstream(upstream.request, { data: { owner: true, app: 'community', primary: props }, headers: upstream.headers });
        return upstreamRedirect(env, next, true);
      }
      stage = 'Completing ChatGPT authorization';
      return await completeConnection(oauth, upstream, props);
    }
    return page('Method not allowed', '<p>Unsupported request method.</p>', 405);
  } catch (error) {
    // Never serialize provider errors, authorization codes, tokens, or URLs.
    const advice = error instanceof SetupFailure ? error.message : stage === 'Validating browser session'
      ? 'This authorization session expired, was already used, or was started in another browser. Start again from ChatGPT and finish in the same browser without refreshing the callback.'
      : stage === 'Completing ChatGPT authorization'
        ? 'LinkedIn sign-in and profile lookup succeeded, but the MCP grant could not be created. Restart the ChatGPT connection; report this stage if it repeats.'
        : 'Restart from ChatGPT. Check the app configuration and complete authorization in the same browser.';
    return page('Authorization could not complete', '<p>Step: <strong>' + stage + '</strong></p><p>' + escape(advice) + '</p><p>No credentials were displayed.</p>', 400);
  }
}
export async function mcpHandler(request, env, ctx) {
  if (!ctx.auth?.scope?.includes('linkedin:actions') || ctx.props?.owner !== true) return new Response('Insufficient access', { status: 403 });
  if (!Number.isFinite(ctx.props.expiresAt) || ctx.props.expiresAt <= Date.now()) return new Response('LinkedIn authorization expired; reconnect.', { status: 401 });
  if (request.method !== 'POST') return new Response('POST required', { status: 405, headers: { Allow: 'POST' } });
  const { config, organizationConfig, connections } = getOwnerLinkedInConfigs(env, ctx.props);
  const server = new McpServer({ name: 'linkedin-agent', version: '0.4.0' }, {
    instructions: 'Read original skill and brand resources before drafting. Use Abdul context for personal content. Discover managed organizations and resolve the actor before showing approval. Show the actor name on every consequential action. Never change an approved actor. Check linkedin_capabilities for actual permissions. Names that match multiple pages require clarification. Recent content and comments are paginated; do not claim a globally latest item from an incomplete page. Activity URLs support social actions but are not canonical share IDs for post edits or reads. Ask for explicit approval of exact action/content/target before writes. For scheduling, show every exact text, publishing identity and the daily 8 AM Africa/Lagos FIFO cadence with any earliest eligible date/time, obtain approval of all items, then call the batch scheduler once. Use Africa/Lagos by default for displaying times. Scheduled approval authorizes automatic publication without a second approval. Rescheduling requires approval of the new time for the existing exact content/target. Map voice to brand/abdul/voice.md. Scores are heuristics, never authorship proof.',
  });
  // Any valid owner MCP request can refresh the encrypted scheduler credential
  // after reconnection. A scheduler setup failure must not break existing tools.
  if (schedulerConfigured(env)) await syncSchedulerCredential(env, ctx).catch(() => {});
  registerLinkedInTools(server, createLinkedInClient({ config, organizationConfig, connections, db: env.SCHEDULER_DB, schedulerAvailable: schedulerConfigured(env) }));
  registerSchedulerTools(server, createScheduler({ env, ctx }));
  for (const resource of resources) server.registerResource(resource.name, resource.uri, { mimeType: 'text/markdown' }, async () => ({ contents: [{ uri: resource.uri, mimeType: 'text/markdown', text: resource.text }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // JSON responses are bounded MCP payloads; finish transport after reading.
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  } finally { await server.close(); }
}
