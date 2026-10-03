# Local V1 architecture

## Cloudflare extension

The original local foundation below is preserved. worker/index.js now serves a protected remote MCP endpoint through Cloudflare's OAuth provider; worker/application.js owns consent, official member OAuth and the Web Standards transport. The build bundles fixed context documents from their original paths. See WORKERS_SETUP.md for live URLs, owner linking and encrypted grant storage. Public connectivity and account-linking routes are implemented; actual member consent is still pending.
## Flow
User → ChatGPT → original content skills + Abdul context → MCP → approval gates → LinkedIn client → official LinkedIn API.
Codex builds and tests the agent. ChatGPT is the intended everyday interface after protected remote integration.

## Implementation
Node 22.13+ ESM JavaScript with supported MCP SDK v1 (installed version pinned by package-lock.json). JavaScript avoids a compilation layer; Zod validates runtime inputs.
server/index.js serves stateless Streamable HTTP POST /mcp and GET /health on 127.0.0.1. Each request owns a server/transport, closed with the response. GET/DELETE MCP methods return 405 because sessions and standalone SSE streams are not used.
Six tools: connection status, text publishing, comments, replies, add reaction, remove reaction. No unrestricted request tool.
Fixed MCP resources expose the original 11 skill documents and seven brand documents without duplicating writing rules. A client without resource support must receive these files as explicit context; adding an MCP endpoint alone does not inject writing instructions.

## Safety
Every write reaches assertWriteAllowed in the client: writeEnabled must be true AND approved must be boolean true. Missing credentials/invalid input fail before network access.
Approval is a caller assertion, not cryptographic proof that a human clicked approve. Clients must solicit approval of the exact content/target/action. This local server has no user identity or production authorization service.
Fixed api.linkedin.com origin, rejected redirects, 15-second timeout, no automatic retries. No upstream body, statusText, network cause, or token is logged or returned. Only validated identifiers/status are exposed.
Host and Origin validation plus loopback binding reduce local exposure. Before public connectivity, implement MCP-compatible authentication and HTTPS; do not publish this local endpoint unchanged.

## Skill compatibility
Original skills remain byte-for-byte intact. Standalone Claude use keeps ~/.claude/linkedin paths.
For this agent, AGENTS.md overrides context selection: voice.md → brand/abdul/voice.md; plan.md → storage/plans/plan.md; log.md → storage/logs/log.md. Original rules remain authoritative for content, while their manual-paste output can be followed by a separate explicitly approved API action.
These mappings are host instructions, not a filesystem alias or automatic server write. The server does not generate drafts or persist plans/logs.
li-human uses its original Python scripts and lexicon; scores are local heuristics, not authorship or detection guarantees.

## OAuth boundaries
LinkedIn OAuth and future MCP client authentication are separate trust boundaries. V1 accepts an existing official member access token through the environment. Client ID/secret/redirect placeholders reserve configuration for future account linking; no OAuth routes are active.
See apps/linkedin/auth/README.md for the deferred authorization design.
