/** @file Lecturas correlacionadas de Communication, exclusivamente por la frontera HTTP autenticada. */
'use strict';
/** @param {Object} dependencies Autorización, transporte y respuesta del Gateway. @returns {Object} Router sin identidad derivada del cuerpo. */
function realtimeController({ authorization, messaging, response }) {
  const router = require('express').Router();
  router.post(
    '/communication/realtime/read',
    authorization.authorizationValidation,
    /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Datos y recibo del productor; no acepta un snapshot del navegador. */
    async (req, res) => {
      try {
        const result = await messaging.request('service-communication', 'realtime-read', req.body, {
          context : req.system,
        });
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        return response.send(req, res, 200, result.data);
      } catch (error) {
        return response.sendError(req, res, error.statusCode || 503, 'REALTIME_READ_UNAVAILABLE');
      }
    },
  );
  return router;
}
module.exports = { realtimeController };
