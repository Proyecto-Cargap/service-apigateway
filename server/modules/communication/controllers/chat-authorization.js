/** @file Autentica humanos o credenciales breves de agentes en las rutas canónicas de Communication. */
'use strict';

/** Compone autenticación HTTP sin aceptar identidad ni permisos del cuerpo.
 * @param {Object} dependencies Autorización humana, RPC de Security y respuestas del gateway.
 * @returns {Function} Middleware compatible con las rutas existentes.
 */
function chatAuthorization({ authorization, messaging, response }) {
  /** Verifica el Bearer antes de aceptar archivos o ejecutar operaciones de agentes.
   * @param {Object} req Solicitud HTTP.
   * @param {Object} res Respuesta HTTP.
   * @param {Function} next Continuación autenticada.
   * @returns {Promise<*>} Resultado del siguiente middleware o rechazo público.
   */
  return async (req, res, next) => {
    if (req.get('X-Agent-Execution') !== '1')
      return authorization.authorizationValidation(req, res, next);
    await response.init(req);
    const token = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '')?.[1];
    if (!token) return response.sendError(req, res, 401, 'UNAUTHORIZED');
    try {
      const result = await messaging.request(
        'service-security',
        'agent-principal-authenticate',
        { token },
        { context: {} },
      );
      if (result.statusCode !== 200)
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      const principal = result.data?.principal;
      if (principal?.actorType !== 'agent' || principal.workspace !== req.get('Workspace'))
        return response.sendError(req, res, 403, 'FORBIDDEN');
      req.system = {
        user               : {
          userCode : principal.userCode,
          userType : 'agent',
        },
        workspace          : principal.workspace,
        policies           : principal.policies,
        actorType          : 'agent',
        agentCode          : principal.agentCode,
        runCode            : principal.runCode,
        agentAuthorization : { token },
      };
      return next();
    } catch {
      return response.sendError(req, res, 503, 'AGENT_AUTHENTICATION_UNAVAILABLE');
    }
  };
}

module.exports = { chatAuthorization };
