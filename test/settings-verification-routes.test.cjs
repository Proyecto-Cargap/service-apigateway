/** @file Prueba HTTP del SMTP global: políticas vigentes, credenciales selladas y errores de conexión. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { once }                   = require('node:events');
const crypto                     = require('node:crypto');
const express                    = require('express');
const { settingsController }     = require('../server/modules/connect/controllers/settings.controller');
const response                   = require('../server/adapters/http/response');
const { smtpRequestCredentials } = require('../server/adapters/crypto/smtp-request-credentials');

test('PATCH SMTP transmite la revisión y devuelve la configuración confirmada sin otra consulta' /** @returns {Promise<void>} Recorre el gateway HTTP real y observa una sola mutación RPC. */, async () => {
  const calls     = [];
  const confirmed = {
    parameter : 'mail-connection',
    revision  : 4,
  };
  const app       = express();
  app.use(express.json());
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Contexto de transporte del arnés. */
  function authorize(req, res, next) {
    req.system = { user: { userCode: 'admin' } };
    req.transaction = {
      id              : 'test',
      identifier      : '',
      requestDateTime : Date.now(),
    };
    next();
  }
  app.use(
    settingsController({
      response,
      authorization : {
        authorizationValidation : authorize,
      },
      logger        : { /** @returns {void} No registra contenido. */ error() {} },
      messaging     : {
        /** @param {string} service Productor. @param {string} action Acción. @param {Object} data Entrada. @returns {Promise<Object>} Respuesta confirmada del productor. */
        async request(service, action, data) {
          calls.push({
            service,
            action,
            data,
          });
          return {
            statusCode : 200,
            data       : confirmed,
          };
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await fetch(
      `http://127.0.0.1:${server.address().port}/connect/settings/mail-connection`,
      {
        method  : 'PATCH',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({
          revision : 3,
          scope    : 'global',
          data     : {},
        }),
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).businessResponse, confirmed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].service, 'service-connect');
    assert.equal(calls[0].action, 'settings-update');
    assert.equal(calls[0].data.revision, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el servidor aislado. */ (
        resolve,
      ) => server.close(resolve),
    );
  }
});

test('POST global sella secretos, transmite el contexto vigente y no ejecuta guardados' /** @returns {Promise<void>} Recorre HTTP real con RPC observado y sin proveedores externos. */, async () => {
  const calls = [],
    key       = Buffer.alloc(32, 8);
  const context = {
    user     : { userCode: 'actor' },
    policies : ['connect.settings.update.global'],
  };
  let currentAuthentications = 0,
    reply                    = {
      statusCode : 200,
      data       : { verified: true },
    },
    fail                     = false;
  const app = express();
  app.use(express.json());
  app.use(
    settingsController({
      response,
      logger              : { /** @returns {void} No registra cuerpos privados. */ error() {} },
      sealSmtpCredentials : smtpRequestCredentials(key.toString('base64')),
      authorization       : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Acredita políticas actuales en la prueba. */
        authorizationValidation(req, res, next) {
          currentAuthentications++;
          req.system = context;
          req.transaction = {
            id              : 'fixture',
            identifier      : '',
            requestDateTime : Date.now(),
          };
          next();
        },
      },
      messaging           : {
        /** @param {string} service Servicio. @param {string} action Operación. @param {Object} data Candidato sellado. @param {Object} options Contexto verificado. @returns {Promise<Object>} Resultado controlado sin persistencia. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          if (fail) throw new Error('private provider details');
          return reply;
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url  = `http://127.0.0.1:${server.address().port}/connect/settings/mail-connection/verify`;
  const body = {
    data  : {
      conection : {
        auth : {
          user : 'test-user',
          pass : 'test-password',
        },
      },
    },
    scope : 'global',
  };
  /** @param {Object} input Cuerpo del candidato. @param {string} query Consulta opcional. @returns {Promise<Response>} Petición real al gateway local. */
  const send = (input = body, query = '') =>
    fetch(url + query, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(input),
    });
  try {
    const ok = await send();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual((await ok.json()).businessResponse, { verified: true });
    assert.equal(currentAuthentications, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'settings-verify');
    assert.equal(calls[0].service, 'service-connect');
    assert.equal(calls[0].options.context, context);
    assert.equal(calls[0].data.scope, 'global');
    assert.equal(JSON.stringify(calls).includes('test-password'), false);
    const bytes    = Buffer.from(calls[0].data.data.conection.auth.pass.slice(7), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('smtp-request:global:mail-connection:pass'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    assert.equal(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      'test-password',
    );
    for (const extra of [
      { userCode: 'victim' },
      { workspace: 'other' },
      { scope: 'owner' },
      { consumer: 'web' },
    ])
      assert.equal(
        (
          await send({
            ...body,
            ...extra,
          })
        ).status,
        400,
      );
    assert.equal((await send(body, '?scope=global')).status, 400);
    assert.equal(calls.length, 1);
    reply = {
      statusCode      : 502,
      descriptionCode : 'SMTP_CONNECTION_FAILED',
    };
    const failed = await send();
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).headerResponse.descriptionCode, 'SMTP_CONNECTION_FAILED');
    fail = true;
    const unavailable = await send();
    assert.equal(unavailable.status, 503);
    assert.equal(
      (await unavailable.json()).headerResponse.descriptionCode,
      'SMTP_VERIFICATION_UNAVAILABLE',
    );
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} done Continuación de cierre. @returns {void} Libera el servidor local. */ (
        done,
      ) => server.close(done),
    );
  }
});
