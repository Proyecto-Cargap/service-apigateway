/** @file API personal de correo con contratos cerrados, credenciales selladas y transferencia privada. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Autorización, RPC, temporales y sobres HTTP. @returns {Object} Router autenticado; nunca acepta selectores de propietario. */
function mailboxController({
  messaging,
  authorization,
  response,
  temporaryFiles,
  fileUpload = require('express-fileupload'),
}) {
  const router = require('express').Router();
  const base   = '/connect/mailbox';
  router.use(base, authorization.authorizationValidation, noCache);
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Evita cachear correo privado. */
  function noCache(req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
  }
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Object} result Sobre RPC. @returns {*} Respuesta saneada. */
  function reply(req, res, result) {
    return result.statusCode === 200
      ? response.send(req, res, 200, result.data)
      : response.sendError(req, res, result.statusCode, result.descriptionCode);
  }
  const routes = [
    ['get', '/status', 'status-get'],
    ['post', '/sync', 'sync'],
    ['get', '/messages', 'messages-list'],
    ['get', '/messages/:id', 'message-read'],
    ['patch', '/messages/:id', 'message-change'],
    ['put', '/drafts', 'draft-save'],
    ['get', '/drafts/recovery/:id', 'draft-recover'],
    ['post', '/send', 'send'],
    ['get', '/operations/:id', 'operation-get'],
    ['get', '/operations', 'operations-list'],
  ];
  for (const [method, path, action] of routes)
    router[method](
      base + path,
      /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta. @returns {Promise<*>} Contrato RPC validado por Connect. */
      async function handle(req, res) {
        try {
          if (
            Object.keys(req.query || {}).length &&
            !['messages-list', 'operations-list'].includes(action)
          )
            return response.sendError(req, res, 400, 'INVALID_INPUT');
          if (method === 'get' && Object.keys(req.body || {}).length)
            return response.sendError(req, res, 400, 'INVALID_INPUT');
          let input = {
            ...(['messages-list', 'operations-list'].includes(action) ? req.query : req.body),
            ...req.params,
          };
          if (Object.hasOwn(req.body || {}, 'id') && req.params.id)
            return response.sendError(req, res, 400, 'INVALID_INPUT');
          if (action === 'operations-list') {
            if (
              Object.keys(input).some(
                /** @param {string} key Parámetro. @returns {boolean} Rechaza selectores distintos de la página. */ (
                  key,
                ) => key !== 'page',
              ) ||
              (input.page !== undefined &&
                (typeof input.page !== 'string' || !/^\d+$/.test(input.page)))
            )
              throw new ApplicationError(400, 'INVALID_INPUT');
            input.page = input.page === undefined ? 1 : Number(input.page);
          }
          if (action === 'messages-list') {
            for (const [key, value] of Object.entries(input)) {
              if (
                !['folder', 'search', 'page', 'perPage'].includes(key) ||
                typeof value !== 'string'
              )
                throw new ApplicationError(400, 'INVALID_INPUT');
              if (
                ['page', 'perPage'].includes(key) &&
                (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
              )
                throw new ApplicationError(400, 'INVALID_PAGINATION');
            }
            input.page = input.page === undefined ? 1 : Number(input.page);
            input.perPage = input.perPage === undefined ? 20 : Number(input.perPage);
          }
          const result = await messaging.request('service-connect', `mailbox-${action}`, input, {
            context   : req.system,
            timeoutMs : 120000,
          });
          return reply(req, res, result);
        } catch (error) {
          if (error instanceof ApplicationError)
            return response.sendError(req, res, error.statusCode, error.descriptionCode);
          return response.sendError(req, res, 503, 'MAILBOX_UNAVAILABLE');
        }
      },
    );
  router.post(
    base + '/attachments',
    prepareUpload,
    /** @param {Object} req Carga autenticada. @param {Object} res Respuesta. @returns {Promise<*>} Referencia privada del adjunto. */
    async function upload(req, res) {
      let filename;
      try {
        const file = req.files?.file;
        if (
          !file ||
          Array.isArray(file) ||
          file.truncated ||
          Object.keys(req.body || {}).length ||
          Object.keys(req.query || {}).length
        )
          return response.sendError(req, res, 400, 'MAILBOX_FILE_INVALID');
        filename = await temporaryFiles.validate(file.tempFilePath);
        await temporaryFiles.restrict(filename);
        const result = await messaging.request(
          'service-connect',
          'mailbox-attachment-upload',
          {
            tempFilePath : filename,
            name         : file.name,
            size         : file.size,
          },
          {
            context   : req.system,
            timeoutMs : 120000,
          },
        );
        if (result.statusCode < 500) await temporaryFiles.remove(filename);
        return reply(req, res, result);
      } catch {
        return response.sendError(req, res, 503, 'MAILBOX_ATTACHMENT_UNAVAILABLE');
      }
    },
  );
  router.get(
    base + '/attachments/:id',
    /** @param {Object} req Identidad del adjunto. @param {Object} res Respuesta binaria. @returns {Promise<*>} Descarga sin rutas públicas ni URLs firmadas persistentes. */
    async function download(req, res) {
      let filename;
      /** @returns {void} Retira sólo el temporal de esta transferencia. */
      function cleanup() {
        if (filename) {
          const consumed = filename;
          filename = undefined;
          void temporaryFiles.remove(consumed);
        }
      }
      res.once('finish', cleanup);
      res.once('close', cleanup);
      try {
        if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length)
          return response.sendError(req, res, 400, 'INVALID_INPUT');
        const result = await messaging.request(
          'service-connect',
          'mailbox-attachment-download',
          { id: req.params.id },
          {
            context   : req.system,
            timeoutMs : 120000,
          },
        );
        if (result.statusCode !== 200) return reply(req, res, result);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.set('X-Content-Type-Options', 'nosniff');
        res.type(result.data.mime);
        return res.download(
          filename,
          result.data
            .name /** @param {Error|null} error Fallo de transferencia. @returns {void} Limpia el temporal y comunica un fallo antes de enviar cabeceras. */,
          function transferred(error) {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'MAILBOX_DOWNLOAD_FAILED');
          },
        );
      } catch {
        cleanup();
        return response.sendError(req, res, 503, 'MAILBOX_ATTACHMENT_UNAVAILABLE');
      }
    },
  );
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Promise<*>} Multipart limitado después de autenticar. */
  async function prepareUpload(req, res, next) {
    try {
      const directory = await temporaryFiles.prepareMultipart('mailbox-uploads');
      return fileUpload({
        useTempFiles    : true,
        tempFileDir     : directory,
        limits          : {
          fileSize : 20 * 1024 * 1024,
          files    : 1,
          fields   : 0,
        },
        abortOnLimit    : true,
        defParamCharset : 'utf8',
        uploadTimeout   : 120000,
      })(req, res, next);
    } catch {
      return response.sendError(req, res, 503, 'MAILBOX_STORAGE_UNAVAILABLE');
    }
  }
  return router;
}
module.exports = { mailboxController };
