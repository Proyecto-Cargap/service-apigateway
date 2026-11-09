/**
 * @file Registro HTTP de salud del proceso con disponibilidad de la base de datos, transporte e identidad
 * de versión.
 * Acredita el listener HTTP real sin cambiar el runtime común de mensajería.
 */
'use strict';
const health = require('../../library/messaging/health');

/**
 * Registra la salud técnica antes de iniciar el servicio y captura su release una vez.
 *
 * @param {Object} options Dependencias del proceso aplicativo.
 * @param {Object} options.messaging Fachada pública de mensajería con protocolo vigente.
 * @param {Object} options.connection Conexión MongoDB supervisada por el servicio.
 * @param {function(): import('node:http').Server|undefined} options.getListener Listener HTTP actual.
 * @param {string} options.releaseFile Archivo de identidad del artefacto instalado.
 * @returns {Function} Comprobación técnica compartida por RPC y telemetría.
 */
function registerHttpHealth({ messaging, connection, getListener, releaseFile }) {
  const identity   = health.captureIdentity(releaseFile);
  const definition = {
    name      : 'health-apigateway',
    version   : 1,
    execution : 'nonTransactional',
    retrySafe : true,
    /**
     * Añade la disponibilidad del listener HTTP a la salud técnica de base de datos y mensajería.
     * @returns {Promise<Object>} Objeto con statusCode, data.
     */
    handler   : async () => {
      const response = await health(connection, messaging, identity);
      const listener = getListener();
      const address  = listener?.address();
      const ready    =
        listener?.listening &&
        address &&
        typeof address === 'object' &&
        Number.isInteger(address.port) &&
        address.port >= 1 &&
        address.port <= 65535;
      const http     = ready ? 'ready' : 'unavailable';
      return {
        ...response,
        statusCode : response.statusCode === 200 && http === 'ready' ? 200 : 503,
        data       : {
          ...response.data,
          http,
        },
      };
    },
  };
  messaging.registerAction(definition);
  return definition.handler;
}

module.exports = { registerHttpHealth };
