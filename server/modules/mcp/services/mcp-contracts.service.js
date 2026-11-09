/** @file Carga de contratos públicos independientes con concurrencia acotada, sin identidades ni llamadas de negocio. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} options Servicios propietarios y RPC acreditado.
 * @returns {Promise<Object>} Catálogo completo; un fallo nunca publica una caché parcial.
 */
async function mcpContracts({ services, request }) {
  const pending   = [...new Set(services)];
  const contracts = {};
  /** @returns {Promise<void>} Consume productores independientes sin compartir transacciones de MongoDB. */
  async function worker() {
    while (pending.length) {
      const service = pending.shift();
      const result  = await request(service, 'service-contracts-get', {});
      if (result?.statusCode !== 200) throw new ApplicationError(503, 'MCP_CONTRACT_UNAVAILABLE');
      contracts[service] = result.data;
    }
  }
  const results = await Promise.allSettled([worker(), worker(), worker()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return contracts;
}
module.exports = { mcpContracts };
