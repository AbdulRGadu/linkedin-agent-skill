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

Writes are enabled in the deployed Worker following owner authorization and account linking. approved:true is still required for every exact action; enabling the toggle does not publish any content. New installations retain the disabled default in .env.example. Deployment checks do not send live LinkedIn requests.

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
Scheduling adds one D1 database and a one-minute Cron Trigger to this same Worker. No Queue, dashboard, feed crawling or other Centrisec service is needed. The loopback Node server stays unchanged.

## Secrets and expiry
LINKEDIN_CLIENT_SECRET and OWNER_SETUP_KEY are Workers secrets. The owner key is random 256-bit data also stored locally in ignored .env; neither it nor the supplied secrets file belongs in Git.
Client ID and fixed deployment origin are public configuration. LinkedIn tokens remain encrypted in OAuth KV grant props and are copied only from verified owner MCP context into AES-GCM encrypted D1 credentials for cron. They never appear in tool results/logs. The dedicated SCHEDULER_ENCRYPTION_KEY is a Workers secret, never a public variable.
MCP access tokens last at most one hour and cannot outlive the member token. MCP refresh grants expire after 30 days. LinkedIn refresh tokens are not assumed available: member expiry requires reconnecting. Rotate owner setup key to restrict new linking, and revoke existing grants/tokens through the provider when access must end.
Invocation observability is disabled to avoid retaining authorization URL queries. No error dumps include provider code/state/token values.

## Scheduler setup

Database `centrisec-linkedin-scheduler` was created in account `c042400a63d2d3d81042613f4abef9c1`, with ID `108b1544-073f-4f27-b082-f170b68e95e3`. The D1 binding and UTC cron expression are in `wrangler.jsonc`. The first tick runs at 08:00 Africa/Lagos. The same trigger checks every 15 minutes through 23:45 for recovery, using the same queue and daily limit.

Live verification passed: health reports `ok`, OAuth discovery uses the canonical origin, and unauthenticated MCP requests return 401. D1 recorded a successful cron completion at `2026-10-04 20:34:00 UTC` with no problem. The schedule database was empty; no LinkedIn post was created during deployment verification.

A random 256-bit encryption key is preserved locally in ignored `.wrangler/scheduler-secrets.json` and uploaded as a Workers secret. Keep this file private and preserve the key. Deployment commands (already run for this installation):

```powershell
npx wrangler secret bulk .wrangler/scheduler-secrets.json
npm run deploy
```

Uploading secrets can create a new deployment of the existing Worker. The subsequent deployment activates the new code, D1 binding and cron. To set a key interactively on a new installation instead, use `npx wrangler secret put SCHEDULER_ENCRYPTION_KEY` and supply 64 cryptographically random hexadecimal characters. Do not pass key values as command arguments or commit the secret file. Do not regenerate/overwrite a key that already encrypts live credentials. Replacing a key requires same-member reconnection with a fresh grant for every stored credential; pending posts remain and may miss their approved times.

For another account/install, create and migrate the database first (record the actual returned ID in its configuration):

```powershell
npx wrangler d1 create centrisec-linkedin-scheduler
npx wrangler d1 migrations apply centrisec-linkedin-scheduler --remote
```

For local Worker development, supply a separate test-only `SCHEDULER_ENCRYPTION_KEY` in ignored `.dev.vars` and apply local migrations:

```powershell
npx wrangler d1 migrations apply centrisec-linkedin-scheduler --local
npm run dev:worker -- --test-scheduled
```

Never enable live publishing credentials in local automated tests. `npm test` uses isolated Miniflare D1/KV, fake credentials and intercepted outbound requests; it exercises real OAuth, MCP batch scheduling and the native scheduled handler without LinkedIn access. Scheduler unit tests also verify concurrency, deduplication, cancellation, expiry and uncertain outcomes.

## Verify after deployment

1. Refresh/reconnect the existing ChatGPT MCP connector if its tool list is cached; confirm all 27 tools appear.
2. Ask ChatGPT for `linkedin_scheduler_status`: configured should be true and the returned personal target should match your account. A valid authenticated request seeds encrypted credentials from your existing OAuth grant.
3. During the publishing window, wait for a configured cron tick and check status again: `lastRunAt` and `lastCompletedAt` should advance. Configuration presence alone does not prove the deployed cron is firing.
4. Approve an exact personal post for a future date, schedule it, confirm it in the list, and cancel it to verify storage/cancellation without publishing. Verify a `published` ID only with a separately approved real post when you want one.
5. Disable overlapping ChatGPT scheduled LinkedIn tasks before approving live schedules.

