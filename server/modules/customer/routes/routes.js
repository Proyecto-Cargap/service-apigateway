/** @file Frontera HTTP de Customer: contexto autenticado, rutas canónicas y delegación RPC sin reglas de negocio. */
'use strict';

/** Compone las rutas de los recursos de Customer.
 * @param {Object} dependencies Autorización, mensajería, respuesta y logger del gateway.
 * @returns {import('express').Router} Router canónico autenticado.
 */
function createRouter(dependencies) {
  const { authorization, messaging, response, logger } = dependencies;
  const pictureInput                                   = require('../../../shared/picture-upload.http')(dependencies);
  const router                                         = require('express').Router();
  router.use(
    require('../controllers/pipeline-picture.controller').pipelinePictureController(dependencies),
  );
  const { mergeRequest } = require('../../../shared/http-request');
  const resources        = {
    customer        : 'customerCode',
    'pipeline-type' : 'pipelineTypeCode',
    pipeline        : 'pipelineCode',
    opportunity     : 'opportunityCode',
    activity        : 'activityCode',
    settings        : 'settingsCode',
  };
  for (const [resource, key] of Object.entries(resources)) {
    const definitions =
      resource === 'settings'
        ? [
            ['get', '', 'get'],
            ['patch', '', 'update'],
          ]
        : [
            ['get', '', 'get-list'],
            ['get', '/:' + key, 'get-one'],
            ['post', '', 'create'],
            ['patch', '/:' + key, 'update'],
            ['delete', '/:' + key, 'delete'],
          ];
    if (resource === 'pipeline')
      definitions.unshift(
        ['post', '/:' + key + '/board', 'get-board'],
        ['get', '/:' + key + '/assignees', 'get-assignees'],
        ['get', '/:' + key + '/customers', 'get-customers'],
      );
    if (resource === 'opportunity') definitions.unshift(['get', '/summary', 'get-summary']);
    for (const [method, suffix, operation] of definitions) {
      router[method](
        '/customer/' + resource + suffix,
        authorization.authorizationValidation,
        ...(resource === 'customer' && ['create', 'update'].includes(operation)
          ? [pictureInput]
          : []),
        /** Adapta el sobre de negocio y conserva códigos públicos de errores.
         * @param {Object} req Solicitud autenticada.
         * @param {Object} res Respuesta Express.
         * @returns {Promise<*>} Respuesta HTTP canónica.
         */
        async (req, res) => {
          try {
            const data = mergeRequest(req);
            if (
              ['get-assignees', 'get-customers'].includes(operation) &&
              typeof data.codes === 'string'
            )
              data.codes = [...new Set(data.codes.split(','))];
            for (const field of ['page', 'perPage', 'expectedRevision'])
              if (typeof data[field] === 'string' && /^(0|[1-9][0-9]*)$/.test(data[field]))
                data[field] = Number(data[field]);
            const result = await messaging.request(
              'service-customer',
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
              component : 'customer',
              event     : 'request_failed',
            });
            return response.sendError(
              req,
              res,
              error.statusCode || 503,
              error.descriptionCode || 'CUSTOMER_UNAVAILABLE',
            );
          }
        },
      );
    }
  }
  router.use(
    require('../../../shared/enrollment.routes').enrollmentRoutes(dependencies, 'customer'),
  );
  return router;
}
module.exports = { createRouter };
