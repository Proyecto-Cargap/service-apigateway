/** @file API HTTP de Communication con identidad del servidor y transferencia privada de archivos. */
'use strict';
/**
 * Construye rutas propias de chat antes del parser general de Documents.
 * @param {Object} dependencies Mensajería, autorización, temporales, entorno y respuestas.
 * @returns {Object} Router Express autenticado del dominio Communication.
 */
function chatController({
  messaging,
  authorization,
  response,
  temporaryFiles,
  fileUpload = require('express-fileupload'),
}) {
  const router       = require('express').Router();
  const base         = '/communication/chat';
  const authenticate = require('./chat-authorization').chatAuthorization({
    authorization,
    messaging,
    response,
  });
  /**
   * Conserva estados y códigos de negocio sin exponer excepciones internas.
   * @param {*} req Solicitud HTTP autenticada.
   * @param {*} res Respuesta HTTP del gateway.
   * @param {*} result Resultado del caso de uso o transporte.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  function reply(req, res, result) {
    res.set('Cache-Control', 'no-store');
    return result.statusCode >= 200 && result.statusCode < 300
      ? response.send(req, res, result.statusCode, result.data)
      : response.sendError(req, res, result.statusCode, result.descriptionCode);
  }
  /** Transfiere una imagen privada tras autorizar conversación y remitente en Communication. */
  router.get(
    [
      base + '/conversations/:code/senders/:userCode/picture',
      base + '/conversations/:code/picture',
    ],
    authenticate,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      /** Libera el temporal también cuando el navegador cancela la transferencia.
       * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      const cleanup = () => {
        if (!filename) return;
        const consumed = filename;
        filename = undefined;
        void temporaryFiles.remove(consumed);
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);
      try {
        const result = await messaging.request(
          'service-communication',
          req.params.userCode ? 'chat-sender-picture-read' : 'chat-group-picture-read',
          {
            code : req.params.code,
            ...(req.params.userCode ? { userCode: req.params.userCode } : {}),
            size : req.query.size || '050',
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode !== 200) return reply(req, res, result);
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
        res.once('finish', cleanup);
        res.once('close', cleanup);
        return res.sendFile(
          filename,

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'CHAT_PICTURE_UNAVAILABLE');
          },
        );
      } catch {
        cleanup();
        return response.sendError(req, res, 503, 'CHAT_PICTURE_UNAVAILABLE');
      }
    },
  );
  router.put(
    base + '/conversations/:code/picture',
    authenticate,
    require('../../../shared/picture-upload.http')({
      temporaryFiles,
      fileUpload,
      response,
    }),
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        return reply(
          req,
          res,
          await messaging.request(
            'service-communication',
            'chat-group-picture-update',
            {
              expectedPictureVersion : req.body.expectedPictureVersion,
              ...(req.system?.actorType === 'agent'
                ? { sourceBindings: req.body.sourceBindings || [] }
                : {}),
              pictureUpload          : req.body.pictureUpload,
              code                   : req.params.code,
            },
            {
              context   : req.system,
              timeoutMs : 310000,
            },
          ),
        );
      } catch {
        return response.sendError(req, res, 503, 'CHAT_PICTURE_UNCERTAIN');
      }
    },
  );
  const routes = [
    ['get', '/users', 'chat-participants-get-list'],
    ['get', '/unread', 'chat-unread-count'],
    ['get', '/conversations', 'chat-get-list'],
    ['post', '/conversations', 'chat-create'],
    ['get', '/conversations/:code/contact-profile', 'chat-contact-profile-get'],
    ['get', '/conversations/:code/messages', 'chat-messages-get-list'],
    ['post', '/conversations/:code/messages', 'chat-send'],
    ['post', '/conversations/:code/products', 'chat-product-send'],
    ['post', '/conversations/:code/quotations', 'chat-quotation-send'],
    ['patch', '/conversations/:code/read', 'chat-messages-mark-read'],
    ['patch', '/conversations/:code', 'chat-update'],
    ['get', '/conversations/:code', 'chat-get-one'],
  ];
  for (const [method, suffix, operation] of routes) {
    router[method](
      base + suffix,
      authenticate,

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @param {Object} res Respuesta HTTP que completa la solicitud.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (req, res) => {
        try {
          return reply(
            req,
            res,
            await messaging.request(
              'service-communication',
              operation,
              {
                ...req.query,
                ...req.body,
                ...req.params,
              },
              {
                context : req.system,
                ...(['chat-product-send', 'chat-quotation-send'].includes(operation)
                  ? { timeoutMs: 310000 }
                  : {}),
              },
            ),
          );
        } catch {
          return response.sendError(req, res, 503, 'CHAT_UNAVAILABLE');
        }
      },
    );
  }
  /** Prepara multipart privado después de acreditar identidad; preserva temporales de efectos inciertos.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function prepareUpload(req, res, next) {
    try {
      const directory = await temporaryFiles.prepareMultipart('communication-uploads');
      return fileUpload({
        useTempFiles    : true,
        tempFileDir     : directory,
        limits          : {
          fileSize : 200 * 1024 * 1024,
          files    : 1,
          fields   : 2,
        },
        abortOnLimit    : true,
        defParamCharset : 'utf8',
        uploadTimeout   : 300000,
      })(req, res, next);
    } catch {
      return response.sendError(req, res, 503, 'CHAT_STORAGE_UNAVAILABLE');
    }
  }
  const uploadPath = `${base}/conversations/:code/attachments`;
  router.post(
    uploadPath,
    authenticate,
    prepareUpload,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      try {
        const file = req.files?.file;
        if (!file || Array.isArray(file) || file.truncated || !file.size)
          return response.sendError(req, res, 400, 'CHAT_INVALID_FILE');
        filename = await temporaryFiles.validate(file.tempFilePath);
        await temporaryFiles.restrict(filename);
        const result = await messaging.request(
          'service-communication',
          'chat-upload',
          {
            code         : req.params.code,
            requestId    : req.body.requestId,
            name         : file.name,
            size         : file.size,
            tempFilePath : filename,
            ...(req.system?.actorType === 'agent'
              ? {
                  digest         : await temporaryFiles.digest(filename),
                  sourceBindings : JSON.parse(req.body.sourceBindings || '[]'),
                }
              : {}),
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode < 500) await temporaryFiles.remove(filename);
        return reply(req, res, result);
      } catch {
        return response.sendError(req, res, 503, 'CHAT_UPLOAD_UNCERTAIN');
      }
    },
  );
  /** Entrega una miniatura privada y retira el temporal incluso si el cliente abandona la solicitud. */
  router.get(
    `${uploadPath}/:attachmentCode/preview`,
    authenticate,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      /** Retira una sola vez el temporal validado, sin conservar imágenes de peticiones cerradas.
       * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      const cleanup = () => {
        if (!filename) return;
        const consumed = filename;
        filename = undefined;
        void temporaryFiles.remove(consumed);
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);
      try {
        const result = await messaging.request(
          'service-communication',
          'chat-preview',
          {
            code           : req.params.code,
            attachmentCode : req.params.attachmentCode,
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode !== 200) {
          if (!res.destroyed) return reply(req, res, result);
          return;
        }
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        if (res.destroyed || res.writableEnded) {
          cleanup();
          return;
        }
        if (result.data.mime !== 'image/webp') throw new Error('INVALID_IMAGE_MIME');
        res.set({
          'Cache-Control'          : 'private, no-store',
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : 'image/webp',
        });
        return res.sendFile(
          filename,

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            cleanup();
            if (error && !res.headersSent && !res.destroyed)
              response.sendError(req, res, 503, 'CHAT_PREVIEW_UNAVAILABLE');
          },
        );
      } catch {
        cleanup();
        if (!res.headersSent && !res.destroyed)
          return response.sendError(req, res, 503, 'CHAT_PREVIEW_UNAVAILABLE');
      }
    },
  );
  router.get(
    `${uploadPath}/:attachmentCode`,
    authenticate,
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
          'service-communication',
          'chat-download',
          req.params,
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
        if (result.statusCode !== 200) return reply(req, res, result);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        res.set({
          'Cache-Control'          : 'no-store',
          'X-Content-Type-Options' : 'nosniff',
          'Content-Type'           : result.data.mime,
        });
        return res.download(
          filename,
          result.data.name,

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            void temporaryFiles.remove(filename);
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'CHAT_DOWNLOAD_FAILED');
          },
        );
      } catch {
        if (filename) await temporaryFiles.remove(filename);
        return response.sendError(req, res, 503, 'CHAT_DOWNLOAD_FAILED');
      }
    },
  );
  /** Extrae sólo el Bearer de la cabecera; el cuerpo nunca elige identidad.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function agentToken(req) {
    const header = req.get('Authorization') || '';
    return /^Bearer [^\s]+$/i.test(header) && header.length <= 16400 ? header.slice(7) : null;
  }
  const agentUploadPath = '/communication/agents/conversations/:code/attachments';
  router.post(
    agentUploadPath,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @param {Function} next Continuación de la cadena de middleware.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res, next) => {
      await response.init(req);
      const token = agentToken(req);
      if (!token) return response.sendError(req, res, 401, 'UNAUTHORIZED');
      try {
        const result = await messaging.request(
          'service-communication',
          'agent-chat-upload-authorize',
          {
            code : req.params.code,
            token,
          },
          { context: {} },
        );
        if (result.statusCode !== 200) return reply(req, res, result);
        req.agentExecutionToken = token;
        return next();
      } catch {
        return response.sendError(req, res, 503, 'CHAT_UNAVAILABLE');
      }
    },
    prepareUpload,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      try {
        const file = req.files?.file;
        if (!file || Array.isArray(file) || file.truncated || !file.size)
          return response.sendError(req, res, 400, 'CHAT_INVALID_FILE');
        filename = await temporaryFiles.validate(file.tempFilePath);
        if (
          Object.keys(req.body || {}).some(
            /**
             * Comprueba si el elemento satisface la condición.
             * @param {string} key Clave del campo o recurso que se procesa.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (key) => key !== 'requestId',
          )
        ) {
          await temporaryFiles.remove(filename);
          return response.sendError(req, res, 400, 'CHAT_INVALID_FILE');
        }
        await temporaryFiles.restrict(filename);
        const digest = await temporaryFiles.digest(filename);
        const result = await messaging.request(
          'service-communication',
          'agent-chat-upload',
          {
            code         : req.params.code,
            token        : req.agentExecutionToken,
            requestId    : req.body.requestId,
            name         : file.name,
            size         : file.size,
            tempFilePath : filename,
            digest,
          },
          {
            context   : {},
            timeoutMs : 310000,
          },
        );
        if (result.statusCode < 500) await temporaryFiles.remove(filename);
        return reply(req, res, result);
      } catch {
        return response.sendError(req, res, 503, 'CHAT_UPLOAD_UNCERTAIN');
      }
    },
  );
  router.get(
    `${agentUploadPath}/status`,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      await response.init(req);
      const token = agentToken(req);
      if (!token) return response.sendError(req, res, 401, 'UNAUTHORIZED');
      try {
        return reply(
          req,
          res,
          await messaging.request(
            'service-communication',
            'agent-chat-upload-status',
            {
              code      : req.params.code,
              requestId : req.query.requestId,
              token,
            },
            { context: {} },
          ),
        );
      } catch {
        return response.sendError(req, res, 503, 'CHAT_UPLOAD_STATUS_UNAVAILABLE');
      }
    },
  );
  /**
   * Transfiere bytes al agente remoto tras autorizarlo en Communication y Security.
   * @param {Object} req Ruta de adjunto y Bearer breve de ejecución.
   * @param {Object} res Descarga privada; nunca revela temporales ni referencias S3.
   * @returns {Promise<*>} Transferencia o error de identidad/membresía.
   */
  async function agentDownload(req, res) {
    await response.init(req);
    let filename;
    try {
      const header = req.get('Authorization') || '';
      if (!/^Bearer [^\s]+$/i.test(header) || header.length > 16400)
        return response.sendError(req, res, 401, 'UNAUTHORIZED');
      const result = await messaging.request(
        'service-communication',
        'agent-chat-download',
        {
          code           : req.params.code,
          attachmentCode : req.params.attachmentCode,
          token          : header.slice(7),
        },
        {
          context   : {},
          timeoutMs : 310000,
        },
      );
      if (result.statusCode !== 200) return reply(req, res, result);
      filename = await temporaryFiles.validate(result.data.tempFilePath);
      res.set({
        'Cache-Control'          : 'private, no-store',
        'X-Content-Type-Options' : 'nosniff',
        'Content-Type'           : result.data.mime,
      });
      /**
       * Ejecuta cleanup dentro del flujo de chat.controller.
       * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      const cleanup = () => {
        if (!filename) return;
        const consumed = filename;
        filename = undefined;
        void temporaryFiles.remove(consumed);
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);
      return res.download(
        filename,
        result.data.name,

        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Error} error Fallo recibido por la continuación.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        (error) => {
          cleanup();
          if (error && !res.headersSent) response.sendError(req, res, 503, 'CHAT_DOWNLOAD_FAILED');
        },
      );
    } catch {
      if (filename) await temporaryFiles.remove(filename);
      return response.sendError(req, res, 503, 'CHAT_DOWNLOAD_FAILED');
    }
  }
  router.get(
    '/communication/agents/conversations/:code/attachments/:attachmentCode',
    agentDownload,
  );
  return router;
}
module.exports = { chatController };
