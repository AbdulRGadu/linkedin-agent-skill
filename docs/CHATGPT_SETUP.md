# Local setup and eventual ChatGPT connection

For the deployed protected endpoint and exact HTTPS LinkedIn callback, follow [Workers setup](WORKERS_SETUP.md). The local-only instructions below describe the original foundation; do not expose the Node server publicly.

## Scheduled personal posts (Cloudflare Worker)

After scheduler deployment, use the existing OAuth MCP connection at `https://linkedin-agent.centrisec.com/mcp`. Refresh the connector's tool list if needed. Ask:

> Prepare seven posts for Monday–Sunday at 8 AM Africa/Lagos. Show the exact posts, dates, times and my connected personal target for approval.

1. ChatGPT reads original skills and brand resources, drafts and humanizes the seven posts, and uses `linkedin_scheduler_status` to identify the connected personal `targetUrn`.
2. ChatGPT displays all seven exact texts, personal target and unambiguous calendar dates/times. Africa/Lagos uses `+01:00`; 8 AM is 07:00 UTC. A request to draft or plan does not approve scheduling.
3. You reply, for example: “I approve all seven exact posts above for my connected personal profile at the displayed dates and 8 AM Africa/Lagos. Schedule all seven.”
4. ChatGPT calls `linkedin_schedule_text_posts` once with `approved: true` and seven `{ text, targetUrn, scheduledAt }` items. Timestamps must include an explicit UTC offset, such as `2026-10-05T08:00:00+01:00`. Approval must refer to the complete displayed batch.
5. ChatGPT returns the stored IDs, dates/times and statuses, including any returned existing record. Cloudflare publishes without another daily ChatGPT approval. Check the credential expiry warning if it may expire before a planned post.

You can also say: “Schedule these seven approved posts for Monday–Sunday at 8 AM Africa/Lagos,” provided the exact texts, target and specific dates are already shown and approved. Relative day names must first be resolved to dates.

| Tool | Input / use |
| --- | --- |
| `linkedin_schedule_text_post` | `text`, actor or `targetUrn`, optional `scheduledAt`, `approved: true` |
| `linkedin_schedule_text_posts` | `posts` (1–50 exact items), `approved: true`; atomic batch |
| `linkedin_list_scheduled_posts` | Optional `status`, `limit` (default 50, max 100), `offset`; returns `nextOffset` |
| `linkedin_cancel_scheduled_post` | `scheduleId`, `approved: true`; pending/blocked/failed records only |
| `linkedin_reschedule_scheduled_post` | `scheduleId`, new `scheduledAt`, `approved: true`; scheduled/blocked records only |
| `linkedin_scheduler_status` | `{}`; target, health, counts, blocking reasons and reconnection status |

For rescheduling, list the record and approve its exact existing text, personal target and new date/time. Text and target cannot change. Cancellation cannot stop an already publishing request or remove a published LinkedIn post. Cancellation remains available when the write toggle is disabled.

The queue publishes at most one eligible post per Africa/Lagos day, starting at 8:00 AM. A fallback checks every 15 minutes through 11:45 PM. Older approvals stay eligible, and an optional timestamp sets the earliest publish time. Expired LinkedIn auth preserves the schedule: reconnect through the existing OAuth flow, then make an authenticated MCP request (for example scheduler status) to save fresh encrypted credentials. Reconnecting another profile does not recover your original profile's schedules. No LinkedIn refresh token is assumed available.

`failed` and `needs_review` are never retried automatically. If the outcome is uncertain, inspect LinkedIn yourself before approving a new replacement schedule; these records cannot be rescheduled by the tool. Retrying an identical schedule returns the existing record, even after cancellation, publishing or a previous reschedule—it does not reactivate it.

**Once the scheduler is live, disable overlapping ChatGPT scheduled LinkedIn tasks to avoid duplicate posts.**
## Local foundation — no credentials needed
Use Node 22.13+:
1. npm install
2. npm test
3. npm run lint
4. npm run dev
GET http://127.0.0.1:8787/health should return status ok. MCP endpoint: http://127.0.0.1:8787/mcp.
The SDK client smoke test in npm test performs initialize, tools/list, resources/list/read, and tool calls over HTTP without contacting LinkedIn.
Connection status reports local configuration only; it does not establish token validity or product access.
Optional local .env is loaded by npm start/dev. Copy .env.example later; keep writes disabled until account access has been verified.

