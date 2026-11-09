/** @file Búsqueda HTTP del directorio canónico de identidades; autorización y proyección pertenecen a Security. */
'use strict';

/** Compone una ruta genérica de búsqueda de identidades autorizadas.
 * @param {Object} dependencies Capacidades del gateway.
 * @returns {import('express').Router} Router autenticado.
 */
function identityDirectoryController({ authorization, messaging, response }) {
  const router = require('express').Router();
  router.get(
    '/security/user/directory',
    authorization.authorizationValidation,
    /** @param {Object} req Solicitud con contexto verificado. @param {Object} res Respuesta HTTP. @returns {Promise<*>} Resultado canónico de Security. */
    async (req, res) => {
      try {
        const data = { ...req.query };
        if (typeof data.codes === 'string') data.codes = data.codes.split(',');
        const result = await messaging.request(
          'service-security',
          'user-directory-get-list',
          data,
          { context: req.system },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        return response.send(req, res, 200, result.data);
      } catch (error) {
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          'IDENTITY_DIRECTORY_UNAVAILABLE',
        );
      }
    },
  );
  return router;
}
module.exports = { identityDirectoryController };
