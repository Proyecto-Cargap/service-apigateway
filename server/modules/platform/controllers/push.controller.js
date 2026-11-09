/** @file Registro HTTP de instalaciones push; la identidad procede exclusivamente de la sesión. */
'use strict';
/**
 * Construye la ruta autenticada de registro sin incorporar SDK del proveedor al gateway.
 * @param {Object} dependencies Autorización, transporte interno y adaptación HTTP.
 * @returns {Object} Router Express del registro de dispositivo.
 */
function pushController({ authorization, messaging, response }) {
  const router = require('express').Router();
  router.put(
    '/platform/push/devices/:installationId',
    authorization.authorizationValidation,
    /** Envía el cuerpo al DTO cerrado sin mezclarlo con identidad o permisos del cliente.
     * @param {Object} req Solicitud HTTP con contexto acreditado.
     * @param {Object} res Respuesta HTTP que no almacena datos en caché.
     * @returns {Promise<Object>} Respuesta 200, rechazo de dominio o indisponibilidad 503.
     */
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await messaging.request(
          'service-platform',
          'push-device-register',
          {
            ...req.body,
            installationId : req.params.installationId,
          },
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'PUSH_UNAVAILABLE');
      }
    },
  );
  return router;
}
module.exports = { pushController };
