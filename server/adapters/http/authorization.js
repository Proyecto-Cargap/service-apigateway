/**
 * @file Preparación del contexto HTTP y validación de tokens y sesiones antes de ejecutar las rutas del
 * gateway.
 */
'use strict';
/**
 * Compone createAuthorization con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: messaging, logger, response, sessions, identity, tokenSecret.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createAuthorization({ messaging, logger, response, sessions, identity, tokenSecret }) {
  const jwt            = require('jsonwebtoken');
  const { jwtContext } = require('../../shared/jwt-context');
  const { id }         = identity;

  const controller = 'C000';

  /**
   * Valida el token y la sesión y prepara el contexto del usuario antes de continuar con la ruta HTTP.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
   * undefined.
   */
  const authorizationValidation = async (req, res, next) => {
    try {
      const idTransaction = await response.init(req);

      let token = req.get('Authorization');
      if (!token) {
        if (req.query.Authorization) {
          token = req.query.Authorization;
        } else {
          return response.sendError(req, res, 401, `${id}-${controller}-E0001:Unauthorized`);
        }
      }

      token = token.replace(/^Bearer\s+/i, '');
      const decode = jwt.verify(token.replace(/^Bearer\s+/i, ''), tokenSecret, {
        algorithms : ['HS256'],
        ...jwtContext('session'),
        audience   : [jwtContext('session').audience, jwtContext('agent_execution').audience],
      });

      if (decode.purpose === 'agent_execution') {
        const result    = await messaging.request('service-security', 'agent-principal-authenticate', {
          token,
        });
        const principal = result?.data?.principal;
        if (
          result?.statusCode !== 200 ||
          principal?.actorType !== 'agent' ||
          typeof principal.userCode !== 'string' ||
          !principal.userCode ||
          typeof principal.agentCode !== 'string' ||
          !principal.agentCode ||
          typeof principal.runCode !== 'string' ||
          !principal.runCode ||
          typeof principal.workspace !== 'string' ||
          !principal.workspace ||
          principal.workspace === 'allWorkspaces' ||
          !Array.isArray(principal.workspaces) ||
          !principal.workspaces.includes(principal.workspace) ||
          !Array.isArray(principal.policies) ||
          principal.policies.some(
            /**
             * Comprueba si el elemento satisface la condición.
             * @param {*} value Valor de value utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (value) => typeof value !== 'string',
          ) ||
          !Number.isFinite(result.data.expiration) ||
          result.data.expiration <= Date.now() / 1000
        )
          return response.sendError(
            req,
            res,
            result?.statusCode >= 500 ? 503 : 401,
            'INVALID_AGENT_CREDENTIAL',
          );
        req.system = {
          idTransaction,
          idSession           : `agent:${principal.runCode}`,
          sessionCode         : '',
          actorType           : 'agent',
          agentCode           : principal.agentCode,
          runCode             : principal.runCode,
          initiatedByUserCode : principal.initiatedByUserCode || '',
          user                : {
            userCode    : principal.userCode,
            contactCode : principal.contactCode,
            userType    : 'agent',
            agentCode   : principal.agentCode,
          },
          policies            : principal.policies,
          groups              : principal.groups,
          workspace           : principal.workspace,
          workspaces          : principal.workspaces,
          scope               : '',
          ip                  : req.headers['x-forwarded-for'],
          agent               : req.headers['user-agent'],
        };
        return messaging.runWithContext(req.system, next);
      }

      if (decode.user?.userType === 'agent')
        return response.sendError(req, res, 401, 'INVALID_AGENT_CREDENTIAL');

      const session = await sessions.authenticate(token, { currentPolicies: true });
      if (session.userCode !== decode.user?.userCode)
        return response.sendError(req, res, 401, 'INVALID_SESSION');

      let location = [0.0, 0.0];
      if (req.query.geolocation) {
        location = req.query.geolocation.split(',');
      }

      req.system = {};
      req.system.idTransaction = idTransaction;
      req.system.idSession = session.sessionId;
      req.system.policies = session.policies;
      req.system.workspace = session.activeWorkspace;
      req.system.workspaces = session.workspaces;
      req.system.scope = '';
      req.system.sessionCode = session.sessionCode;
      req.system.user = {
        ...decode.user,
        ...session.user,
      };
      req.system.ip = req.headers['x-forwarded-for'];
      req.system.agent = req.headers['user-agent'];
      req.system.location = {
        latitude  : location[0],
        longitude : location[1],
      };

      return messaging.runWithContext(req.system, next);
    } catch (err) {
      logger.error({
        component : 'application',
        event     : 'operation_failed',
      });
      return response.sendError(
        req,
        res,
        err?.statusCode >= 500 ? 503 : 401,
        `${id}-${controller}-E0001:Unauthorized`,
      );
    }
  };

  /**
   * Prepara el contexto de una ruta pública sin exigir la validación de una sesión autenticada.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
   * undefined.
   */
  const withOutValidation = async (req, res, next) => {
    try {
      const idTransaction = await response.init(req);

      let location = [0.0, 0.0];
      if (req.query.geolocation) {
        location = req.query.geolocation.split(',');
      }
      req.system = {};
      req.system.idTransaction = idTransaction;
      req.system.workspace = '';
      req.system.workspaces = [];
      req.system.idSession = 'no session';
      req.system.scope = '';
      req.system.sessionCode = '';
      req.system.services = [];
      req.system.ip = req.headers['x-forwarded-for'];
      req.system.agent = req.headers['user-agent'];
      req.system.location = {
        latitude  : location[0],
        longitude : location[1],
      };

      return messaging.runWithContext(req.system, next);
    } catch (err) {
      logger.error({
        component : 'application',
        event     : 'operation_failed',
      });
      return response.sendError(req, res, 500);
    }
  };

  /** Autentica si existe token; una descarga pública conserva el contexto invitado.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const optionalAuthorization = (req, res, next) =>
    req.get('Authorization') || req.query?.Authorization
      ? authorizationValidation(req, res, next)
      : withOutValidation(req, res, next);

  return {
    authorizationValidation,
    withOutValidation,
    optionalAuthorization,
  };
}
module.exports = { createAuthorization };
