# Local V1 architecture

## Cloudflare extension

The original local foundation below is preserved. worker/index.js now serves a protected remote MCP endpoint through Cloudflare's OAuth provider; worker/application.js owns consent, official member OAuth and the Web Standards transport. The build bundles fixed context documents from their original paths. See WORKERS_SETUP.md for live URLs, owner linking and encrypted grant storage. Public connectivity and account-linking routes are implemented; LinkedIn features remain limited by the connected token’s actual grants.

## Approved scheduling on Cloudflare

The protected Worker adds six scheduling tools in `worker/scheduler.js`. The local Node server exposes the shared social/read tools; scheduling stays in the Worker. ChatGPT displays exact text, the approved actor name/URN and the daily 8 AM Africa/Lagos FIFO cadence, including any earliest eligible time, obtains one explicit batch approval, and submits the full batch once. A persisted approval authorizes publication when the item reaches the head of the eligible queue without further ChatGPT interaction. Rescheduling is a separate approved action; content and target cannot be edited.

D1 binding `SCHEDULER_DB` holds scheduled posts, idempotency keys, encrypted member credentials and cron health. Each post retains exact text, person/organization target and owning member, optional earliest UTC instant, queue position, approval timestamp/originating grant, state, attempt metadata and LinkedIn ID. Original idempotency keys remain reserved after cancellation and rescheduling. Equivalent UTC instants deduplicate; text is never trimmed or rewritten. Batches validate every item before a transactional D1 insert; concurrent requests rely on database uniqueness.

Verified owner MCP requests copy the existing LinkedIn token into an AES-GCM encrypted D1 credential using the Workers secret `SCHEDULER_ENCRYPTION_KEY`, random IV and member URN as authenticated data. Token-holder grant props remain encrypted in OAuth KV as before. D1 contains no plaintext LinkedIn/MCP token, owner key or OAuth code. Repeated requests from the same grant do not overwrite credentials or clear an invalid-token flag. Reconnection supplies a fresh same-member credential/grant; different profiles never take over existing schedules. Before publishing, cron verifies the current credential's grant remains active through the OAuth provider helpers. Provider revocation inherits KV's eventual consistency; it is not an instantaneous global kill switch. The Workers write toggle also gates cron.

The Worker runs at 08:00 Africa/Lagos and checks every 15 minutes through 23:45. A conditional D1 update claims the oldest eligible post and its Lagos calendar day in one operation. Unique indexes protect the day and the in-flight claim across Worker invocations. Published records store the validated LinkedIn ID. Cancellation/rescheduling cannot modify a claimed post. Stale claims after five minutes become `needs_review`, never automatically reclaimed.

Expired/missing/invalid credentials, revoked grants, disabled writes and unavailable encryption block and retain records. Reversible blocks recover when the underlying issue clears, regardless of the original time. HTTP 401 marks the stored credential invalid until fresh connection credentials arrive; HTTP 429 retries with exponential backoff. Other definite HTTP 4xx rejections become `failed`. Network errors, timeouts, redirects, HTTP 5xx, unreadable successes and missing valid IDs become `needs_review`. Uncertain attempts reserve the Lagos day and require review before any replacement is approved. Scheduler status exposes health, counts and fixed reason codes; it contacts no LinkedIn endpoint.

There is no transaction across D1 and LinkedIn. If publication succeeds but saving the ID fails, the claim remains and becomes `needs_review`. This conservative approach may skip a post after a crash before transmission. Verify uncertain posts manually on LinkedIn before approving any replacement. No feed scraping or automated reconciliation is implemented.
## Flow
User → ChatGPT → original content skills + Abdul context → MCP → approval gates → LinkedIn client → official LinkedIn API.
Codex builds and tests the agent. ChatGPT is the intended everyday interface after protected remote integration.

## Implementation
Node 22.13+ ESM JavaScript with supported MCP SDK v1 (installed version pinned by package-lock.json). JavaScript avoids a compilation layer; Zod validates runtime inputs.
server/index.js serves stateless Streamable HTTP POST /mcp and GET /health on 127.0.0.1. Each request owns a server/transport, closed with the response. GET/DELETE MCP methods return 405 because sessions and standalone SSE streams are not used.
The shared client exposes 21 fixed tools for capabilities, identity discovery/resolution, known-content reads and approved social actions. The Worker adds six scheduling tools. No unrestricted request tool.
Fixed MCP resources expose the original 11 skill documents and seven brand documents without duplicating writing rules. A client without resource support must receive these files as explicit context; adding an MCP endpoint alone does not inject writing instructions.

