/** @file Frontera HTTP MCP/OAuth y consentimiento humano, aislada del middleware general del Gateway. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const mcpTools             = require('../contracts/mcp-tools.json');
/** @param {Object} dependencies Configuración, RPC, sesiones y logger. @returns {Object} Router con inicialización diferida y fallos cerrados. */
function mcpRoutes({ config, messaging, sessions, logger, temporaryFiles }) {
  const express = require('express'),
    router      = express.Router();
  let initialized;
  /** @param {string} service Productor. @param {string} name Acción. @param {Object} data DTO. @param {Object} context Identidad verificada. @returns {Promise<Object>} Sobre RPC sin convertir fallos en ausencia. */
  async function rpc(service, name, data, context = {}, timeoutMs = 30000) {
    return messaging.request(service, name, data, {
      context,
      timeoutMs,
    });
  }
  /** @param {string} name Acción de Security. @param {Object} data DTO. @param {Object} context Contexto privado. @returns {Promise<Object>} Datos acreditados. */
  async function security(name, data, context = {}) {
    const result = await rpc('service-security', name, data, context);
    if (!result || result.statusCode >= 400)
      throw new ApplicationError(
        result?.statusCode || 503,
        result?.descriptionCode || 'MCP_SECURITY_UNAVAILABLE',
      );
    return result.data;
  }
  /** @returns {Promise<Object>} Proveedor y contratos públicos; un fallo permite un intento posterior. */
  async function initialize() {
    if (!initialized)
      initialized = (
        /** @returns {Promise<Object>} Construye proveedor y contratos una vez por proceso. */
        async () => {
          const provider  =
            await require('../../../adapters/mcp/oauth-provider').createOAuthProvider({
              config,
              request : security,
            });
          const contracts = await require('../services/mcp-contracts.service').mcpContracts({
            request  : rpc,
            services : mcpTools.map(
              /** @param {Object} tool Operación publicada. @returns {string} Servicio propietario. */
              (tool) => tool.service,
            ),
          });
          return {
            provider,
            contracts,
          };
        }
      )().catch(
        /** @param {Error} error Fallo de arranque de esta capacidad. @returns {never} Rechaza sin alterar el resto del Gateway. */
        (error) => {
          initialized = undefined;
          throw error;
        },
      );
    return initialized;
  }
  router.use(
    /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {*} Valida origen y excluye caches y CORS abiertos. */
    (req, res, next) => {
      if (
        !/^\/(?:mcp(?:\/|$)|mcp-access(?:\/|$)|oauth(?:\/|$)|\.well-known\/oauth-)/.test(req.path)
      )
        return next('router');
      res.set('Cache-Control', 'private, no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      const origin         = req.get('Origin');
      const ownOAuthOrigin =
        (req.path === '/oauth' || req.path.startsWith('/oauth/')) &&
        origin === new URL(config.issuer).origin;
      if (
        req.get('Host') !== new URL(config.resource).host ||
        (origin && !ownOAuthOrigin && !config.allowedOrigins.includes(origin))
      )
        return res.status(403).json({ error: 'MCP_ORIGIN_FORBIDDEN' });
      if (origin) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Credentials', 'true');
      }
      res.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, traceparent, tracestate',
      );
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    },
  );
  router.get(
    '/.well-known/oauth-protected-resource/mcp',
    /** @param {Object} req Solicitud pública. @param {Object} res Respuesta. @returns {Object} Descubrimiento del recurso exacto. */
    (req, res) =>
      res.json({
        resource                 : config.resource,
        authorization_servers    : [config.issuer],
        scopes_supported         : config.scopes,
        bearer_methods_supported : ['header'],
        resource_name            : 'Xidden Comercial',
      }),
  );
  router.get(
    '/.well-known/oauth-authorization-server/oauth',
    /** @param {Object} req Solicitud. @param {Object} res Respuesta. @returns {Object} Metadatos del emisor, sin claves privadas. */
    (req, res) =>
      res.json({
        issuer                                         : config.issuer,
        authorization_endpoint                         : config.issuer + '/auth',
        token_endpoint                                 : config.issuer + '/token',
        revocation_endpoint                            : config.issuer + '/token/revocation',
        jwks_uri                                       : config.issuer + '/jwks',
        response_types_supported                       : ['code'],
        grant_types_supported                          : ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported               : ['S256'],
        token_endpoint_auth_methods_supported          : ['none'],
        scopes_supported                               : ['openid', 'offline_access', ...config.scopes],
        authorization_response_iss_parameter_supported : true,
      }),
  );
  router.use(
    '/oauth',
    /** @param {Object} req OAuth HTTP sin body parser previo. @param {Object} res Respuesta. @returns {Promise<void>} Protocolo gestionado por oidc-provider. */
    async (req, res) => {
      const { provider } = await initialize();
      if (req.path === '/auth') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
        const client =
          typeof req.query.client_id === 'string'
            ? await provider.Client.find(req.query.client_id)
            : null;
        if (
          client &&
          (typeof req.query.redirect_uri !== 'string' ||
            !client.redirectUriAllowed(req.query.redirect_uri))
        )
          return res.status(400).json({ error: 'invalid_redirect_uri' });
        if (
          typeof req.query.scope === 'string' &&
          req.query.scope.split(' ').includes('offline_access') &&
          req.query.prompt === undefined
        ) {
          const authorization = new URL(req.url, config.issuer);
          authorization.searchParams.set('prompt', 'consent');
          req.url = authorization.pathname + authorization.search;
        }
      }
      await provider.callback()(req, res);
    },
  );
  router.use(
    '/mcp-access',
    express.json({ limit: '64kb' }),
    /** @param {Object} req Solicitud del navegador. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Promise<*>} Sólo sesiones humanas, con permisos recalculados. */
    async (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /i, '');
      if (!token || /\s/.test(token)) throw new ApplicationError(401, 'UNAUTHORIZED');
      const session = await sessions.authenticate(token, { currentPolicies: true });
      req.mcpHuman = {
        user        : {
          ...session.user,
          userCode : session.userCode,
        },
        sessionCode : session.sessionCode,
        idSession   : session.sessionId,
        workspace   : session.activeWorkspace,
        workspaces  : session.workspaces,
        policies    : session.policies,
      };
      return next();
    },
  );
  router.get(
    '/mcp-access/connections',
    /** @param {Object} req Sesión humana. @param {Object} res Respuesta. @returns {Promise<Object>} Página de conexiones propias. */
    async (req, res) =>
      res.json(
        await security('oauth-grant-get-list', { page: Number(req.query.page || 1) }, req.mcpHuman),
      ),
  );
  router.delete(
    '/mcp-access/connections/:code',
    /** @param {Object} req Concesión propia. @param {Object} res Respuesta. @returns {Promise<Object>} Revocación confirmada. */
    async (req, res) =>
      res.json(await security('oauth-grant-revoke', { grantCode: req.params.code }, req.mcpHuman)),
  );
  router.post(
    '/mcp-access/clients',
    /** @param {Object} req Alta administrativa de cliente público PKCE. @param {Object} res Respuesta. @returns {Promise<Object>} Metadatos registrados sin secretos. */
    async (req, res) => {
      await security('oauth-client-authorize', {}, req.mcpHuman);
      const { clientId, name, redirectUris } = req.body;
      if (
        Object.keys(req.body).some(
          /** @param {string} key Campo solicitado. @returns {boolean} Campo no admitido. */
          (key) => !['clientId', 'name', 'redirectUris'].includes(key),
        ) ||
        typeof clientId !== 'string' ||
        !/^[a-zA-Z0-9_-]{3,100}$/.test(clientId) ||
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 200 ||
        !Array.isArray(redirectUris) ||
        !redirectUris.length ||
        redirectUris.length > 10
      )
        throw new ApplicationError(400, 'OAUTH_CLIENT_INVALID');
      let native = false;
      for (const uri of redirectUris) {
        const url      = new URL(uri);
        const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
        if (
          (!loopback && url.protocol !== 'https:') ||
          url.hash ||
          url.username ||
          url.password ||
          uri.includes('*')
        )
          throw new ApplicationError(400, 'OAUTH_REDIRECT_INVALID');
        native ||= loopback;
      }
      const { provider } = await initialize();
      if (await provider.Client.find(clientId))
        throw new ApplicationError(409, 'OAUTH_CLIENT_EXISTS');
      const client = new provider.Client({
        client_id                  : clientId,
        client_name                : name,
        redirect_uris              : redirectUris,
        application_type           : native ? 'native' : 'web',
        response_types             : ['code'],
        grant_types                : ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method : 'none',
      });
      await provider.Client.adapter.upsert(clientId, client.metadata());
      return res.status(201).json({
        clientId,
        name,
        redirectUris,
      });
    },
  );
  /** @param {Object} req Petición ligada a cookie y UID. @param {Object} res Respuesta. @returns {Promise<Object>} Interacción y cliente acreditados. */
  async function interaction(req, res) {
    const { provider } = await initialize(),
      value            = await provider.interactionDetails(req, res);
    if (value.uid !== req.params.uid) throw new ApplicationError(403, 'OAUTH_INTERACTION_MISMATCH');
    const client = await provider.Client.find(value.params.client_id);
    if (!client) throw new ApplicationError(400, 'OAUTH_CLIENT_INVALID');
    return {
      provider,
      value,
      client,
    };
  }
  router.get(
    '/mcp-access/interactions/:uid',
    /** @param {Object} req Sesión humana. @param {Object} res Respuesta. @returns {Promise<Object>} Solicitud visible sin datos de protocolo privados. */
    async (req, res) => {
      const { value, client } = await interaction(req, res);
      return res.json({
        clientId   : client.clientId,
        clientName : client.clientName || client.clientId,
        workspaces : req.mcpHuman.workspaces,
        scopes     : config.scopes.filter(
          /** @param {string} scope Capacidad comercial. @returns {boolean} Solicitada por el cliente registrado. */
          (scope) => (value.params.scope || '').split(' ').includes(scope),
        ),
      });
    },
  );
  router.post(
    '/mcp-access/interactions/:uid',
    /** @param {Object} req Consentimiento explícito del navegador. @param {Object} res Respuesta. @returns {Promise<Object>} URL de reanudación sin credenciales. */
    async (req, res) => {
      const { provider, value, client } = await interaction(req, res);
      if (req.body.deny === true)
        return res.json({
          redirect : await provider.interactionResult(req, res, {
            error             : 'access_denied',
            error_description : 'El usuario rechazó la conexión.',
          }),
        });
      if (
        !req.body ||
        Object.keys(req.body).some(
          /** @param {string} key Campo. @returns {boolean} Campo no admitido en el consentimiento. */
          (key) => !['scopes', 'workspaces', 'deny'].includes(key),
        )
      )
        throw new ApplicationError(400, 'OAUTH_CONSENT_INVALID');
      const { scopes, workspaces } = req.body;
      const requested              = (value.params.scope || '').split(' ');
      if (
        !Array.isArray(workspaces) ||
        !workspaces.length ||
        workspaces.length > 500 ||
        workspaces.some(
          /** @param {string} workspace Destino. @returns {boolean} No pertenece a la sesión actual. */
          (workspace) =>
            !req.mcpHuman.workspaces.includes(workspace) || workspace === 'allWorkspaces',
        ) ||
        !Array.isArray(scopes) ||
        !scopes.length ||
        scopes.some(
          /** @param {string} scope Capacidad elegida. @returns {boolean} No solicitada o no admitida. */
          (scope) => !requested.includes(scope) || !config.scopes.includes(scope),
        )
      )
        throw new ApplicationError(400, 'OAUTH_SCOPE_INVALID');
      const consumed = await security('oauth-storage-consume', {
        model : 'Interaction',
        id    : value.uid,
      });
      if (!consumed.consumed) throw new ApplicationError(409, 'OAUTH_INTERACTION_COMPLETED');
      const grant = new provider.Grant({
        accountId : req.mcpHuman.user.userCode,
        clientId  : client.clientId,
      });
      grant.addOIDCScope(
        requested
          .filter(
            /** @param {string} scope Capacidad OIDC solicitada. @returns {boolean} Sólo identidad y renovación. */
            (scope) => ['openid', 'offline_access'].includes(scope),
          )
          .join(' '),
      );
      grant.addResourceScope(config.resource, scopes.join(' '));
      grant.rejectResourceScope(
        config.resource,
        config.scopes
          .filter(
            /** @param {string} scope Capacidad comercial. @returns {boolean} No fue consentida. */
            (scope) => !scopes.includes(scope),
          )
          .join(' '),
      );
      const grantId = await grant.save();
      await security(
        'oauth-grant-create',
        {
          grantCode  : grantId,
          clientId   : client.clientId,
          clientName : client.clientName || client.clientId,
          scopes,
          workspaces,
        },
        req.mcpHuman,
      );
      return res.json({
        redirect : await provider.interactionResult(
          req,
          res,
          {
            login   : { accountId: req.mcpHuman.user.userCode },
            consent : { grantId },
          },
          { mergeWithLastSubmission: false },
        ),
      });
    },
  );
  const capabilities = require('../../../adapters/mcp/transfer-capabilities').transferCapabilities(
    config,
  );
  require('./mcp-transfer.routes').mountTransfers({
    router,
    capabilities,
    temporaryFiles,
    writesEnabled : config.writesEnabled,
    request       : rpc,
    /** @param {Object} data Concesión original y espacio. @returns {Promise<Object>} Principal actual. */
    resolve       : (data) => security('oauth-principal-resolve', data),
  });
  router.all(
    '/mcp',
    express.json({ limit: '1mb' }),
    /** @param {Object} req Petición MCP. @param {Object} res Respuesta. @returns {Promise<*>} Autenticación por petición y ejecución aislada. */
    async (req, res) => {
      const match     = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '');
      const challenge = `Bearer resource_metadata="${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp"`;
      if (!match)
        return res.set('WWW-Authenticate', challenge).status(401).json({ error: 'invalid_token' });
      const { provider, contracts } = await initialize();
      const token                   = await provider.AccessToken.find(match[1]);
      if (!token || token.isExpired || token.aud !== config.resource || !token.grantId)
        return res.set('WWW-Authenticate', challenge).status(401).json({ error: 'invalid_token' });
      const principal = await security('oauth-principal-resolve', {
        grantCode : token.grantId,
        clientId  : token.clientId,
        ...(req.body?.method === 'tools/call' && req.body?.params?.name === 'xidden-context-get'
          ? { includeWorkspaceDetails: true }
          : {}),
      });
      if (principal.userCode !== token.accountId)
        throw new ApplicationError(401, 'OAUTH_ACCOUNT_MISMATCH');
      const connection = {
        ...principal,
        scopes : principal.scopes.filter(
          /** @param {string} scope Capacidad de la conexión. @returns {boolean} También está en el token presentado. */
          (scope) => token.scopes.has(scope),
        ),
      };
      const execution  = require('../services/mcp-execution.service').mcpExecution({
        request           : rpc,
        /** @param {Object} tool Transferencia. @param {Object} data Entrada. @param {Object} context Identidad. @returns {Object} Capacidad privada de cinco minutos. */
        transfer          : (tool, data, context) => capabilities.issue(tool, data, context),
        /** @param {Object} data Concesión y destino. @returns {Promise<Object>} Principal actual. */
        resolve           : require('../services/mcp-request-principal.service').requestPrincipal({
          principal,
          /** @param {Object} data Otro contexto solicitado. @returns {Promise<Object>} Autoriza desde Security. */
          resolve : (data) => security('oauth-principal-resolve', data),
        }),
        /** @param {Object} event Metadatos sin argumentos ni resultados privados. @returns {Promise<Object>} Evidencia durable en Security. */
        async audit(event) {
          try {
            return await security('oauth-execution-record', event);
          } catch (error) {
            logger.error({
              component : 'service',
              event     : 'operation_failed',
            });
            throw error;
          }
        },
        /** @returns {string} Correlación técnica por intento, distinta de la clave de intención comercial. */
        identifier        : () => require('node:crypto').randomUUID(),
        requestIdentifier : require('../../../adapters/mcp/request-identity').requestIdentifier,
        clock             : Date.now,
        writesEnabled     : config.writesEnabled,
      });
      return require('../../../adapters/mcp/mcp-server').createMcpRequest({
        contracts,
        execution,
        connection,
        writesEnabled : config.writesEnabled,
      })(req, res);
    },
  );
  router.use(
    /** @param {Object} req Solicitud reservada. @param {Object} res Respuesta. @returns {Object} No cae al CORS o parser general. */
    (req, res) => res.status(404).json({ error: 'MCP_ROUTE_NOT_FOUND' }),
  );
  router.use(
    /** @param {Error} error Fallo privado. @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación Express. @returns {*} Error público sin stack ni causas. */
    (error, req, res, next) => {
      if (res.headersSent) return next(error);
      const status = error.statusCode || error.status || 503;
      if (status === 401)
        res.set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp"`,
        );
      return res.status(status >= 400 && status <= 599 ? status : 503).json({
        error :
          error.descriptionCode ||
          (status === 413
            ? 'MCP_BODY_TOO_LARGE'
            : status === 400
              ? 'MCP_INVALID_REQUEST'
              : 'MCP_UNAVAILABLE'),
      });
    },
  );
  return router;
}
module.exports = { mcpRoutes };
