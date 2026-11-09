/** @file Rutas del centro Platform; la bandeja personal nunca selecciona identidades ni scopes del cliente. */
'use strict';
/**
 * Construye rutas autenticadas antes de los parámetros genéricos de notificaciones.
 * @param {Object} dependencies Mensajería, respuestas, autorización y logger.
 * @returns {import('express').Router} Rutas HTTP personales, administrativas y de difusión.
 */
function notificationsController({ messaging, response, authorization, logger, temporaryFiles }) {
  const router = require('express').Router();
  const base   = '/platform/notifications';
  /** Usa el mismo traslado y limpieza de Files que las imágenes privadas de Directory. */
  router.get(
    base + '/me/:code/sender/picture',
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
          'service-platform',
          'notifications-center-personal-sender-picture',
          {
            code      : req.params.code,
            workspace : req.query.workspace,
            size      : req.query.size || '100',
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
            req.params.code,
            req.query.workspace,
            req.query.size || '100',
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
  for (const [method, operation] of [
    ['get', 'get'],
    ['patch', 'update'],
  ]) {
    router[method](
      base + '/support-preferences',
      authorization.authorizationValidation,
      /** @param {Object} req Sesión y preferencias. @param {Object} res Respuesta HTTP. @returns {Promise<void>} Configuración de la cuenta autenticada. */
      async (req, res) => {
        try {
          res.set('Cache-Control', 'no-store');
          const result = await messaging.request(
            'service-platform',
            'notifications-support-preferences-' + operation,
            operation === 'get' ? {} : req.body,
            { context: req.system },
          );
          if (result.statusCode >= 400)
            return response.sendError(req, res, result.statusCode, result.descriptionCode);
          return response.send(req, res, result.statusCode, result.data);
        } catch {
          return response.sendError(req, res, 503, 'NOTIFICATION_UNAVAILABLE');
        }
      },
    );
  }
  const routes = [
    ['get', '/me/count', 'personalCount'],
    ['patch', '/me/view', 'personalViewAll'],
    ['delete', '/me/viewed', 'personalDeleteViewed'],
    ['patch', '/me/:code/view', 'personalView'],
    ['get', '/me/:code', 'personalOne'],
    ['delete', '/me/:code', 'personalDelete'],
    ['get', '/me', 'personalList'],
    ['post', '/broadcasts/preview', 'preview'],
    ['post', '/broadcasts/:code/confirm', 'confirm'],
    ['post', '/broadcasts/:code/retry', 'retry'],
    ['get', '/broadcasts/:code', 'status'],
    ['get', '/broadcasts', 'broadcasts'],
    ['get', '/:code', 'adminOne'],
    ['delete', '/:code', 'adminDelete'],
    ['get', '', 'adminList'],
  ];
  for (const [method, suffix, operation] of routes) {
    router[method](
      base + suffix,
      authorization.authorizationValidation,

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @param {Object} res Respuesta HTTP que completa la solicitud.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (req, res) => {
        try {
          res.set('Cache-Control', 'no-store');
          const data = {
            ...req.query,
            ...req.body,
            ...req.params,
          };
          if (operation.startsWith('personal')) {
            delete data.scope;
            delete data.userCode;
            delete data.userAssigned;
          }
          const result = await messaging.request(
            'service-platform',
            `notifications-center-${operation}`,
            data,
            { context: req.system },
          );
          if (result.statusCode >= 400)
            return response.sendError(
              req,
              res,
              result.statusCode,
              result.descriptionCode,
              result.data,
            );
          return response.send(req, res, result.statusCode, result.data);
        } catch {
          logger.error({
            component : 'notifications',
            event     : 'request_failed',
          });
          return response.sendError(req, res, 503, 'NOTIFICATION_UNAVAILABLE');
        }
      },
    );
  }
  return router;
}
module.exports = { notificationsController };
