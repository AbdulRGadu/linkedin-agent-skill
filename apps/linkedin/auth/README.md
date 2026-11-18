# Official member OAuth boundary (not implemented in V1)
Use LinkedIn's three-legged OAuth authorization-code flow, never username/password or scraping.
Future flow: configure exact redirect URI; request only granted scopes; generate and verify unpredictable one-use state; exchange code server-side; resolve authenticated member identity; store token/expiry securely; reauthorize when expired. Do not assume refresh-token eligibility.
Authorization: https://www.linkedin.com/oauth/v2/authorization
Token exchange: https://www.linkedin.com/oauth/v2/accessToken
Client secrets stay server-side. Never place codes/tokens in logs, tool outputs, Git, or URLs that are persisted.
For identity, evaluate the Sign In with LinkedIn using OpenID Connect product and openid/profile scopes; resolve the authenticated member's person identifier through documented identity endpoints. A profile URL or organization URN is not a personal author URN.
V1 has no browser redirect, token exchange, refresh job, or credential persistence. Token and LINKEDIN_PERSON_URN must refer to the same member; the API enforces identity/permissions.
Reference: [LinkedIn authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow).
