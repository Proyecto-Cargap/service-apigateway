/** @file Lectura pública explícita de Files administrado por un dominio. */
'use strict';
/**
 * Construye la transferencia de una versión pública de imagen o archivo.
 * @param {Object} dependencies Mensajería, temporales y respuesta HTTP.
 * @returns {Object} Router Express de lectura pública.
 */
module.exports = function filesStorageController({ messaging, temporaryFiles, response }) {
  const router = require('express').Router();
  router.get(
    '/files/public/v1/:fileId',

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      try {
        const result = await messaging.request('service-documents', 'files-storage-public-read', {
          fileId : req.params.fileId,
          size   : req.query.size || 'original',
        });
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        res.set({
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : result.data.mimeType,
          'Cache-Control'          : 'public, max-age=86400',
        });
        if (!result.data.mimeType.startsWith('image/'))
          return res.download(
            filename,
            result.data.fileName,

            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              void temporaryFiles.remove(filename);
            },
          );
        return res.sendFile(
          filename,

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
};
