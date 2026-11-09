/** @file Emisor y audiencia JWT vinculados al proyecto, ambiente y propósito. */
'use strict';
const { runtimeIdentity } = require('./runtime-identity');
/**
 * Ejecuta jwtContext dentro del flujo de jwt-context.
 * @param {*} purpose Valor de purpose utilizado por esta operación.
 * @param {*} [env] Valor de env utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function jwtContext(purpose, env = process.env) {
  const { id, environment } = runtimeIdentity(env);
  if (
    !['session', 'account_confirmation', 'password_recovery', 'agent_execution'].includes(purpose)
  )
    throw new Error('INVALID_JWT_PURPOSE');
  return {
    issuer   : `urn:xidden:${id}:${environment}:security`,
    audience : `urn:xidden:${id}:${environment}:${purpose}`,
  };
}
module.exports = { jwtContext };
