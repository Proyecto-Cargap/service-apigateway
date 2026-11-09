/** @file Adapta consultas autenticadas de catálogos fiscales, conservando errores y contexto. */
'use strict';
/** @param {Object} dependencies Transporte, autenticación y respuesta. @returns {Object} Router HTTP de lectura. */
function fiscalCatalogController({ messaging, authorization, response }) {
  const router = require('express').Router();
  router.get(
    '/directory/fiscal-catalog',
    authorization.authorizationValidation,
    /** @param {Object} req Solicitud. @param {Object} res Respuesta. @returns {Promise<*>} Resultado canónico. */
    async (req, res) => {
      try {
        const data = { ...req.query };
        for (const key of ['page', 'perPage'])
          if (typeof data[key] === 'string' && /^\d+$/.test(data[key]))
            data[key] = Number(data[key]);
        const result = await messaging.request(
          'service-directory',
          'fiscal-catalog-get-list',
          data,
          { context: req.system },
        );
        return result.statusCode >= 400
          ? response.sendError(req, res, result.statusCode, result.descriptionCode)
          : response.send(req, res, result.statusCode, result.data);
      } catch (error) {
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          error.descriptionCode || 'FISCAL_CATALOG_UNAVAILABLE',
        );
      }
    },
  );
  return router;
}
module.exports = { fiscalCatalogController };
