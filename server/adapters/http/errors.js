/** @file Respuesta final de fallos HTTP, incluidos errores de parsing, sin stack ni mensajes externos. */
'use strict';
const response = require('./response');
/**
 * Ejecuta handleError dentro del flujo de errors.
 * @param {Error} error Fallo recibido por la continuación.
 * @param {Object} req Solicitud HTTP recibida por el middleware.
 * @param {Object} res Respuesta HTTP que completa la solicitud.
 * @param {Function} next Continuación de la cadena de middleware.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function handleError(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number(error?.status || error?.statusCode);
  return response.sendError(req, res, status >= 400 && status < 500 ? status : 500);
}
module.exports = { handleError };
