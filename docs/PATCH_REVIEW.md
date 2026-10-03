# Bootstrap review

The supplied patch was reviewed before application and used only as a scaffold. It changed no original skills. The final implementation replaces its client, configuration, tools, and HTTP server; brand facts and documentation were corrected against owner context and official documentation.

Key corrections:
- Approval had existed only in tool handlers; every public client write now requires both gates, including direct calls.
- Loose string/prefix checks became runtime schemas for member/post/composite comment identifiers, bounded nonblank text, and supported reactions.
- Configurable API origin and default HTTP binding could expose tokens or writes; API host is fixed, redirects rejected, server binds to loopback and validates Host/Origin.
- Raw upstream error bodies and arbitrary exception logging were removed. Safe HTTP advice is returned without upstream body/statusText/cause. No automatic retry of writes.
- Environment loading, credential-free startup, health endpoint, transport cleanup, and actual HTTP MCP registration/resource tests were added.
- OAuth had no architecture beyond token placeholders. Official member flow and the separate production MCP authentication boundary are now documented; real account linking is deferred.
- Personal voice and product details now match owner-supplied facts. Unsupported founder background claims were removed. GRC stays planned/developing; unknown proof stays unknown.

API review on 2026-10-01: current Posts, Comments, Reactions, versioning, Share on LinkedIn, product access, OIDC and authorization-code documentation were inspected. Sources and requirements are linked in CHATGPT_SETUP.md. 202609 is an explicit reviewed version, not a claim of always being latest. Comments/reactions access requires the current feed scope and product approval, not merely the post scope.

Tests mock all LinkedIn requests. No real tokens, OAuth setup, live API calls, scheduler, database, or infrastructure were introduced.
