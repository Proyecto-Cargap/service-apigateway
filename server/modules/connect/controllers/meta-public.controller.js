/** @file Transporte público Meta: bytes exactos, límite previo y confirmación únicamente tras persistencia validada. */
'use strict';
const { ApplicationError }  = require('../../../shared/application-error');
const { readMetaChallenge } = require('../contracts/meta-http.contract');
/** Compone webhook y descarga temporal sin aceptar sesión ni contexto externo.
 * @param {Object} dependencies RPC, cifrado, respuestas y archivos privados.
 * @returns {Object} Router que debe montarse antes de cualquier parser JSON.
 */
function metaPublicController({ messaging, response, sealMetaCredentials, metaFiles }) {
  const express = require('express');
  const router  = express.Router();
  const base    = '/connect/meta/webhooks/:configurationCode';
  router.get(
    base,
    /** @param {Object} req Challenge Meta. @param {Object} res Respuesta plana exigida por Meta. @returns {Promise<*>} Challenge validado o rechazo. */
    async function verify(req, res) {
      res.set('Cache-Control', 'no-store');
      await response.init(req);
      try {
        const input  = readMetaChallenge(req.query);
        const sealed = sealMetaCredentials({ verifyToken: input.verifyToken }, ['verifyToken']);
        const result = await messaging.request(
          'service-connect',
          'meta-webhook-verify',
          {
            configurationCode : req.params.configurationCode,
            mode              : input.mode,
            challenge         : input.challenge,
            verifyToken       : sealed.verifyToken,
          },
          {
            context   : {},
            timeoutMs : 15000,
          },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        return res.status(200).type('text/plain').send(result.data.challenge);
      } catch (error) {
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          error.descriptionCode || 'META_UNAVAILABLE',
        );
      }
    },
  );
  router.post(
    base,
    express.raw({
      type    : '*/*',
      limit   : '4mb',
      inflate : false,
    }),
    /** @param {Object} req Cuerpo binario sin reserialización. @param {Object} res Acuse. @returns {Promise<*>} Sólo confirma la respuesta durable de Connect. */
    async function ingest(req, res) {
      res.set('Cache-Control', 'no-store');
      await response.init(req);
      try {
        const signature = req.get('X-Hub-Signature-256');
        if (
          !Buffer.isBuffer(req.body) ||
          !req.body.length ||
          !/^sha256=[a-fA-F0-9]{64}$/.test(signature || '') ||
          Object.keys(req.query).length
        )
          throw new ApplicationError(400, 'META_INVALID_WEBHOOK');
        const result = await messaging.request(
          'service-connect',
          'meta-webhook-ingest',
          {
            configurationCode : req.params.configurationCode,
            signature,
            rawBody           : req.body.toString('base64'),
          },
          {
            context   : {},
            timeoutMs : 15000,
          },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        return res.status(200).type('text/plain').send('EVENT_RECEIVED');
      } catch (error) {
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          error.descriptionCode || 'META_UNAVAILABLE',
        );
      }
    },
  );
  router.get(
    '/connect/meta/media/:deliveryCode/:token',
    /** @param {Object} req Capacidad temporal de un delivery. @param {Object} res Bytes privados. @returns {Promise<*>} Descarga validada y limpieza al terminar. */
    async function media(req, res) {
      await response.init(req);
      let filename;
      /** @returns {void} Retira sólo el temporal autorizado de esta descarga. */
      function cleanup() {
        if (filename) {
          const file = filename;
          filename = undefined;
          void metaFiles.remove(file);
        }
      }
      res.once('finish', cleanup);
      res.once('close', cleanup);
      try {
        if (Object.keys(req.query).length) throw new ApplicationError(400, 'INVALID_INPUT');
        const sealed = sealMetaCredentials({ mediaToken: req.params.token }, ['mediaToken']);
        const result = await messaging.request(
          'service-connect',
          'meta-media-get',
          {
            deliveryCode : req.params.deliveryCode,
            token        : sealed.mediaToken,
          },
          {
            context   : {},
            timeoutMs : 120000,
          },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        const file = await metaFiles.download(result.data);
        filename = file.tempFilePath;
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.set({
          'Cache-Control'          : 'private, no-store',
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : file.mime,
        });
        return res.sendFile(
          filename,
          /** @param {Error|null} error Fallo de transferencia. @returns {void} Retira temporal y evita respuesta doble. */
          function complete(error) {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'META_MEDIA_UNAVAILABLE');
          },
        );
      } catch (error) {
        cleanup();
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          error.descriptionCode || 'META_MEDIA_UNAVAILABLE',
        );
      }
    },
  );
  return router;
}
module.exports = { metaPublicController };
