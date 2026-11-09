/** @file Transferencia privada de avatares comerciales con contexto, ETag y limpieza del temporal. */
'use strict';
const test     = require('node:test');
const assert   = require('node:assert/strict');
const { once } = require('node:events');
const fs       = require('node:fs/promises');
const os       = require('node:os');
const path     = require('node:path');
const express  = require('express');
const {
  pipelinePictureController,
} = require('../server/modules/customer/controllers/pipeline-picture.controller');
test('avatar del responsable mantiene autorización, caché privada y limpieza en 200 y 304', /** @returns {Promise<void>} Ejerce Express con un archivo temporal propio y RPC observado. */ async () => {
  const folder   = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-picture-'));
  const filename = path.join(folder, 'picture.png');
  await fs.writeFile(filename, 'local-picture');
  const calls = [],
    removed   = [],
    app       = express();
  app.use(
    pipelinePictureController({
      authorization  : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Instala contexto acreditado. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'alice' },
            workspace : 'a',
          };
          next();
        },
      },
      messaging      : {
        /** @param {string} service Servicio. @param {string} action Contrato. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Resultado canónico o rechazo. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return data.userCode === 'hidden'
            ? {
                statusCode      : 404,
                descriptionCode : 'CUSTOMER_ASSIGNEE_UNAVAILABLE',
              }
            : {
                statusCode : 200,
                data       : {
                  tempFilePath : filename,
                  fileName     : 'picture.png',
                  mimeType     : 'image/png',
                },
              };
        },
      },
      response       : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado público. @param {string} descriptionCode Causa. @returns {Object} Respuesta JSON. */
        sendError(req, res, status, descriptionCode) {
          return res.status(status).json({ descriptionCode });
        },
      },
      temporaryFiles : {
        /** @param {string} value Temporal devuelto por RPC. @returns {Promise<string>} Archivo propio de la prueba. */
        async validate(value) {
          assert.equal(value, filename);
          return filename;
        },
        /** @param {string} value Temporal. @param {Array} parts Identidad de caché. @returns {Promise<string>} ETag privado. */
        async etag(value, parts) {
          assert.deepEqual(parts, ['alice', 'a', 'p', 'bob', '050']);
          return '"avatar"';
        },
        /** @param {string} value Temporal gestionado. @returns {Promise<void>} Registra limpieza sin borrar el fixture compartido. */
        async remove(value) {
          removed.push(value);
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url    = 'http://127.0.0.1:' + server.address().port + '/customer/pipeline/p/assignees/';
    const result = await fetch(url + 'bob/picture');
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'local-picture');
    assert.equal(result.headers.get('cache-control'), 'private, no-cache');
    assert.equal(result.headers.get('vary'), 'Authorization');
    assert.equal(calls[0].action, 'pipeline-get-assignee-picture');
    assert.deepEqual(calls[0].data, {
      pipelineCode : 'p',
      userCode     : 'bob',
      size         : '050',
    });
    assert.equal(calls[0].options.context.workspace, 'a');
    assert.equal(
      (
        await fetch(url + 'bob/picture', {
          headers : { 'If-None-Match': '"avatar"' },
          cache   : 'no-cache',
        })
      ).status,
      304,
    );
    assert.equal((await fetch(url + 'hidden/picture')).status, 404);
    assert.deepEqual(removed, [filename, filename]);
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el puerto efímero. */ (
        resolve,
      ) => server.close(resolve),
    );
    await fs.rm(folder, {
      recursive : true,
      force     : true,
    });
  }
});
