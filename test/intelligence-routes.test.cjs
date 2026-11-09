/** @file Frontera Intelligence: consultas HTTP tipadas, revisión y nombres RPC canónicos. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { once }         = require('node:events');
const express          = require('express');
const { createRouter } = require('../server/modules/intelligence/routes/routes');
test('listas y revisiones de query conservan enteros; el contexto autenticado no procede del cuerpo', /** @returns {Promise<void>} Router productivo con frontera RPC observable. */ async () => {
  const app = express(),
    calls   = [];
  app.use(express.json());
  app.use(
    createRouter({
      authorization : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Identidad acreditada por middleware. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'u' },
            workspace : 'w',
          };
          next();
        },
      },
      messaging     : {
        /** @param {string} service Propietario. @param {string} action Operación. @param {Object} data Intención. @param {Object} options Autoridad. @returns {Promise<Object>} Respuesta de frontera. */
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
      response      : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Contenido. @returns {Object} Respuesta HTTP. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {string} descriptionCode Causa. @returns {Object} Error HTTP. */
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
    await fetch(base + '/intelligence/teams?page=2&perPage=20&search=literal');
    assert.equal(calls.at(-1).service, 'service-intelligence');
    assert.equal(calls.at(-1).action, 'team-get-list');
    assert.deepEqual(calls.at(-1).data, {
      page    : 2,
      perPage : 20,
      search  : 'literal',
    });
    await fetch(base + '/intelligence/teams/one');
    assert.equal(calls.at(-1).action, 'team-get-one');
    await fetch(base + '/intelligence/teams/one?revision=3', { method: 'DELETE' });
    assert.equal(calls.at(-1).data.revision, 3);
    for (const invalid of ['1.5', '-1', '9007199254740992']) {
      await fetch(base + '/intelligence/teams?page=' + invalid);
      assert.equal(calls.at(-1).data.page, invalid);
    }
    await fetch(base + '/intelligence/settings/runtime', {
      method  : 'PATCH',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        revision : 3,
        data     : { enabled: false },
        userCode : 'forged',
      }),
    });
    assert.equal(calls.at(-1).options.context.user.userCode, 'u');
    assert.equal(calls.at(-1).action, 'settings-update');
    assert.equal(calls.at(-1).data.revision, 3);
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera sólo este servidor de prueba. */
      (resolve) => server.close(resolve),
    );
  }
});
