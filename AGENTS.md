# LinkedIn Agent instructions

This repository combines the original LinkedIn content skills with a controlled LinkedIn action layer.

Work on feature/chatgpt-linkedin-v1; compare against origin/main. Do not use or repair unrelated local main or merge into main.
Use Node 22.13+; run npm test and npm run lint before committing. Never use live LinkedIn requests in tests.

## Content compatibility

Preserve original skills. For this agent, map their Claude-specific voice path to brand/abdul/voice.md, plan path to storage/plans/plan.md, and log path to storage/logs/log.md. Read the original rules without making duplicated copies. Original standalone Claude usage remains valid.
The content skill produces a draft first. A separate API action may follow only after explicit approval; a drafting request is never approval. li-human scores are local heuristics, not authorship or undetectability proof.
Expose only fixed skills/brand documents as MCP resources; never arbitrary filesystem paths or secrets.
Local server binding must remain loopback until protected remote deployment is implemented.

## Operating rules

1. Read the relevant `skills/li-*/SKILL.md` before generating LinkedIn content.
2. Use `brand/abdul/` as the default personal-profile context.
3. Use `brand/centrisec/` for company/product facts, not as permission to make unsupported claims.
4. Never invent metrics, clients, outcomes, quotes, certifications, partnerships, or product capabilities.
5. Draft first. Humanize before presenting final social copy.
6. Never invoke a LinkedIn write action unless the user explicitly approves the exact post/comment/reply/reaction.
7. Never place access tokens, client secrets, refresh tokens, or credentials in Git.
8. Do not scrape LinkedIn or automate the LinkedIn website. Use documented APIs only.

## V1 action boundary

Supported action tools:
- connection status
- personal text post publishing
- comment creation
- nested comment replies
- reactions
- reaction removal

Not yet supported:
- feed crawling
- analytics ingestion
- scheduling
- image/document upload
- company-page publishing
