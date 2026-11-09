/** @file Transporte privado de fotos de responsables; Customer acredita el acceso antes de transferir archivos. */
'use strict';
/** @param {Object} dependencies Mensajería, autenticación y temporales administrados. @returns {import('express').Router} Ruta binaria con limpieza y caché privada. */
function pipelinePictureController({ messaging, response, authorization, temporaryFiles }) {
  const router = require('express').Router();
  router.get(
    '/customer/pipeline/:pipelineCode/assignees/:userCode/picture',
    authorization.authorizationValidation,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      try {
        const result = await messaging.request(
          'service-customer',
          'pipeline-get-assignee-picture',
          {
            pipelineCode : req.params.pipelineCode,
            userCode     : req.params.userCode,
            size         : req.query.size || '050',
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        res.set({
          'Cache-Control'          : 'private, no-cache',
          Vary                     : 'Authorization',
          ETag                     : await temporaryFiles.etag(filename, [
            req.system.user?.userCode,
            req.system.workspace,
            req.params.pipelineCode,
            req.params.userCode,
            req.query.size || '050',
          ]),
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : result.data.mimeType,
        });
        if (req.fresh) {
          await temporaryFiles.remove(filename);
          return res.status(304).end();
        }
        return res.sendFile(
          filename,
          {
            cacheControl : false,
            lastModified : false,
          },

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            void temporaryFiles.remove(filename);
            if (error && !res.headersSent) response.sendError(req, res, 503, 'FILE_READ_FAILED');
          },
        );
      } catch {
        if (filename) await temporaryFiles.remove(filename);
        return response.sendError(req, res, 503, 'FILE_READ_FAILED');
      }
    },
  );
  return router;
}
module.exports = { pipelinePictureController };
