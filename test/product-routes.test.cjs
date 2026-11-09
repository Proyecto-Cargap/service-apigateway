/** @file Frontera HTTP de Product: contexto, queries tipadas y aislamiento de temporales. */
'use strict';
const test             = require('node:test');
const assert           = require('node:assert/strict');
const { once }         = require('node:events');
const express          = require('express');
const { createRouter } = require('../server/modules/product/routes/routes');
test('HTTP Product propaga contexto y revisión sin aceptar temporales del navegador' /** @returns {Promise<void>} Servidor HTTP real con transporte sustituido. */, async () => {
  const calls = [],
    app       = express();
  app.use(express.json());
  app.use(
    createRouter({
      authorization  : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Contexto de prueba acreditado. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'local-user' },
            workspace : 'workspace-a',
          };
          next();
        },
      },
      messaging      : {
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Sobre de prueba. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : 200,
            data       : { ok: true },
          };
        },
      },
      temporaryFiles : {},
      response       : {
        /** @param {Object} req Entrada. @param {Object} res Salida. @param {number} status Estado. @param {Object} data Resultado. @returns {Object} Respuesta. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Entrada. @param {Object} res Salida. @param {number} status Estado. @param {string} descriptionCode Código. @returns {Object} Error. */
        sendError(req, res, status, descriptionCode) {
          return res.status(status).json({ descriptionCode });
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/product/item?page=2&perPage=20&active=false')).status, 200);
    assert.equal(calls.at(-1).service, 'service-product');
    assert.equal(calls.at(-1).data.page, 2);
    assert.equal(calls.at(-1).data.active, false);
    assert.equal(calls.at(-1).options.context.user.userCode, 'local-user');
    await fetch(base + '/product/item/PRO-local?includeDescriptionHtml=true');
    assert.equal(calls.at(-1).action, 'product-item-get-one');
    assert.equal(calls.at(-1).data.includeDescriptionHtml, true);
    await fetch(base + '/product/item/PRO-local?includeDescriptionHtml=false');
    assert.equal(calls.at(-1).data.includeDescriptionHtml, false);
    for (const resource of ['sku', 'attribute']) {
      await fetch(base + '/product/' + resource + '/test-code?revision=7', { method: 'DELETE' });
      assert.equal(calls.at(-1).action, 'product-' + resource + '-delete');
      assert.deepEqual(calls.at(-1).data, {
        code     : 'test-code',
        revision : 7,
      });
      assert.equal(calls.at(-1).options.context.user.userCode, 'local-user');
    }
    await fetch(base + '/product/price-matrix?page=2&perPage=20&variantActive=false');
    assert.equal(calls.at(-1).action, 'product-price-matrix-get-list');
    assert.deepEqual(calls.at(-1).data, {
      page          : 2,
      perPage       : 20,
      variantActive : false,
    });
    await fetch(base + '/product/item/PRO-local/prices?page=2&perPage=10');
    assert.equal(calls.at(-1).action, 'product-item-prices-get-list');
    assert.deepEqual(calls.at(-1).data, {
      code    : 'PRO-local',
      page    : 2,
      perPage : 10,
    });
    await fetch(base + '/product/presentation/resolve', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        itemCode      : 'item',
        priceListCode : 'list',
        imageIds      : [],
      }),
    });
    assert.equal(calls.at(-1).action, 'product-presentation-resolve');
    assert.deepEqual(calls.at(-1).data.imageIds, []);
    await fetch(base + '/product/item/PRO-local/images', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        revision : 3,
        fileIds  : ['photo'],
      }),
    });
    assert.equal(calls.at(-1).action, 'product-item-images-set');
    assert.equal(calls.at(-1).options.timeoutMs, 310000);
    assert.deepEqual(calls.at(-1).data, {
      code          : 'PRO-local',
      revision      : 3,
      fileIds       : ['photo'],
      pictureUpload : undefined,
    });
    await fetch(base + '/product/item/PRO-local/save', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        code     : 'spoofed-code',
        revision : 3,
        item     : null,
        prices   : [
          {
            skuCode       : 'VAR-local',
            priceListCode : 'LPR-local',
            unitPrice     : '0.123456',
            active        : true,
          },
        ],
      }),
    });
    assert.equal(calls.at(-1).action, 'product-item-save');
    assert.equal(calls.at(-1).data.code, 'PRO-local');
    assert.equal(calls.at(-1).data.prices[0].unitPrice, '0.123456');
    await fetch(base + '/product/item/PRO-local/image', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        revision      : 2,
        pictureUpload : { tempFilePath: '/etc/passwd' },
      }),
    });
    assert.equal(calls.at(-1).action, 'product-item-image-set');
    assert.equal(calls.at(-1).data.pictureUpload, undefined);
    await fetch(base + '/product/customer/customer-a/price-list');
    assert.equal(calls.at(-1).data.customerCode, 'customer-a');
  } finally {
    await new Promise(
      /** @param {Function} resolve Continuación. @returns {void} Libera el servidor propio. */
      (resolve) => server.close(resolve),
    );
  }
});
