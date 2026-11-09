/** @file HTTP de correo: contexto autenticado, credenciales selladas y adjuntos sin bytes en RPC. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const express                    = require('express');
const { once }                   = require('node:events');
const fs                         = require('node:fs/promises');
const os                         = require('node:os');
const path                       = require('node:path');
const { mailboxController }      = require('../server/modules/connect/controllers/mailbox.controller');
const response                   = require('../server/adapters/http/response');
const { smtpRequestCredentials } = require('../server/adapters/crypto/smtp-request-credentials');
test('correo HTTP conserva identidad, rechaza selectores y cifra IMAP antes de RPC', /** @returns {Promise<void>} Recorre rutas con servidor efímero y mensajería controlada. */ async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-http-')),
    calls    = [],
    context  = {
      user     : { userCode: 'owner' },
      policies : ['connect.mailbox.view.owner'],
    };
  const app = express();
  app.use(express.json());
  app.use(
    mailboxController({
      response,
      sealSmtpCredentials : smtpRequestCredentials(Buffer.alloc(32, 7).toString('base64')),
      authorization       : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Simula autenticación sin aceptar identidad del cuerpo. */ authorizationValidation(
          req,
          res,
          next,
        ) {
          if (req.get('authorization') !== 'fixture') {
            res.sendStatus(401);
            return;
          }
          req.system = context;
          req.transaction = {
            id              : 'local',
            identifier      : '',
            requestDateTime : Date.now(),
          };
          next();
        },
      },
      messaging           : {
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Carga. @param {Object} options Contexto. @returns {Promise<Object>} Respuesta pública sin bytes ni secretos. */ async request(
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
            statusCode : 200,
            data       : { updated: true },
          };
        },
      },
      temporaryFiles      : {
        /** @returns {Promise<string>} Directorio exclusivo de prueba. */ async prepareMultipart() {
          return root;
        },
        /** @param {string} file Temporal. @returns {Promise<string>} Ruta existente del uploader real. */ async validate(
          file,
        ) {
          return fs.realpath(file);
        },
        /** @param {string} file Temporal. @returns {Promise<void>} Restringe permisos del archivo. */ async restrict(
          file,
        ) {
          await fs.chmod(file, 0o600);
        },
        /** @param {string} file Temporal consumido. @returns {Promise<void>} Retira sólo la carga del escenario. */ async remove(
          file,
        ) {
          await fs.unlink(file);
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/connect/mailbox`;
  try {
    assert.equal((await fetch(base + '/status')).status, 401);
    assert.equal(calls.length, 0);
    const headers = {
      authorization  : 'fixture',
      'content-type' : 'application/json',
    };
    const status  = await fetch(base + '/status', { headers });
    assert.equal(status.status, 200);
    assert.equal(calls[0].action, 'mailbox-status-get');
    assert.equal(calls[0].options.context, context);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + '/account', { headers })).status, 404);
    for (const query of ['userCode=victim', 'scope=global', 'page=1&page=2', 'page=bad'])
      assert.equal(
        (await fetch(base + '/messages?folder=INBOX&' + query, { headers })).status,
        400,
      );
    assert.equal((await fetch(base + '/status?userCode=victim', { headers })).status, 400);
    assert.equal(
      (
        await fetch(base + '/messages/message-1', {
          method : 'PATCH',
          headers,
          body   : JSON.stringify({
            id     : 'other',
            action : 'trash',
          }),
        })
      ).status,
      400,
    );
    const form = new FormData();
    form.set('file', new Blob(['private content'], { type: 'text/plain' }), 'prueba.txt');
    assert.equal(
      (
        await fetch(base + '/attachments', {
          method  : 'POST',
          headers : { authorization: 'fixture' },
          body    : form,
        })
      ).status,
      200,
    );
    const upload = calls.at(-1);
    assert.equal(upload.action, 'mailbox-attachment-upload');
    assert.deepEqual(Object.keys(upload.data).sort(), ['name', 'size', 'tempFilePath']);
    assert(!JSON.stringify(upload).includes('private content'));
    assert.equal((await fs.readdir(root)).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el servidor local. */ (
        resolve,
      ) => server.close(resolve),
    );
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
