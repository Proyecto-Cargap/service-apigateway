/** @file Adaptación HTTP de Product con contexto acreditado e imágenes privadas. */
'use strict';
const { mergeRequest } = require('../../../shared/http-request');
/** @param {Object} dependencies Transporte, autorización, respuesta y temporales existentes. @returns {Object} Router sin reglas comerciales. */
function createRouter(dependencies) {
  const { messaging, authorization, response, temporaryFiles } = dependencies;
  const router = require('express').Router(),
    picture    = require('../../../shared/picture-upload.http')(dependencies);
  /** @param {Object} req Solicitud acreditada. @param {string} action Acción canónica. @param {Object} data Entrada. @returns {Promise<Object>} Sobre RPC. */
  function request(req, action, data) {
    return messaging.request('service-product', action, data, {
      context   : req.system,
      timeoutMs : action.includes('-image-') || action.includes('-images-') ? 310000 : 30000,
    });
  }
  /** @param {string} method Verbo. @param {string} path Ruta. @param {string} action RPC. @param {boolean} upload Usa multipart. @returns {void} Registra adaptación. */
  function register(method, path, action, upload = false) {
    router[method](
      path,
      authorization.authorizationValidation,
      ...(upload ? [picture] : []),
      /** @param {Object} req Entrada. @param {Object} res Salida. @returns {Promise<*>} Respuesta canónica. */
      async (req, res) => {
        try {
          const data = mergeRequest(req);
          for (const key of ['page', 'perPage', 'revision'])
            if (typeof data[key] === 'string' && /^\d+$/.test(data[key]))
              data[key] = Number(data[key]);
          if (['true', 'false'].includes(data.active)) data.active = data.active === 'true';
          if (['true', 'false'].includes(data.variantActive))
            data.variantActive = data.variantActive === 'true';
          if (['true', 'false'].includes(data.includeDescriptionHtml))
            data.includeDescriptionHtml = data.includeDescriptionHtml === 'true';
          const result = await request(req, action, data);
          return result.statusCode >= 400
            ? response.sendError(req, res, result.statusCode, result.descriptionCode)
            : response.send(req, res, result.statusCode, result.data);
        } catch (error) {
          return response.sendError(
            req,
            res,
            error.statusCode || 503,
            error.descriptionCode || 'PRODUCT_UNAVAILABLE',
          );
        }
      },
    );
  }
  register('delete', '/product/price-list/:code', 'product-price-list-delete');
  register('delete', '/product/sku/:code', 'product-sku-delete');
  register('delete', '/product/attribute/:code', 'product-attribute-delete');
  register('get', '/product/price-matrix', 'product-price-matrix-get-list');
  register('post', '/product/sale/resolve', 'product-sale-resolve');
  register('post', '/product/presentation/resolve', 'product-presentation-resolve');
  register('get', '/product/item/:code/prices', 'product-item-prices-get-list');
  register('post', '/product/item/:code/save', 'product-item-save');
  register('get', '/product/customer/:customerCode/price-list', 'product-customer-price-list-get');
  for (const resource of [
    'item',
    'sku',
    'category',
    'attribute',
    'price-list',
    'price',
    'assignment',
  ]) {
    register('get', '/product/' + resource, `product-${resource}-get-list`);
    register('get', '/product/' + resource + '/:code', `product-${resource}-get-one`);
    register('post', '/product/' + resource, `product-${resource}-create`);
    register('patch', '/product/' + resource + '/:code', `product-${resource}-update`);
  }
  for (const resource of ['item', 'sku']) {
    register(
      'post',
      '/product/' + resource + '/:code/images',
      `product-${resource}-images-set`,
      true,
    );
    register(
      'post',
      '/product/' + resource + '/:code/image',
      `product-${resource}-image-set`,
      true,
    );
    router.get(
      '/product/' + resource + '/:code/image',
      authorization.authorizationValidation,
      /** @param {Object} req Recurso visible. @param {Object} res Descarga. @returns {Promise<*>} Bytes privados y limpieza al desconectar. */
      async (req, res) => {
        let filename;
        /** @returns {void} Libera únicamente el temporal de esta transferencia. */
        function cleanup() {
          if (filename) {
            const owned = filename;
            filename = undefined;
            void temporaryFiles.remove(owned);
          }
        }
        res.once('finish', cleanup);
        res.once('close', cleanup);
        try {
          const result = await request(req, `product-${resource}-image-get`, mergeRequest(req));
          if (result.statusCode >= 400)
            return response.sendError(req, res, result.statusCode, result.descriptionCode);
          filename = await temporaryFiles.validate(result.data.tempFilePath);
          if (res.destroyed) {
            cleanup();
            return;
          }
          res.set('X-Content-Type-Options', 'nosniff');
          res.set('Cache-Control', 'private, no-store');
          res.type(result.data.mimeType);
          return res.sendFile(
            filename,
            /** @param {Error|null} error Fallo de transferencia. @returns {void} Libera el temporal aun si se interrumpe. */
            (error) => {
              cleanup();
              if (error && !res.headersSent)
                response.sendError(req, res, 503, 'PRODUCT_IMAGE_UNAVAILABLE');
            },
          );
        } catch (error) {
          cleanup();
          if (!res.headersSent)
            return response.sendError(
              req,
              res,
              error.statusCode || 503,
              error.descriptionCode || 'PRODUCT_IMAGE_UNAVAILABLE',
            );
        }
      },
    );
  }
  return router;
}
module.exports = { createRouter };
