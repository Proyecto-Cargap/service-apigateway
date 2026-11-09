/** @file Composición del protocolo OAuth: PKCE obligatorio, tokens de audiencia única y persistencia remota. */
'use strict';
const { oauthStorage } = require('./oauth-storage');
/** @param {Object} options Configuración validada y RPC privado. @returns {Promise<Object>} Proveedor sin abrir listeners propios. */
async function createOAuthProvider({ config, request }) {
  /** @param {Object} ctx Contexto. @param {Object} token Token original o rotado. @returns {number} Vencimiento absoluto de treinta días. */
  function refreshLifetime(ctx, token) {
    return Math.max(1, 2592000 - (Math.floor(Date.now() / 1000) - token.iiat));
  }
  const { Provider, errors } = await import('oidc-provider');
  const provider             = new Provider(config.issuer, {
    adapter       : oauthStorage(request),
    jwks          : config.jwks,
    clients       : config.clients,
    responseTypes : ['code'],
    scopes        : ['openid', 'offline_access'],
    cookies       : {
      keys  : config.cookieKeys,
      short : {
        httpOnly : true,
        secure   : true,
        sameSite : 'lax',
        path     : '/mcp-access',
      },
      long  : {
        httpOnly : true,
        secure   : true,
        sameSite : 'lax',
      },
    },
    features      : {
      devInteractions    : { enabled: false },
      userinfo           : { enabled: false },
      registration       : { enabled: false },
      revocation         : { enabled: true },
      resourceIndicators : {
        enabled : true,
        /** @returns {string} Único recurso admitido por este emisor. */
        defaultResource() {
          return config.resource;
        },
        /** @returns {boolean} Conserva la audiencia durante renovación. */
        useGrantedResource() {
          return true;
        },
        /** @param {Object} ctx Contexto del proveedor. @param {string} resource Recurso solicitado. @returns {Object} Audiencia exacta y tokens opacos. */
        getResourceServerInfo(ctx, resource) {
          if (resource !== config.resource) throw new errors.InvalidTarget();
          return {
            scope             : config.scopes.join(' '),
            audience          : config.resource,
            accessTokenFormat : 'opaque',
            accessTokenTTL    : 600,
          };
        },
      },
    },
    pkce          : {
      methods : ['S256'],
      /** @returns {boolean} Obliga PKCE también a clientes confidenciales. */
      required() {
        return true;
      },
    },
    ttl           : {
      AccessToken       : 600,
      AuthorizationCode : 60,
      Interaction       : 600,
      Grant             : 2592000,
      Session           : 2592000,
      IdToken           : 600,
      RefreshToken      : refreshLifetime,
    },
    /** @returns {boolean} Todas las renovaciones rotan el refresh token. */
    rotateRefreshToken() {
      return true;
    },
    /** @param {Object} ctx Contexto OAuth. @param {Object} client Cliente registrado. @param {Object} source Autorización original. @returns {boolean} Sólo emite renovación con consentimiento offline. */
    issueRefreshToken(ctx, client, source) {
      return client.grantTypeAllowed('refresh_token') && source.scopes.has('offline_access');
    },
    /** @param {Object} ctx Contexto del proveedor. @param {string} id Usuario original. @returns {Promise<Object>} Cuenta activa sin perfil privado. */
    async findAccount(ctx, id) {
      await request('oauth-account-get', { userCode: id });
      return {
        accountId : id,
        /** @returns {Object} Subject opaco, sin correo ni perfil. */
        claims() {
          return { sub: id };
        },
      };
    },
    /** @param {Object} ctx Contexto de emisión o renovación. @returns {Promise<Object|undefined>} Concesión sólo mientras sigue autorizada en Security. */
    async loadExistingGrant(ctx) {
      const id =
        ctx.oidc.result?.consent?.grantId || ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId);
      if (!id) return undefined;
      try {
        await request('oauth-principal-resolve', {
          grantCode : id,
          clientId  : ctx.oidc.client.clientId,
        });
      } catch (error) {
        if ([401, 403, 404].includes(error.statusCode)) return undefined;
        throw error;
      }
      return provider.Grant.find(id);
    },
    /** @param {Object} ctx Respuesta del proveedor. @param {Object} out Error público de protocolo. @returns {void} Respuesta propia sin stack, plantillas remotas ni datos privados. */
    renderError(ctx, out) {
      ctx.type = 'application/json';
      ctx.body = {
        error             : out.error || 'server_error',
        error_description : 'No se pudo completar la autorización.',
      };
    },
    interactions  : {
      /** @param {Object} ctx Contexto OAuth. @param {Object} interaction Interacción almacenada. @returns {string} Pantalla autenticada de Xidden sin token en la URL. */
      url(ctx, interaction) {
        return `${config.webOrigin}/app/security/connections?interaction=${encodeURIComponent(interaction.uid)}`;
      },
    },
  });
  provider.proxy = true;
  return provider;
}
module.exports = { createOAuthProvider };
