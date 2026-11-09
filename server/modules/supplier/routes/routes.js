/** @file Frontera HTTP de Supplier: contexto autenticado, rutas canónicas y delegación RPC sin reglas de negocio. */
'use strict';

/** Compone las rutas de los recursos de Supplier.
 * @param {Object} dependencies Autorización, mensajería, respuesta y logger del gateway.
 * @returns {import('express').Router} Router canónico autenticado.
 */
function createRouter(dependencies) {
  const { authorization, messaging, response, logger } = dependencies;
  const pictureInput                                   = require('../../../shared/picture-upload.http')(dependencies);
  const router                                         = require('express').Router();
  const { mergeRequest }                               = require('../../../shared/http-request');
  const resources                                      = { supplier: 'supplierCode' };
  for (const [resource, key] of Object.entries(resources)) {
    const definitions = [
      ['get', '', 'get-list'],
      ['get', '/:' + key, 'get-one'],
      ['post', '', 'create'],
      ['patch', '/:' + key, 'update'],
      ['delete', '/:' + key, 'delete'],
    ];
    for (const [method, suffix, operation] of definitions) {
      router[method](
        '/supplier/' + resource + suffix,
        authorization.authorizationValidation,
        ...(['create', 'update'].includes(operation) ? [pictureInput] : []),
        /** Adapta el sobre de negocio y conserva códigos públicos de errores.
         * @param {Object} req Solicitud autenticada.
         * @param {Object} res Respuesta Express.
         * @returns {Promise<*>} Respuesta HTTP canónica.
         */
        async (req, res) => {
          try {
            const data = mergeRequest(req);
            for (const field of ['page', 'perPage', 'expectedRevision'])
              if (typeof data[field] === 'string' && /^(0|[1-9][0-9]*)$/.test(data[field]))
                data[field] = Number(data[field]);
            const result = await messaging.request(
              'service-supplier',
              resource + '-' + operation,
              data,
              {
                context : req.system,
                ...(data.pictureUpload ? { timeoutMs: 310000 } : {}),
              },
            );
            if (result.statusCode >= 400)
              return response.sendError(req, res, result.statusCode, result.descriptionCode);
            return response.send(req, res, result.statusCode, result.data);
          } catch (error) {
            logger.error({
              component : 'supplier',
              event     : 'request_failed',
            });
            return response.sendError(
              req,
              res,
              error.statusCode || 503,
              error.descriptionCode || 'SUPPLIER_UNAVAILABLE',
            );
          }
        },
      );
    }
  }
  router.use(
    require('../../../shared/enrollment.routes').enrollmentRoutes(dependencies, 'supplier'),
  );
  return router;
}
module.exports = { createRouter };
