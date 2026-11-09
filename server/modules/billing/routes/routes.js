/** @file Frontera HTTP de facturación: autenticación, custodia de secretos, RPC y transferencias binarias. */
'use strict';
const { mergeRequest }     = require('../../../shared/http-request');
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Transporte, autenticación, respuesta y temporales de plataforma. @returns {Object} Router autenticado sin reglas fiscales propias. */
function createRouter(dependencies) {
  const { messaging, authorization, response, temporaryFiles } = dependencies;
  const router = require('express').Router(),
    seal       =
      dependencies.billingCredentials ||
      require('../../../adapters/crypto/billing-request-credentials').billingRequestCredentials(
        process.env.BILLING_ENCRYPTION_KEY,
      );
  /** @param {Object} req Solicitud autenticada. @param {string} action Operación RPC. @param {Object} data Datos. @returns {Promise<Object>} Respuesta canónica con contexto propagado. */
  async function request(req, action, data) {
    return messaging.request('service-billing', action, data, {
      context   : req.system,
      timeoutMs :
        action.endsWith('file-get') || action.endsWith('-upload')
          ? 310000
          : action.includes('credits') || action.includes('cancellations-get-list')
            ? 90000
            : 30000,
    });
  }
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Object} result Sobre del productor. @returns {*} Traducción uniforme de errores y datos. */
  function reply(req, res, result) {
    return result.statusCode >= 400
      ? response.sendError(req, res, result.statusCode, result.descriptionCode)
      : response.send(req, res, result.statusCode, result.data);
  }
  /** @param {string} method Verbo HTTP. @param {string} path Ruta canónica. @param {string} action Acción RPC. @returns {void} Registra transporte con entrada inmutable. */
  function register(method, path, action) {
    router[method](
      path,
      authorization.authorizationValidation,
      /** @param {Object} req Solicitud. @param {Object} res Respuesta. @returns {Promise<*>} Datos del dominio sin alterar estados desde Gateway. */
      async (req, res) => {
        try {
          let data = mergeRequest(req);
          for (const key of ['page', 'perPage', 'from', 'to', 'revision'])
            if (typeof data[key] === 'string' && /^\d+$/.test(data[key]))
              data[key] = Number(data[key]);
          for (const key of ['commercialOnly', 'invoiceRequested', 'outstandingOnly', 'active'])
            if (data[key] === 'true' || data[key] === 'false') data[key] = data[key] === 'true';
          if (action === 'billing-issuer-csd-set') {
            const issuer = await request(req, 'billing-issuer-get-one', { code: data.code });
            if (issuer.statusCode !== 200) return reply(req, res, issuer);
            data = seal.csd(data, issuer.data);
          }
          if (action === 'billing-pac-update') data = seal.pac(data);
          return reply(req, res, await request(req, action, data));
        } catch (error) {
          return response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'BILLING_UNAVAILABLE',
          );
        }
      },
    );
  }
  for (const resource of ['issuer', 'document', 'receipt', 'operation', 'audit', 'sale']) {
    register('get', `/billing/${resource}`, `billing-${resource}-get-list`);
    register('get', `/billing/${resource}/:code`, `billing-${resource}-get-one`);
    if (['issuer', 'document', 'sale'].includes(resource)) {
      register('post', `/billing/${resource}`, `billing-${resource}-create`);
      register('patch', `/billing/${resource}/:code`, `billing-${resource}-update`);
    }
  }
  register('post', '/billing/operation/:code/resolve', 'billing-operation-resolve');
  register('put', '/billing/issuer/:code/csd', 'billing-issuer-csd-set');
  register('get', '/billing/pac', 'billing-pac-get-one');
  register('patch', '/billing/pac', 'billing-pac-update');
  register('get', '/billing/pac/credits', 'billing-pac-credits-get');
  register('get', '/billing/issuer/:code/cancellations', 'billing-issuer-cancellations-get-list');
  register('post', '/billing/issuer/:code/cancellations/respond', 'billing-cancellation-authorize');
  for (const action of [
    'issue',
    'cancel',
    'reconcile',
    'deliver',
    'refresh-customer',
    'redate',
    'discard',
  ])
    register('post', '/billing/document/:code/' + action, 'billing-document-' + action);
  for (const action of ['confirm', 'cancel', 'invoice-create', 'extraction-create'])
    register('post', '/billing/sale/:code/' + action, 'billing-sale-' + action);
  register('post', '/billing/sales/global', 'billing-sale-global-create');
  register('get', '/billing/sale-extraction/:code', 'billing-sale-extraction-get-one');
  register('post', '/billing/sale-extraction/:code/advance', 'billing-sale-extraction-advance');
  register('post', '/billing/receipt', 'billing-receipt-create');
  register('post', '/billing/receipt/:code/reverse', 'billing-receipt-reverse');
  register('post', '/billing/receipt/:code/rep', 'billing-receipt-rep-create');
  router.get(
    '/billing/:resource/:code/files/:kind',
    authorization.authorizationValidation,
    /** @param {Object} req Comprobante y tipo de archivo. @param {Object} res Transferencia binaria. @returns {Promise<*>} Descarga privada con limpieza aun si el cliente desconecta. */
    async (req, res) => {
      let filename;
      /** @returns {void} Retira exclusivamente el temporal de esta descarga. */
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
          throw new ApplicationError(400, 'INVALID_INPUT');
        const { resource, code, kind } = req.params;
        if (
          !['document', 'sale', 'receipt'].includes(resource) ||
          (resource !== 'document' && kind !== 'pdf')
        )
          throw new ApplicationError(404, 'BILLING_FILE_NOT_FOUND');
        const result = await request(req, 'billing-' + resource + '-file-get', {
          code,
          ...(resource === 'document' ? { kind } : {}),
        });
        if (result.statusCode !== 200) return reply(req, res, result);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'private, no-store');
        res.type(result.data.mimeType);
        return res.download(
          filename,
          result.data.fileName,
          /** @param {Error|null} error Fallo de transferencia. @returns {void} Limpia y comunica el fallo antes de enviar cabeceras. */
          (error) => {
            cleanup();
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'BILLING_DOWNLOAD_FAILED');
          },
        );
      } catch (error) {
        cleanup();
        if (!res.headersSent)
          return response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'BILLING_DOWNLOAD_FAILED',
          );
      }
    },
  );
  require('./expense.routes').mountExpenses({
    ...dependencies,
    router,
    register,
    request,
    reply,
  });
  return router;
}
module.exports = { createRouter };
