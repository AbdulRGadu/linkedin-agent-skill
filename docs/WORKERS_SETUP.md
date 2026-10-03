# Cloudflare deployment
Live origin: https://linkedin-agent.centrisec.com
LinkedIn redirect: https://linkedin-agent.centrisec.com/oauth/linkedin/callback
ChatGPT/Codex Streamable HTTP MCP: https://linkedin-agent.centrisec.com/mcp

## Custom domain
The Worker uses linkedin-agent.centrisec.com as its canonical OAuth origin. Wrangler manages the custom domain DNS and certificate. The workers.dev endpoint and preview URLs are disabled.

When migrating an existing connection, add the new LinkedIn redirect URL above and recreate the MCP connection using the new URL; restart authorization rather than reusing an authorization page opened on the previous hostname.

## Account setup
1. Add the exact HTTPS redirect in the LinkedIn app Auth tab.
2. Enable Share on LinkedIn and Sign In with LinkedIn using OpenID Connect. Default member consent requests openid profile w_member_social. Do not request feed access without its product approval.
3. Add the MCP URL in your client using OAuth. Client registration and discovery are served by Cloudflare's OAuth provider; PKCE is required.
4. On the authorization page, read the client name, redirect host and requested access. Enter the private OWNER_SETUP_KEY from your ignored local .env and approve only the client you initiated.
5. Complete LinkedIn consent yourself. No username/password is read by this agent. The callback validates the browser-bound state, exchanges the code, and resolves the member via userinfo.

Writes remain disabled in deployment config. Enable them only after account linking and a separate review; approved:true is still required for every action. This pass sends no live LinkedIn requests.

## Deployment/runtime
npm install
npm test
npm run lint
npm run build
npm run deploy
npm run dev:worker runs local Wrangler. Original npm run dev still runs the loopback Node server.
Tests include actual workerd OAuth discovery, registration, consent and protected endpoint checks with local KV and fake app secrets. LinkedIn exchange/identity tests use mocks.

A single Worker adapts the existing action client to the Web Standards MCP transport. Build bundles only the 18 fixed skill/brand documents; no runtime filesystem or arbitrary file access. Source documents remain the single writing-rule source.
OAUTH_KV stores the provider's hashed credentials and encrypted grant props containing the member token and expiry. The library encrypts props with keys derived/wrapped for credential holders. It also binds consent and upstream state to secure HttpOnly browser cookies.
No database, scheduler, dashboard, feed crawling, or other Centrisec service was introduced. Worker name and KV namespace belong only to this deployment.

## Secrets and expiry
LINKEDIN_CLIENT_SECRET and OWNER_SETUP_KEY are Workers secrets. The owner key is random 256-bit data also stored locally in ignored .env; neither it nor the supplied secrets file belongs in Git.
Client ID and fixed deployment origin are public configuration. LinkedIn tokens never leave encrypted grant props in OAuth KV or appear in tool results/logs.
MCP access tokens last at most one hour and cannot outlive the member token. MCP refresh grants expire after 30 days. LinkedIn refresh tokens are not assumed available: member expiry requires reconnecting. Rotate owner setup key to restrict new linking, and revoke existing grants/tokens through the provider when access must end.
Invocation observability is disabled to avoid retaining authorization URL queries. No error dumps include provider code/state/token values.
The provider consent/upstream helpers use KV get/delete with browser-bound encrypted handles; simultaneous replay in the same browser is a documented KV limitation. LinkedIn codes are also one-use. No unauthenticated endpoint can issue owner grants without the owner key and valid browser state.

## Remaining product restrictions
Default authorization covers personal text posts. Current comments/reactions require separately granted w_member_social_feed / Community Management access; those capabilities must not be promised from Share on LinkedIn alone. Requesting additional approved scopes will be a later explicit configuration change.

Sources: [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [official LinkedIn OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [LinkedIn OIDC](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2).