Pending blocks are visible in the listing and scheduler status. Reconnect for expired/invalid auth, then invoke status; eligible posts can recover at a subsequent tick. There is no lateness cutoff. HTTP 429 responses are retried with backoff. Uncertain results stop at `needs_review`; check LinkedIn manually before creating a replacement. No proactive notification channel, automatic token refresh or exactly-once external API guarantee is provided.
The provider consent/upstream helpers use KV get/delete with browser-bound encrypted handles; simultaneous replay in the same browser is a documented KV limitation. LinkedIn codes are also one-use. No unauthenticated endpoint can issue owner grants without the owner key and valid browser state.

## Remaining product restrictions
Default authorization covers personal text posts. Current comments/reactions require separately granted w_member_social_feed / Community Management access; those capabilities must not be promised from Share on LinkedIn alone. Additional scopes are opt-in configuration, constrained to implemented scopes and verified by token introspection.

Sources: [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [official LinkedIn OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [LinkedIn OIDC](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2).

## Deploy the identity extension

This extension was deployed on 2026-10-06 to the existing Centrisec account. Worker version: `a54cb454-0caa-4374-ab95-c52983170d68`. Migration `0002_identities.sql` was applied remotely; the schedule database was empty. Health and OAuth discovery passed; unauthenticated MCP requests correctly returned 401. The new deployment recorded a successful cron completion at `2026-10-06 20:53:54 UTC` with no problem; D1 foreign-key validation passed. No real LinkedIn action was made during verification. The optional scope setting remains empty pending app eligibility confirmation. No new service, database, Queue or secret is required. Migration `0002_identities.sql` extends the existing D1 database and preserves personal schedules, encrypted credentials and historical dedupe reservations. Do not rotate the encryption key. Apply migrations before deploying the matching Worker.

1. Confirm scopes in the LinkedIn app Auth tab and its enabled products. Baseline `openid profile w_member_social` stays unchanged. Add only actually granted scopes to `LINKEDIN_OPTIONAL_SCOPES` inside `vars` in `wrangler.jsonc` (space-separated). Leave empty when unsure; requesting an unapproved scope can break consent.
2. Validate, migrate and deploy:

```powershell
npm test
npm run lint
npm run build
npx wrangler d1 migrations apply centrisec-linkedin-scheduler --remote
npm run deploy
```

3. Reconnect LinkedIn through the existing ChatGPT MCP OAuth flow. This authenticates again and verifies grants; refreshing the tool list alone grants no new permissions. A same-member request refreshes encrypted scheduler credentials from the new grant.
4. Call `linkedin_capabilities`, `linkedin_list_managed_organizations` and `linkedin_scheduler_status`. Check returned grants, actor names and cron health. Approve a future test schedule, list it and cancel it to verify storage without publishing. Real publication requires its own exact approval.
5. Disable overlapping ChatGPT scheduled LinkedIn tasks to avoid duplicates.

### LinkedIn permission audit

| Capability | Official scope/access | Implementation |
| --- | --- | --- |
| Personal text/link posts, own post management, scheduling | `w_member_social` via Share on LinkedIn; management also needs ownership proof | Ready |
| Personal comments/replies/reactions and edit/delete | `w_member_social_feed`, eligible Community Management access | Ready with verified grants |
| Personal recent posts / comments and engagement reads | `r_member_social` / `r_member_social_feed`; restricted approvals apply | Ready with verified grants |
| Managed-page discovery / action authorization | `r_organization_admin` or `rw_organization_admin` for discovery; this implementation uses `rw_organization_admin` for per-action checks | Ready with verified grants |
| Page publishing and scheduling / social writes / reads | `w_organization_social`; `w_organization_social_feed`; `r_organization_social` / `r_organization_social_feed`, plus current authorization and endpoint roles | Ready with verified grants |
| Messages / invitations | Separate approved-partner Communications API agreement | Unavailable; no execution tool |
| Upload media / follow / broader feed | Upload handling is deferred; no follow/general-feed integration | Deferred / unavailable |

The repo proves the requested baseline, not app product approvals. Confirm eligibility in the app Auth tab and actual grants through introspection. Community Management access is separate from requesting a scope. `w_member_social` alone does not grant current social-feed endpoints. LinkedIn may reject individual targets, rate-limit calls or revoke page permissions; capability checks cannot guarantee every request succeeds.

Official references: [Posts](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09), [Comments](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api?view=li-lms-2026-09), [Reactions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api?view=li-lms-2026-09), [organization ACLs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-09), [lookup](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api?view=li-lms-2026-09), [authorizations](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-authorizations/organization-authorizations?view=li-lms-2026-09), [social metadata](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-metadata-api?view=li-lms-2026-09), [introspection](https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection), [Messages](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages), [Invitations](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/invitations).

## Separate Community Management app (implemented, not deployed)

The personal app remains configured by `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` and optional personal scopes. The second app, `centrisec-community-api-app`, can contain only the Community Management API product. It does not need OpenID Connect or Share on LinkedIn because it is used for managed organization actions. Its access is currently awaiting review; keep the Community settings empty until LinkedIn grants eligible organization scopes. Adding a product request is not approval.

Configuration after approval:

1. In the Community app Auth tab, add this exact redirect URL: `https://linkedin-agent.centrisec.com/oauth/linkedin/community/callback`. Keep the original app's redirect URL unchanged.
2. Set `LINKEDIN_COMMUNITY_CLIENT_ID` in `wrangler.jsonc` to the new app's public client ID. Set `LINKEDIN_COMMUNITY_SCOPES` to only its actually granted organization scopes. Managed-page action checks need `rw_organization_admin`; posts/schedules need `w_organization_social`; social writes need `w_organization_social_feed`; reads need their corresponding read scopes. Do not add `openid`, `profile` or personal write scopes to this second connection.
3. Apply the new migration, store the new app secret through Wrangler's private prompt, and deploy. Never paste the secret into chat or replace the personal app secret:

```powershell
npx wrangler d1 migrations apply centrisec-linkedin-scheduler --remote
npx wrangler secret put LINKEDIN_COMMUNITY_CLIENT_SECRET
npm run deploy
```

Migration `0003_community_app.sql` extends the existing encrypted scheduler credential row. No new Cloudflare resource or encryption key is needed. `secret put` can create a new deployment of existing code; applying the migration first preserves compatibility. The new Worker code must then be deployed before the second callback works.

4. Reconnect ChatGPT to the same `/mcp` URL. Enter the owner key and select **Also connect the Community app for managed company pages**. Authorize the personal app first, then the Community app. Finish both redirects in the same browser. If the second app is denied or its permissions cannot be verified, ChatGPT still receives a working personal connection and a fixed Community problem code.
5. Ask for capabilities, managed pages and scheduler status. Confirm the Community connection is connected, names resolve and only verified page capabilities are true. Approve a future page schedule, list it and cancel it to verify safely. Disable overlapping ChatGPT schedules before live publication.

LinkedIn member IDs are app-specific: the Community token uses its own member URN obtained from the official authenticated `organizationAcls?q=roleAssignee` finder. It is never assigned the personal app's member URN. An absent or ambiguous member identity cannot activate the connection; use a member with an approved managed page. The owner key explicitly authorizes linking these accounts; the server cannot prove the two app-scoped IDs represent the same human. Use the intended LinkedIn account for both authorization steps.

Personal actions, including personal comments/reactions/reads, still use the primary app and its actual permissions. Secondary-app scopes are not merged into primary capabilities. This avoids silently changing the personal actor under an existing approval. If personal feed permissions are missing on the primary app, those personal features remain unavailable even when page features are active on the Community app.

Both app tokens remain encrypted in OAuth grant props. The temporarily staged personal token between authorization steps is encrypted in the provider's short-lived browser-bound transaction, never placed in redirect URLs or plaintext KV. For cron, the Community token is AES-GCM encrypted with owner/app-specific authenticated data. An expired/invalid Community token blocks page schedules without invalidating personal credentials. Page permissions and owner-grant revocation are checked before publishing; uncertain publish outcomes still stop for review. Personal MCP access still requires a current primary connection; reconnect it if it expires.
