/** @file Identidad de sesión acreditada por Security sin compartir su esquema MongoDB. */
'use strict';
/**
 * Ejecuta sessionAuthentication dentro del flujo de session-authentication.
 * @param {Object} options Colaboradores u opciones: messaging, timeoutMs.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function sessionAuthentication({ messaging, timeoutMs = 8000 }) {
  return {
    /**
     * Ejecuta authenticate dentro del flujo de session-authentication.
     * @param {string} token Credencial que se valida sin incorporarla a la salida pública.
     * @param {Object} options Solicitud interna de políticas vigentes; nunca procede del cliente HTTP.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async authenticate(token, { currentPolicies = false } = {}) {
      let result;
      try {
        result = await messaging.request(
          'service-security',
          'session-authenticate',
          {
            token,
            refreshAccess : true,
            ...(currentPolicies ? { currentPolicies: true } : {}),
          },
          {
            timeoutMs,
            context : {},
          },
        );
      } catch (cause) {
        const error = new Error('SESSION_AUTHENTICATION_UNAVAILABLE', { cause });
        error.statusCode = 503;
        throw error;
      }
      if (result?.statusCode !== 200) {
        const error = new Error('SESSION_AUTHENTICATION_FAILED');
        error.statusCode = !result?.statusCode || result.statusCode >= 500 ? 503 : 401;
        throw error;
      }
      const value = result.data;
      if (currentPolicies && value?.currentPoliciesVerified !== true) {
        const error = new Error('CURRENT_POLICIES_UNAVAILABLE');
        error.statusCode = 503;
        throw error;
      }
      if (
        typeof value?.sessionId !== 'string' ||
        !value.sessionId ||
        typeof value.sessionCode !== 'string' ||
        !value.sessionCode ||
        typeof value.userCode !== 'string' ||
        !value.userCode ||
        typeof value.activeWorkspace !== 'string' ||
        !value.activeWorkspace ||
        value.activeWorkspace === 'allWorkspaces' ||
        !Array.isArray(value.workspaces) ||
        !value.workspaces.includes(value.activeWorkspace) ||
        !Array.isArray(value.policies) ||
        value.policies.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {*} x Valor de x utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (x) => typeof x !== 'string',
        ) ||
        !Number.isFinite(value.expiration) ||
        value.expiration <= Date.now() / 1000
      ) {
        const error = new Error('INVALID_SESSION_IDENTITY');
        error.statusCode = 401;
        throw error;
      }
      return value;
    },
  };
}
module.exports = { sessionAuthentication };
