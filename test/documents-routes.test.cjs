/** @file Frontera HTTP Documents: referencia canónica y revisiones numéricas en DELETE y multipart. */
'use strict';
const test     = require('node:test');
const assert   = require('node:assert/strict');
const { once } = require('node:events');
const express  = require('express');
const {
  documentsController,
} = require('../server/modules/documents/controllers/documents.controller');
test('Documents tipa revisiones de URL y mantiene autoridad y referencia de recurso', /** @returns {Promise<void>} Ejercita rutas HTTP y parser multipart reales con puerto RPC sustituible. */ async () => {
  const calls = [],
    removed   = [],
    app       = express();
  app.use(express.json());
  app.use(
    documentsController({
      authorization  : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Identidad acreditada fuera del cuerpo. */
        authorizationValidation(req, res, next) {
          req.system = { user: { userCode: 'alice' } };
          next();
        },
      },
      messaging      : {
        /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Sobre de prueba. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : 200,
            data       : {},
          };
        },
      },
      temporaryFiles : {
        /** @param {Object} file Parte binaria. @returns {Promise<string>} Temporal sintético. */
        async createUpload(file) {
          assert.equal(file.data.toString(), 'bytes');
          return '/isolated/file.txt';
        },
        /** @param {string} file Temporal. @returns {Promise<void>} Registra la limpieza. */
        async remove(file) {
          removed.push(file);
        },
      },
      response       : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Datos. @returns {Object} Respuesta HTTP. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {string} code Causa. @returns {Object} Rechazo HTTP. */
        sendError(req, res, status, code) {
          return res.status(status).json({ code });
        },
      },
      logger         : { /** @returns {void} No registra cargas. */ error() {} },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base    = 'http://127.0.0.1:' + server.address().port;
    const subject = {
      service : 'service-projects',
      domain  : 'work-item',
      code    : 'task',
    };
    assert.equal(
      (
        await fetch(base + '/documents/repositories/resolve', {
          method  : 'POST',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify({
            subject,
            userCode : 'spoofed',
          }),
        })
      ).status,
      200,
    );
    assert.deepEqual(calls.at(-1).data, { subject });
    assert.equal(calls.at(-1).action, 'documents-repository-resolve');
    assert.equal(calls.at(-1).options.context.user.userCode, 'alice');
    assert.equal(
      (await fetch(base + '/documents/entries/entry?expectedRevision=3', { method: 'DELETE' }))
        .status,
      200,
    );
    assert.deepEqual(calls.at(-1).data, {
      entryId          : 'entry',
      expectedRevision : 3,
    });
    for (const revision of [
      '0',
      '-1',
      '1.5',
      '3junk',
      '9007199254740992',
      '3&expectedRevision=4',
    ]) {
      const count = calls.length;
      assert.equal(
        (
          await fetch(base + '/documents/entries/entry?expectedRevision=' + revision, {
            method : 'DELETE',
          })
        ).status,
        400,
      );
      assert.equal(calls.length, count);
    }
    const form = new FormData();
    form.set('file', new Blob(['bytes'], { type: 'text/plain' }), 'file.txt');
    assert.equal(
      (
        await fetch(base + '/documents/repositories/root/files?overwrite=true&expectedRevision=4', {
          method : 'POST',
          body   : form,
        })
      ).status,
      200,
    );
    assert.equal(calls.at(-1).data.expectedRevision, 4);
    assert.equal(calls.at(-1).action, 'documents-file-upload');
    assert.deepEqual(removed, ['/isolated/file.txt']);
    assert.equal((await fetch(base + '/documents/settings?userCode=forged')).status, 200);
    assert.equal(calls.at(-1).action, 'documents-settings-get');
    assert.deepEqual(calls.at(-1).data, {});
    const settings = {
      availableSpace     : 1000,
      sizeFileMax        : 100,
      trashRetentionDays : 30,
    };
    assert.equal(
      (
        await fetch(base + '/documents/settings', {
          method  : 'PATCH',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify({
            data             : settings,
            expectedRevision : 4,
            userCode         : 'forged',
            workspace        : 'foreign',
          }),
        })
      ).status,
      200,
    );
    assert.equal(calls.at(-1).action, 'documents-settings-update');
    assert.deepEqual(calls.at(-1).data, {
      data             : settings,
      expectedRevision : 4,
    });
    assert.deepEqual(calls.at(-1).options.context, { user: { userCode: 'alice' } });
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el puerto propio. */ (resolve) =>
        server.close(resolve),
    );
  }
});