## LinkedIn access — verified 2026-10-01
Personal publishing: enable the Share on LinkedIn product to obtain w_member_social, then obtain member consent through official OAuth. A blanket claim that all personal publishing requires a partner-only app is incorrect.
[Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) documents the product; its legacy ugcPosts sample is not the endpoint used here.
[Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09): POST /rest/posts, authenticated member author urn:li:person:{id}, Authorization Bearer token, Linkedin-Version YYYYMM, X-Restli-Protocol-Version 2.0.0. Post ID comes from x-restli-id.
[Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api?view=li-lms-2026-09): POST /rest/socialActions/{encoded target}/comments. Nested replies use the composite parent comment URN in the path and parentComment field, with the thread object.
[Reactions API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api?view=li-lms-2026-09): POST /rest/reactions?actor={encoded member}; body root + reactionType. Remove using DELETE /rest/reactions/(actor:{encoded member},entity:{encoded target}). Supported values: LIKE/Like, PRAISE/Celebrate, EMPATHY/Love, INTEREST/Insightful, APPRECIATION/Support, ENTERTAINMENT/Funny. Deprecated MAYBE is rejected.
Current comments/reactions docs require w_member_social_feed. Community Management API access is approval-gated; Share on LinkedIn alone does not establish this access. Check actual Products/Auth scopes before promising those tools can operate.
[Increasing access](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-09) explains product approval. Restricted member read/feed access is not part of this V1. Target access and rate limits still apply.
LINKEDIN_VERSION defaults to explicitly selected 202609, supported documentation reviewed for this pass; it is not dynamically the latest version. Recheck [versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-09) before onboarding.
Identity resolution may use the [OIDC product](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) with openid/profile scopes. Obtain a verified authenticated member ID rather than guessing from profile URLs.

## Later connection
Create the developer app and enable/request the products above. After access is confirmed, authorize the personal member, supply token and person URN privately in the local environment, and keep LINKEDIN_WRITE_ENABLED=false for initial inspection.
Only set LINKEDIN_WRITE_ENABLED=true after reviewing configuration and product permissions. Every action still requires approved:true.
A ChatGPT remote connection needs reachable HTTPS and a protected MCP deployment; localhost is not directly reachable from ChatGPT. Production MCP authentication, OAuth token storage, and account linking are next-phase work. Do not expose this local-only server with a public tunnel unchanged.
Store production secrets/tokens durably in an encrypted secret store with expiry/revocation handling. Ignored local .env is only a development convenience.

## Personal profile and managed pages

After deployment and reconnection, call `linkedin_capabilities` and `linkedin_list_managed_organizations`. Use `linkedin_resolve_actor` for exact page names or vanity names. Duplicate names require clarification. Every approval must name the actor, action, exact content and target; scheduling also names the time and timezone. A changed actor requires new approval.

Example: "Schedule these 7 posts for Monday-Sunday at 8 AM Africa/Lagos: Monday on my personal profile, Tuesday as Centrisec, and the rest on the named managed pages."

Show all seven exact posts, actor names and absolute dates/times, obtain one approval covering all items, call `linkedin_schedule_text_posts` once with each item's `actor` and offset timestamp, then return IDs and stored times. `actor` accepts `personal`, an exact managed-page name or an internal organization selector. Existing personal `targetUrn` inputs remain compatible; conflicting actor/target inputs fail. Stored approval authorizes cron publishing; rescheduling needs approval of the existing actor/content and new time. Changing content/actor requires cancellation and a new approved record.

Examples: "Post this as Centrisec", "Show me the pages I manage", "Comment on this URL as Centrisec", "React from my personal profile", "Show recent posts from Centrisec", and "Reply to the latest comment on yesterday's Centrisec post." Read known posts/comments where permitted, draft, present the exact actor/target/reply and obtain approval before writing. Read results expose pagination. Latest/unanswered claims require complete relevant results. Recent posts are ordered by modification, so selecting the newest publication may require more pages.

Normal `/posts/...activity-ID...` and `/feed/update/urn:li:...` URLs expose identifiers without fetching. An activity URL supports social actions but cannot be assumed to identify the share/ugcPost required for post reads/edits. Use a returned recent-post or scheduler ID for those. Shortened/identifier-free links require an API-returned identifier. Writes to a known target do not require feed reads; reading content/comments requires separate scopes.

New shared tools: `linkedin_capabilities`, `linkedin_list_managed_organizations`, `linkedin_resolve_actor`, `linkedin_resolve_post_target`, `linkedin_list_recent_posts`, `linkedin_get_post`, `linkedin_get_comments`, `linkedin_get_replies`, `linkedin_find_unanswered_comments`, `linkedin_get_social_metadata`, `linkedin_edit_comment`, `linkedin_delete_comment`, `linkedin_edit_post`, `linkedin_delete_post`, `linkedin_publish_article_post`. Existing social writes accept `actor`; the six scheduler tools now support mixed actors.

Article/link posts use approved HTTPS source, title, optional description and commentary, without preview scraping. Image/multi-image/PDF/video uploads remain a follow-up. Messaging, invitations, following and general-feed crawling are unavailable. Original skills can draft messages for manual use; they do not send through an API.

## Connecting two apps

When the separate Community app is approved and configured, reconnect through the existing custom MCP server URL and select **Also connect the Community app for managed company pages** on owner consent. Complete personal authorization first and Community authorization second in the same browser. Community review pending or missing eligible configuration leaves personal connection available.

`linkedin_connection_status` and `linkedin_capabilities` now report separate `connections.personal` and `connections.community`; scheduler status reports Community expiry/reconnection needs. The tool list is unchanged. Page actions use the secondary app; personal actions use the primary app. Never describe secondary grants as primary personal permissions, and never change the actor to make an unavailable action work. A Community authorization failure does not authorize a page write or remove required approval.
