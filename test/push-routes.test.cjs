/** @file Registro push HTTP: autorización, contexto confiable, DTO cerrado y errores sin datos privados. */
'use strict';
const test               = require('node:test');
const assert             = require('node:assert/strict');
const { once }           = require('node:events');
const express            = require('express');
const { pushController } = require('../server/modules/platform/controllers/push.controller');
test('registro requiere sesión, conserva contexto y responde sin caché', /** @returns {Promise<void>} Ejecuta HTTP real contra colaboradores ficticios. */ async () => {
  const calls = [];
  let authorized = false,
    fail         = false;
  const context = {
    user        : { userCode: 'U1' },
    sessionCode : 'S1',
    workspace   : 'W1',
  };
  const app     = express();
  app.use(express.json());
  app.use(
    pushController({
      authorization : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Controla autenticación del fixture. */
        authorizationValidation(req, res, next) {
          if (!authorized) {
            res.sendStatus(401);
            return;
          }
          req.system = context;
          next();
        },
      },
      messaging     : {
        /** @param {string} service Destino. @param {string} action Contrato. @param {Object} data Datos. @param {Object} options Metadatos. @returns {Promise<Object>} Respuesta canónica. */
        async request(service, action, data, options) {
          if (fail) throw new Error('private SDK credentials');
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : 200,
            data       : { bindingId: data.bindingId },
          };
        },
      },
      response      : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Sobre. @returns {Object} Emite JSON. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {string} descriptionCode Error público. @returns {Object} Emite sólo código seguro. */
        sendError(req, res, status, descriptionCode) {
          return res.status(status).json({ descriptionCode });
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url     = `http://127.0.0.1:${server.address().port}/platform/push/devices/INSTALLATION`;
    const options = {
      method  : 'PUT',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        bindingId      : 'B1',
        generation     : 1,
        fid            : 'fictional',
        platform       : 'ios',
        installationId : 'SPOOF',
      }),
    };
    assert.equal((await fetch(url, options)).status, 401);
    assert.equal(calls.length, 0);
    authorized = true;
    const result = await fetch(url, options);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { bindingId: 'B1' });
    assert.equal(calls[0].service, 'service-platform');
    assert.equal(calls[0].action, 'push-device-register');
    assert.equal(calls[0].data.installationId, 'INSTALLATION');
    assert.deepEqual(calls[0].options.context, context);
    fail = true;
    const failed = await fetch(url, options);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { descriptionCode: 'PUSH_UNAVAILABLE' });
  } finally {
    await new Promise(
      /** @param {Function} resolve Fin del cierre. @returns {void} Libera el servidor de prueba. */ (
        resolve,
      ) => server.close(resolve),
    );
  }
});
