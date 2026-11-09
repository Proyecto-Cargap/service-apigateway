/** @file Configuración explícita del recurso MCP; habilitarlo exige emisor HTTPS y claves propias. */
'use strict';
const tools = require('../../modules/mcp/contracts/mcp-tools.json');
/** @param {Object} env Variables inyectadas por composición. @returns {Object|null} Configuración válida o capacidad desactivada. */
function mcpConfig(env) {
  if (env.MCP_ENABLED !== 'true') return null;
  const resource = new URL(env.MCP_PUBLIC_URL),
    web          = new URL(env.MCP_WEB_ORIGIN);
  if (
    resource.protocol !== 'https:' ||
    resource.pathname !== '/mcp' ||
    resource.search ||
    resource.hash ||
    resource.username ||
    resource.password ||
    web.protocol !== 'https:' ||
    web.username ||
    web.password ||
    web.search ||
    web.hash ||
    web.pathname !== '/'
  )
    throw new Error('INVALID_MCP_PUBLIC_URL');
  const jwks   = JSON.parse(env.MCP_OAUTH_JWKS || '{}'),
    cookieKeys = JSON.parse(env.MCP_OAUTH_COOKIE_KEYS || '[]');
  if (
    !jwks.keys?.length ||
    !cookieKeys.length ||
    cookieKeys.some(
      /** @param {string} key Clave privada de cookies. @returns {boolean} Configuración insuficiente. */
      (key) => typeof key !== 'string' || key.length < 32,
    )
  )
    throw new Error('MCP_OAUTH_KEYS_REQUIRED');
  const extraOrigins = JSON.parse(env.MCP_ALLOWED_ORIGINS || '[]');
  if (
    !Array.isArray(extraOrigins) ||
    extraOrigins.some(
      /** @param {string} value Origen admitido. @returns {boolean} Rechaza comodines, rutas y credenciales. */
      (value) =>
        typeof value !== 'string' ||
        !value.startsWith('https://') ||
        new URL(value).origin !== value,
    )
  )
    throw new Error('INVALID_MCP_ALLOWED_ORIGINS');
  return {
    resource       : resource.href,
    issuer         : resource.origin + '/oauth',
    webOrigin      : web.origin,
    allowedOrigins : [...new Set([web.origin, ...extraOrigins])],
    jwks,
    cookieKeys,
    clients        : [],
    writesEnabled  : env.MCP_WRITES_ENABLED === 'true',
    scopes         : [
      ...new Set(
        tools.flatMap(
          /** @param {Object} tool Herramienta permitida. @returns {string[]} Capacidades mínimas. */
          (tool) => tool.scopes,
        ),
      ),
    ].sort(),
  };
}
module.exports = { mcpConfig };
