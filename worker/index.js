import { OAuthProvider, OAuthError } from '@cloudflare/workers-oauth-provider';
import { defaultHandler, mcpHandler } from './application.js';

export default {
  async fetch(request, env, ctx) {
    // Fixed deployment origin prevents poisoned Host headers from affecting OAuth.
    if (!env.PUBLIC_ORIGIN || new URL(request.url).origin !== env.PUBLIC_ORIGIN) {
      if (new URL(request.url).pathname === '/health') return Response.json({ status: 'setup_pending', writesEnabled: false });
      return new Response('Deployment origin not configured', { status: 503 });
    }
    const provider = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: { fetch: mcpHandler },
      defaultHandler: { fetch: defaultHandler },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['linkedin:actions', 'offline_access'],
      requiredScopes: ['linkedin:actions'],
      resourceMetadata: { resource: env.PUBLIC_ORIGIN + '/mcp', authorization_servers: [env.PUBLIC_ORIGIN] },
      accessTokenTTL: 3600,
      refreshTokenTTL: 2592000,
      tokenExchangeCallback: async options => {
        if (!options.props?.owner || !Number.isFinite(options.props.expiresAt) || options.props.expiresAt <= Date.now()) throw new OAuthError('invalid_grant', { description: 'LinkedIn authorization expired. Reconnect.' });
        return { accessTokenTTL: Math.max(1, Math.min(3600, Math.floor((options.props.expiresAt - Date.now()) / 1000))) };
      },
    });
    try { return await provider.fetch(request, env, ctx); }
    catch { return new Response('Server could not complete request', { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
  },
};
