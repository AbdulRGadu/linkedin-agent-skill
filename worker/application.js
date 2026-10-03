import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createLinkedInClient } from '../apps/linkedin/client.js';
import { getLinkedInConfig } from '../apps/linkedin/config.js';
import { registerLinkedInTools } from '../apps/linkedin/tools.js';
import resources from './context.generated.js';

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
export async function exchangeLinkedInCode(code, env, fetchImpl = fetch) {
  if (typeof code !== 'string' || !code || code.length > 4096) throw new SetupFailure('LinkedIn did not return a valid authorization code. Restart authorization from ChatGPT.');
  const response = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.PUBLIC_ORIGIN + '/oauth/linkedin/callback', client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }),
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
  const identityResponse = await fetchImpl('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + token.access_token }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (!identityResponse.ok) throw new SetupFailure('LinkedIn profile lookup failed after token exchange. Verify OpenID Connect is enabled and profile is granted, then reauthorize.');
  const identity = await identityResponse.json();
  if (typeof identity.sub !== 'string' || !/^[A-Za-z0-9_-]+$/.test(identity.sub)) throw new SetupFailure('LinkedIn returned invalid member identity.');
  return { accessToken: token.access_token, personUrn: 'urn:li:person:' + identity.sub, expiresAt: Date.now() + token.expires_in * 1000, owner: true };
}
export async function defaultHandler(request, env, ctx, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'linkedin-agent', writesEnabled: env.LINKEDIN_WRITE_ENABLED === 'true' }, { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/') return page('LinkedIn Agent', '<p>Protected MCP endpoint: <code>/mcp</code></p><p>LinkedIn callback: <code>' + escape(env.PUBLIC_ORIGIN) + '/oauth/linkedin/callback</code></p><p>Add the callback in your LinkedIn app. Enable Share on LinkedIn and Sign In with LinkedIn using OpenID Connect. Then connect ChatGPT to this server using OAuth.</p><p>Each write requires explicit approval of the exact action. Your private owner setup key is stored locally in .env.</p>');
  if (!['/authorize', '/oauth/linkedin/callback'].includes(url.pathname)) return page('Not found', '<p>Unknown route.</p>', 404);
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
      const content = '<p>Allow <strong>' + escape(details.clientName) + '</strong> to use your LinkedIn action tools?</p><p>Access returns to <strong>' + escape(details.redirectHost) + '</strong>.</p><p>' + (details.clientDomain ? 'Client domain: ' + escape(details.clientDomain) : 'This client name is self-reported.') + '</p><p>Requested access: ' + escape(auth.scope.join(', ')) + '. Actual LinkedIn writes also require your explicit approval and an enabled server write toggle.</p><form method="post"><input type="hidden" name="handle" value="' + escape(consent.handle) + '"><label>Owner setup key <input type="password" name="ownerKey" autocomplete="off" required></label><p><button name="decision" value="approve">Allow and connect LinkedIn</button> <button name="decision" value="deny" formnovalidate>Deny</button></p></form>';
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
      const approved = await oauth.approveConsent(request, handle);
      const upstream = await oauth.beginUpstream(approved.request, { data: { owner: true }, headers: approved.headers });
      const target = new URL('https://www.linkedin.com/oauth/v2/authorization');
      target.search = new URLSearchParams({ response_type: 'code', client_id: env.LINKEDIN_CLIENT_ID, redirect_uri: env.PUBLIC_ORIGIN + '/oauth/linkedin/callback', scope: 'openid profile w_member_social', state: upstream.state }).toString();
      upstream.headers.set('Location', target.toString());
      return new Response(null, { status: 302, headers: upstream.headers });
    }
    if (url.pathname === '/oauth/linkedin/callback' && request.method === 'GET') {
      // Library consumes encrypted state and validates its browser-bound cookie.
      stage = 'Validating browser session';
      const upstream = await oauth.finishUpstream(request);
      if (upstream.data?.owner !== true) return page('Authorization session invalid', '<p>Restart authorization from your MCP client in the same browser.</p>', 400);
      if (url.searchParams.has('error')) {
        // Display only fixed explanations. Upstream descriptions can contain
        // credentials or attacker-controlled text and must never be reflected.
        const reasons = new Map([
          ['user_cancelled_login', 'LinkedIn sign-in was cancelled. Restart and complete sign-in.'],
          ['user_cancelled_authorize', 'LinkedIn permission approval was cancelled. Restart and approve the requested permissions.'],
          ['access_denied', 'LinkedIn denied permission. Restart and approve consent; if it persists, check the app products and account access.'],
          ['unauthorized_scope_error', 'LinkedIn has not granted a requested scope. In your app Auth tab, verify openid, profile and w_member_social are listed. Enable Sign In with LinkedIn using OpenID Connect and Share on LinkedIn, then restart authorization.'],
          ['invalid_scope', 'LinkedIn rejected the requested scopes. Verify openid, profile and w_member_social are listed in the app Auth tab, then restart authorization.'],
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
      stage = 'Completing ChatGPT authorization';
      const completed = await oauth.completeAuthorization({ request: upstream.request, userId: encodeURIComponent(props.personUrn), metadata: { label: 'Gadu Abdul LinkedIn' }, scope: upstream.request.scope, props });
      upstream.headers.set('Location', completed.redirectTo);
      return new Response(null, { status: 302, headers: upstream.headers });
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
  const config = getLinkedInConfig({ ...env, LINKEDIN_ACCESS_TOKEN: ctx.props.accessToken, LINKEDIN_PERSON_URN: ctx.props.personUrn });
  const server = new McpServer({ name: 'linkedin-agent', version: '0.3.0' }, {
    instructions: 'Read original skill and brand resources before drafting. Use Abdul context. Ask for explicit approval of exact action/content/target before writes. Map voice to brand/abdul/voice.md. Scores are heuristics, never authorship proof.',
  });
  registerLinkedInTools(server, createLinkedInClient({ config }));
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
