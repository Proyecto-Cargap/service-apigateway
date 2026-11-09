/** @file Reutilización del principal recién acreditado exclusivamente dentro de una solicitud HTTP MCP. */
'use strict';
/** @param {Object} options Principal acreditado y resolución canónica para otro contexto.
 * @returns {Function} Resolución local a la solicitud; el productor vuelve a autorizar la operación.
 */
function requestPrincipal({ principal, resolve }) {
  /** @param {Object} data Concesión, cliente y workspace solicitados por el ejecutor.
   * @returns {Promise<Object>} Mismo principal sólo para el contexto exacto, sin caché global ni TTL.
   */
  return async function current(data) {
    if (
      data.grantCode === principal.grantCode &&
      data.clientId === principal.clientId &&
      (!data.workspace || data.workspace === principal.workspace)
    )
      return principal;
    return resolve(data);
  };
}
module.exports = { requestPrincipal };
