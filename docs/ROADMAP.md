# Roadmap
## Complete: local V1 foundation
Original skills preserved; project brand context; six approval-gated tools; local Streamable HTTP MCP and health endpoints; fixed context resources; environment configuration; mocked safety and HTTP integration tests.
## Next: account linking and protected connectivity
Protected Workers MCP OAuth, encrypted token grant storage, official member callback, identity lookup and expiry checks are implemented. Next, confirm app products, register the deployed callback, and complete member consent. Run a separately approved controlled post only after verification.
## Deferred
Media uploads, analytics where permissions permit, and optional organization identity. No dashboard, feed crawling, scraping, DM automation, multi-user accounts, or CRM.
## Implemented: approved personal scheduling
The existing protected Worker has six scheduler tools, D1 approval/state storage, AES-GCM encrypted member credentials and a one-minute Cron Trigger. It reuses the existing posting client, preserves expired-auth posts, and stops uncertain publish attempts for manual review. Database creation/migrations, secret upload and scheduler deployment are complete as of 2026-10-04. Picture support remains deferred.

## Managed identities (deployed 2026-10-06)

The shared client now supports authorized page actions, capability reporting, known-content reads, URL parsing, ownership-checked edits/deletes and article/link posts. The existing scheduler supports mixed identities. Confirm app-specific scope eligibility and reconnect; missing grants remain unavailable. Messages/invitations require partner authorization; media uploads are deferred. Migration 0002 and Worker version a54cb454-0caa-4374-ab95-c52983170d68 are deployed; no additional Cloudflare resources were required.

## Separate Community app (implemented, not deployed)

Optional chained owner OAuth, app-specific member identities, per-app capability reporting and encrypted Community scheduler credentials reuse the existing Worker/client/D1. Awaiting LinkedIn Community Management review; configuration is disabled until eligible scopes and new app credentials are supplied. Apply migration 0003 before deployment. Personal social-feed permissions remain primary-app capabilities.
