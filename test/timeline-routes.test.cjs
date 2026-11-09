/** @file HTTP de Timeline: JSON de referencia y cursor, aceptación 202 y contexto acreditado. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { once } = require('node:events');
const express  = require('express');
const {
  timelineController,
} = require('../server/modules/communication/controllers/timeline.controller');
test('timeline adapta consultas y recibos sin aceptar contexto del cliente', /** @returns {Promise<void>} Servidor local y RPC observable. */ async () => {
  const calls = [],
    app       = express();
  app.use(express.json());
  app.use(
    timelineController({
      authorization : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Contexto acreditado. */ authorizationValidation(
          req,
          res,
          next,
        ) {
          req.system = {
            user      : { userCode: 'u' },
            workspace : 'w',
          };
          next();
        },
      },
      messaging     : {
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Carga. @param {Object} options Contexto. @returns {Promise<Object>} Sobre. */ async request(
          service,
          action,
          data,
          options,
        ) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : action === 'timeline-note-create' ? 202 : 200,
            data       : { ok: true },
          };
        },
      },
      response      : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Cuerpo. @returns {Object} Salida. */ send(
          req,
          res,
          status,
          data,
        ) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {string} code Causa. @returns {Object} Salida. */ sendError(
          req,
          res,
          status,
          code,
        ) {
          return res.status(status).json({ code });
        },
      },
      logger        : { /** @returns {void} Registro suprimido en prueba. */ error() {} },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/communication/timeline',
      subject = {
        service : 'service-documents',
        domain  : 'document',
        code    : 'd-1',
      },
      before  = {
        creationDate : 1000,
        code         : 'entry',
      };
    const query = new URLSearchParams({
      subject : JSON.stringify(subject),
      before  : JSON.stringify(before),
      limit   : '20',
    });
    assert.equal((await fetch(url + '?' + query)).status, 200);
    assert.deepEqual(calls[0].data, {
      subject,
      before,
      limit : 20,
    });
    assert.equal(calls[0].options.context.workspace, 'w');
    assert.equal(
      (
        await fetch(url + '/notes', {
          method  : 'POST',
          headers : { 'content-type': 'application/json' },
          body    : JSON.stringify({
            subject,
            description : 'Nota',
            requestId   : 'n',
          }),
        })
      ).status,
      202,
    );
    assert.equal(calls.at(-1).action, 'timeline-note-create');
    await fetch(url + '/requests/n');
    assert.equal(calls.at(-1).action, 'timeline-request-get');
    assert.deepEqual(calls.at(-1).data, { requestId: 'n' });
    const count = calls.length;
    assert.equal((await fetch(url + '?subject=%7B')).status, 400);
    assert.equal(calls.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} done Cierre. @returns {void} Libera puerto. */ (done) =>
        server.close(done),
    );
  }
});

test('foto de Timeline transfiere imagen privada y retira el temporal después de terminar' /** @returns {Promise<void>} HTTP real local verifica contexto, MIME, caché y limpieza. */, async () => {
  const fs = require('node:fs/promises'),
    os     = require('node:os'),
    path   = require('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-avatar-'));
  const filename  = path.join(directory, 'avatar.png');
  const bytes     = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWe0AAAAASUVORK5CYII=',
    'base64',
  );
  await fs.writeFile(filename, bytes);
  const app = express(),
    removed = [];
  let denied = false;
  app.use(
    timelineController({
      authorization  : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación.
         * @returns {void} Acredita contexto sintético, nunca el de la URL. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'u' },
            workspace : 'w',
          };
          next();
        },
      },
      messaging      : {
        /** @param {string} service Destino. @param {string} action Operación.
         * @param {Object} input Entrada cerrada. @param {Object} options Contexto.
         * @returns {Promise<Object>} Archivo propio o rechazo antes de obtener un temporal. */
        async request(service, action, input, options) {
          assert.equal(action, 'timeline-author-picture-read');
          assert.deepEqual(input, {
            code : 'entry',
            size : '050',
          });
          assert.equal(options.context.workspace, 'w');
          return denied
            ? {
                statusCode      : 403,
                descriptionCode : 'FORBIDDEN',
              }
            : {
                statusCode : 200,
                data       : {
                  tempFilePath : filename,
                  mimeType     : 'image/png',
                },
              };
        },
      },
      temporaryFiles : {
        /** @param {string} candidate Ruta de respuesta. @returns {Promise<string>} Sólo el archivo propio de la prueba. */
        async validate(candidate) {
          assert.equal(candidate, filename);
          return filename;
        },
        /** @param {string} candidate Temporal entregado. @returns {Promise<void>} Registra la limpieza del archivo. */
        async remove(candidate) {
          removed.push(candidate);
        },
      },
      response       : {
        /** @param {Object} req Entrada. @param {Object} res Salida. @param {number} status Estado. @param {string} code Motivo.
         * @returns {Object} Error HTTP seguro. */
        sendError(req, res, status, code) {
          return res.status(status).json({ code });
        },
      },
      logger         : {},
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url      =
      'http://127.0.0.1:' +
      server.address().port +
      '/communication/timeline/entry/author/picture?size=050';
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(removed, [filename]);
    denied = true;
    assert.equal((await fetch(url)).status, 403);
    assert.equal(removed.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} done Cierre. @returns {void} Libera el servidor propio. */
      (done) => server.close(done),
    );
    await fs.rm(directory, {
      recursive : true,
      force     : true,
    });
  }
});
