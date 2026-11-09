/** @file Regresión HTTP del guardado PAC: custodia obligatoria, errores públicos y secretos fuera de las respuestas. */
'use strict';
const test             = require('node:test');
const assert           = require('node:assert/strict');
const { once }         = require('node:events');
const { randomBytes }  = require('node:crypto');
const express          = require('express');
const { createRouter } = require('../server/modules/billing/routes/routes');
const {
  billingRequestCredentials,
} = require('../server/adapters/crypto/billing-request-credentials');
const response = require('../server/adapters/http/response');

test('PATCH PAC conserva la causa de custodia ausente en Gateway y Billing sin revelar secretos', /** @returns {Promise<void>} Recorre el router y el presentador HTTP reales; sólo sustituye autenticación y RPC. */ async () => {
  const apiKey = 'A'.repeat(32);
  for (const scenario of [
    'gateway-missing-key',
    'billing-missing-key',
    'private-failure',
    'success',
  ]) {
    const app = express(),
      calls   = [];
    app.use(express.json());
    app.use(
      createRouter({
        response,
        billingCredentials : billingRequestCredentials(
          scenario === 'gateway-missing-key' ? '' : randomBytes(32).toString('base64'),
        ),
        authorization      : {
          /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Instala el contexto autorizado y la transacción de prueba. */
          authorizationValidation(req, res, next) {
            req.system = {
              user     : { userCode: 'actor' },
              policies : ['billing.pac.update.global'],
            };
            req.transaction = {
              id              : 'pac-test',
              identifier      : '',
              requestDateTime : Date.now(),
            };
            next();
          },
        },
        messaging          : {
          /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Comando sellado. @returns {Promise<Object>} Respuesta controlada sin persistencia ni llamada al PAC. */
          async request(service, action, data) {
            assert.equal(service, 'service-billing');
            assert.equal(action, 'billing-pac-update');
            calls.push(data);
            if (scenario === 'success')
              return {
                statusCode : 200,
                data       : {
                  revision         : 1,
                  apiKeyConfigured : true,
                },
              };
            return {
              statusCode      : 503,
              descriptionCode :
                scenario === 'private-failure'
                  ? 'BILLING_PRIVATE_SECRET'
                  : 'BILLING_ENCRYPTION_NOT_CONFIGURED',
            };
          },
        },
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/billing/pac`, {
        method  : 'PATCH',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({
          revision    : 0,
          environment : 'development',
          apiKey,
        }),
      });
      const body   = await result.json();
      assert.equal(result.status, scenario === 'success' ? 200 : 503);
      assert.equal(
        body.headerResponse.descriptionCode,
        scenario === 'success'
          ? 'OK'
          : scenario === 'private-failure'
            ? 'Service Unavailable'
            : 'BILLING_ENCRYPTION_NOT_CONFIGURED',
      );
      assert.equal(calls.length, scenario === 'gateway-missing-key' ? 0 : 1);
      assert.equal(JSON.stringify(body).includes(apiKey), false);
      assert.equal(JSON.stringify(calls).includes(apiKey), false);
      if (calls.length) {
        assert.equal(Object.hasOwn(calls[0], 'apiKey'), false);
        assert.match(calls[0].envelope, /^v1\./);
      }
      if (scenario === 'success') assert.equal(body.businessResponse.apiKeyConfigured, true);
    } finally {
      server.closeAllConnections();
      await new Promise(
        /** @param {Function} done Continuación del cierre. @returns {void} Libera el servidor efímero. */
        (done) => server.close(done),
      );
    }
  }
});
