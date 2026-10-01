# Local setup and eventual ChatGPT connection
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
