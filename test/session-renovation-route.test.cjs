/** @file Renovación de sesión sin credenciales en la URL ni selectores del cuerpo. */
'use strict';
const test                  = require('node:test');
const assert                = require('node:assert/strict');
const express               = require('express');
const { once }              = require('node:events');
const { sessionController } = require('../server/modules/security/controllers/session.controller');

test('renovar usa exclusivamente el encabezado de la sesión autenticada', /** @returns {Promise<void>} Rechaza ausencia, ignora suplantación y retira la ruta con credencial. */ async () => {
  const calls = [];
  const app   = express();
  app.use(express.json());
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {*} Acreditación del fixture sin secretos reales. */
  function authorize(req, res, next) {
    if (!req.get('Authorization')) return res.sendStatus(401);
    req.system = { sessionCode: 'session' };
    return next();
  }
  app.use(
    sessionController({
      authorization : {
        authorizationValidation : authorize,
        withOutValidation       : authorize,
      },
      logger        : { /** @returns {void} Error técnico sin cuerpo. */ error() {} },
      messaging     : {
        /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Renovación simulada. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : action === 'session-restore' ? 200 : 201,
            data       : { renewed: true },
          };
        },
      },
      response      : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Datos. @returns {Object} Respuesta JSON. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @returns {Object} Error seguro. */
        sendError(req, res, status) {
          return res.sendStatus(status);
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/security/session`;
  try {
    assert.equal((await fetch(base + '/renovate', { method: 'PUT' })).status, 401);
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await fetch(base + '/renovate', {
          method  : 'PUT',
          headers : {
            Authorization  : 'Bearer fixture-only',
            'Content-Type' : 'application/json',
          },
          body    : JSON.stringify({ code: 'spoof' }),
        })
      ).status,
      201,
    );
    assert.deepEqual(calls[0], {
      service : 'service-security',
      action  : 'session-renovate',
      data    : { code: 'fixture-only' },
      options : { context: { sessionCode: 'session' } },
    });
    assert.equal(
      (
        await fetch(base + '/fixture-only/renovate', {
          method  : 'PUT',
          headers : { Authorization: 'fixture-only' },
        })
      ).status,
      404,
    );
    assert.equal(calls.length, 1);
    assert.equal((await fetch(base + '/restore', { method: 'POST' })).status, 401);
    assert.equal(calls.length, 1);
    const restored = await fetch(base + '/restore?code=query-spoof', {
      method  : 'POST',
      headers : {
        Authorization  : 'Bearer fixture-current',
        'Content-Type' : 'application/json',
      },
      body    : JSON.stringify({
        code          : 'body-spoof',
        workspaceCode : 'spoof',
      }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[1], {
      service : 'service-security',
      action  : 'session-restore',
      data    : { code: 'fixture-current' },
      options : { context: { sessionCode: 'session' } },
    });
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el puerto. */ (resolve) =>
        server.close(resolve),
    );
  }
});
