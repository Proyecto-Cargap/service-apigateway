/** @file Rutas HTTP de gastos y transferencias privadas: sólo adapta transporte y propaga autorización. */
'use strict';
const { createHash }       = require('node:crypto');
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} options Router, registro canónico y dependencias del Gateway. @returns {void} Incorpora las capacidades de gastos. */
function mountExpenses({
  router,
  register,
  request,
  reply,
  authorization,
  temporaryFiles,
  response,
}) {
  for (const resource of ['expense', 'expense-payment', 'expense-category', 'cost-center']) {
    register('get', '/billing/' + resource, 'billing-' + resource + '-get-list');
    register('get', '/billing/' + resource + '/:code', 'billing-' + resource + '-get-one');
    register('post', '/billing/' + resource, 'billing-' + resource + '-create');
    if (resource !== 'expense-payment')
      register('patch', '/billing/' + resource + '/:code', 'billing-' + resource + '-update');
  }
  for (const action of ['confirm', 'cancel', 'discard', 'xml-preview', 'xml-apply'])
    register('post', '/billing/expense/:code/' + action, 'billing-expense-' + action);
  register('post', '/billing/expense-payment/:code/reverse', 'billing-expense-payment-reverse');
  const multipart = require('express-fileupload')({
    limits          : {
      fileSize : 20971520,
      files    : 1,
      fields   : 1,
    },
    abortOnLimit    : true,
    defParamCharset : 'utf8',
  });
  router.post(
    ['/billing/:resource/:code/attachments', '/billing/expense/import'],
    authorization.authorizationValidation,
    multipart,
    /** @param {Object} req Multipart autorizado. @param {Object} res Respuesta. @returns {Promise<void>} Referencia privada y limpieza incondicional del temporal HTTP. */
    async (req, res) => {
      let path;
      try {
        const importing = req.path === '/billing/expense/import';
        if (
          !req.is('multipart/form-data') ||
          (!importing && !['expense', 'expense-payment'].includes(req.params.resource))
        )
          throw new ApplicationError(400, 'INVALID_INPUT');
        const input = JSON.parse(req.body.input || '{}');
        if (
          !input ||
          Array.isArray(input) ||
          Object.keys(input).some(
            /** @param {string} key Campo recibido. @returns {boolean} Campo fuera de la captura pública. */
            (key) =>
              !(
                importing
                  ? [
                      'issuerCode',
                      'supplierCode',
                      'categoryCode',
                      'costCenterCode',
                      'projectCode',
                      'description',
                      'dueDate',
                      'notes',
                      'idempotencyKey',
                    ]
                  : ['revision', 'idempotencyKey', 'useXml']
              ).includes(key),
          )
        )
          throw new ApplicationError(400, 'INVALID_INPUT');
        const file = req.files?.file;
        if (!file || Array.isArray(file) || file.truncated)
          throw new ApplicationError(400, 'BILLING_FILE_REQUIRED');
        path = await temporaryFiles.createUpload(file);
        const data = {
          ...input,
          ...(!importing
            ? {
                resource : req.params.resource,
                code     : req.params.code,
                useXml   : input.useXml === true,
              }
            : {}),
          name         : file.name,
          byteLength   : file.size,
          sha256       : createHash('sha256').update(file.data).digest('hex'),
          tempFilePath : path,
        };
        return reply(
          req,
          res,
          await request(
            req,
            importing ? 'billing-expense-import-upload' : 'billing-expense-file-upload',
            data,
          ),
        );
      } catch (error) {
        return response.sendError(
          req,
          res,
          error.statusCode || 400,
          error.descriptionCode || 'BILLING_UPLOAD_FAILED',
        );
      } finally {
        if (path) await temporaryFiles.remove(path);
      }
    },
  );
  router.get(
    '/billing/:resource/:code/attachments/:fileId',
    authorization.authorizationValidation,
    /** @param {Object} req Archivo solicitado. @param {Object} res Transferencia. @returns {Promise<void>} Descarga privada con autorización de Billing. */
    async (req, res) => {
      let path;
      /** @returns {void} Retira el temporal al cerrar la conexión. */
      function cleanup() {
        if (path) {
          const owned = path;
          path = undefined;
          void temporaryFiles.remove(owned);
        }
      }
      res.once('close', cleanup);
      res.once('finish', cleanup);
      try {
        if (Object.keys(req.query).length) throw new ApplicationError(400, 'INVALID_INPUT');
        const result = await request(req, 'billing-expense-file-get', req.params);
        if (result.statusCode !== 200) return reply(req, res, result);
        path = await temporaryFiles.validate(result.data.tempFilePath);
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'private, no-store');
        res.type(result.data.mimeType);
        res.download(
          path,
          result.data.fileName,
          /** @param {Error|null} error Fallo de transferencia. @returns {void} Limpia sin exponer rutas internas. */
          (error) => {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'BILLING_DOWNLOAD_FAILED');
          },
        );
      } catch (error) {
        cleanup();
        if (!res.headersSent)
          response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'BILLING_DOWNLOAD_FAILED',
          );
      }
    },
  );
}
module.exports = { mountExpenses };
