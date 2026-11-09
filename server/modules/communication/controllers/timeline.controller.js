/** @file HTTP genérico de Timeline: adapta referencias y cursores sin interpretar reglas del dominio propietario. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Transporte autenticado y respuestas del gateway. @returns {Object} Router de consultas, notas y recibos. */
function timelineController({ authorization, messaging, response, logger, temporaryFiles }) {
  const router = require('express').Router();
  router.get(
    '/communication/timeline/:code/author/picture',
    authorization.authorizationValidation,
    /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta privada.
     * @returns {Promise<void>} Transfiere únicamente una imagen del autor autorizado y retira el temporal. */
    async (req, res) => {
      let filename;
      /** @returns {void} Retira el temporal también al cancelar la descarga. */
      function cleanup() {
        if (!filename) return;
        const consumed = filename;
        filename = undefined;
        void temporaryFiles.remove(consumed);
      }
      res.once('finish', cleanup);
      res.once('close', cleanup);
      try {
        const result = await messaging.request(
          'service-communication',
          'timeline-author-picture-read',
          {
            ...req.query,
            code : req.params.code,
            size : req.query.size || '050',
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode !== 200) {
          response.sendError(req, res, result.statusCode, result.descriptionCode);
          return;
        }
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        if (res.destroyed || res.writableEnded) {
          cleanup();
          return;
        }
        if (!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(result.data.mimeType || ''))
          throw new Error('INVALID_IMAGE_MIME');
        res.set({
          'Cache-Control'          : 'private, no-store',
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : result.data.mimeType,
        });
        res.sendFile(
          filename,
          /** @param {Error} error Fallo de transferencia. @returns {void} Libera el temporal y conserva un error seguro. */
          (error) => {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'TIMELINE_PICTURE_UNAVAILABLE');
          },
        );
      } catch (error) {
        cleanup();
        if (!res.headersSent)
          response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'TIMELINE_PICTURE_UNAVAILABLE',
          );
      }
    },
  );
  for (const [method, path, action] of [
    ['get', '/communication/timeline', 'timeline-get-list'],
    ['get', '/communication/timeline/requests/:requestId', 'timeline-request-get'],
    ['get', '/communication/timeline/:code', 'timeline-get-one'],
    ['post', '/communication/timeline/notes', 'timeline-note-create'],
  ]) {
    router[method](
      path,
      authorization.authorizationValidation,
      /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Sobre estándar, sin aceptar contexto del cuerpo. */
      async (req, res) => {
        try {
          const input =
            method === 'post'
              ? req.body
              : {
                  ...req.query,
                  ...req.params,
                };
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new ApplicationError(400, 'INVALID_INPUT');
          const data = { ...input };
          if (action === 'timeline-get-list') {
            for (const field of ['subject', 'before'])
              if (typeof data[field] === 'string') {
                try {
                  data[field] = JSON.parse(data[field]);
                } catch {
                  throw new ApplicationError(400, 'INVALID_INPUT');
                }
              }
            for (const field of ['limit', 'dateFrom', 'dateTo'])
              if (typeof data[field] === 'string' && /^(0|[1-9][0-9]*)$/.test(data[field]))
                data[field] = Number(data[field]);
          }
          const result = await messaging.request('service-communication', action, data, {
            context : req.system,
          });
          if (result.statusCode >= 400)
            return response.sendError(req, res, result.statusCode, result.descriptionCode);
          return response.send(req, res, result.statusCode, result.data);
        } catch (error) {
          logger.error({
            component : 'timeline',
            event     : 'request_failed',
          });
          return response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'TIMELINE_UNAVAILABLE',
          );
        }
      },
    );
  }
  return router;
}
module.exports = { timelineController };