## Safety
Every write reaches assertWriteAllowed in the client: writeEnabled must be true AND approved must be boolean true. Missing credentials/invalid input fail before network access.
Approval is a caller assertion, not cryptographic proof that a human clicked approve. Clients must solicit approval of the exact content/target/action. This local server has no user identity or production authorization service.
Fixed api.linkedin.com origin, rejected redirects, 15-second timeout, no automatic retries. No upstream body, statusText, network cause, or token is logged or returned. Read results project documented content/identity fields; write results expose validated identifiers/status. Unexpected storage errors are redacted.
Host and Origin validation plus loopback binding reduce local exposure. Before public connectivity, implement MCP-compatible authentication and HTTPS; do not publish this local endpoint unchanged.

## Skill compatibility
Original skills remain byte-for-byte intact. Standalone Claude use keeps ~/.claude/linkedin paths.
For this agent, AGENTS.md overrides context selection: voice.md → brand/abdul/voice.md; plan.md → storage/plans/plan.md; log.md → storage/logs/log.md. Original rules remain authoritative for content, while their manual-paste output can be followed by a separate explicitly approved API action.
These mappings are host instructions, not a filesystem alias or automatic server write. The server does not generate drafts or persist plans/logs.
li-human uses its original Python scripts and lexicon; scores are local heuristics, not authorship or detection guarantees.

## OAuth boundaries
LinkedIn OAuth and MCP client authentication are separate trust boundaries. The local server accepts a member token through its environment; the Worker uses owner-only OAuth consent and encrypted grant props.
See apps/linkedin/auth/README.md for the deferred authorization design.

## Multiple LinkedIn identities

`apps/linkedin/identity.js` validates personal/managed-page selectors and parses embedded LinkedIn URL identifiers without network fetching. The existing client resolves exact page names or vanity names through paginated approved member ACLs and organization lookup. Duplicate names require clarification; conflicting name/URN pairs are rejected. No company is hard-coded. Logo metadata is a LinkedIn asset URN when available, not a fabricated image URL.

Organization actions require verified scope evidence, approved membership, a current `organizationAuthorizations` check for the action and any documented endpoint role restrictions. Permission checks are repeated during cron before claiming an organization post. A permission failure blocks and retains it. Posts keep immutable actor type/URN/name separately from `owner_urn`; listing, cancellation, credentials and rescheduling stay scoped to that owner. Dedupe includes actor and, for organization posts, owning member. Old personal keys remain compatible.

OAuth requests the original baseline plus explicitly configured eligible optional scopes. Official token introspection stores verified scope names in encrypted OAuth grant props and a non-secret D1 column. Unknown grants cannot enable new social/read/organization capabilities. Legacy personal posting remains usable; capabilities mark unverified grants conservatively. Reconnect after configuring additional scopes. Introspection does not supply automatic token refresh.

The existing D1 database also stores creation ownership records in `linkedin_objects`. Edits/deletes require an actor-matching creation record, a published scheduler record or an authorized API ownership read. There is no arbitrary delete-by-ID bypass. If storing ownership fails after a successful write, the result is uncertain: verify before retrying. Older content without a record needs the appropriate read scope.

Recent Posts API results are ordered by last modification, not necessarily creation. Comments/replies and posts expose pagination; latest/unanswered claims are qualified when incomplete. Feed activity URLs can address social actions; activity IDs are never assumed equal to share/ugcPost IDs required by the Posts API. Unknown shortened URLs require a known API identifier. All reads use official endpoints; no scraping or public-feed crawling.

## Two LinkedIn apps

The existing OAuth flow optionally chains a second upstream authorization after personal linking. Both steps use the provider's encrypted, browser-bound state helpers. The second callback uses only the Community client credentials/scopes, verifies token grants, and obtains its own app-scoped member identity from the official authenticated organization ACL finder. Failure or denial preserves personal connection completion. An unchecked Community option stores no secondary credential.

One MCP grant owns both credentials; its identity remains the primary person. The shared client optionally delegates organization operations to another instance of the same client using the secondary token/member URN. Personal operations remain on the primary instance. Ownership records still use the primary owner, independent of the app-scoped authorization member. With a configured second app, unavailable secondary credentials never fall back to the primary app for page writes.

Migration 0003 adds encrypted Community credential, expiry, scopes, app/member IDs and an independent invalid flag to the existing D1 row. Scheduler approval records retain their actor and owner. Cron selects credentials by actor type and repeats permissions/grant checks. App-specific encryption authenticated data prevents swapping primary and Community ciphertext. No Queue, service or second publisher is added. An invalid secondary credential does not invalidate the primary one.
