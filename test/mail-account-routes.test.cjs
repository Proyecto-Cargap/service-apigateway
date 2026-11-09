/** @file Integración HTTP local de cuentas SMTP; identidad de ruta y errores sin secretos. */
'use strict';
const responseAdapter = require('../server/adapters/http/response');
const test            = require('node:test');
const assert          = require('node:assert/strict');
const { once }        = require('node:events');
const express         = require('express');
const {
  mailAccountController,
} = require('../server/modules/connect/controllers/mail-account.controller');

test('rutas propias y administrativas conservan contexto y rechazan suplantación del cuerpo' /** @returns {Promise<void>} Recorre los ocho endpoints con HTTP real y RPC controlado. */, async () => {
  const calls = [],
    context   = {
      user      : { userCode: 'actor' },
      workspace : 'w1',
    };
  const app = express();
  app.use(express.json());
  app.use(
    mailAccountController({
      sealSmtpCredentials :
        require('../server/adapters/crypto/smtp-request-credentials').smtpRequestCredentials(
          Buffer.alloc(32, 7).toString('base64'),
        ),
      authorization       : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Fija identidad del servidor. */
        authorizationValidation(req, res, next) {
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
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data DTO. @param {Object} options Contexto. @returns {Promise<Object>} Respuesta saneada sin datos de credenciales. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : 200,
            data       : null,
          };
        },
      },
      response            : responseAdapter,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['me', 'user/target'])
      for (const [method, action, suffix] of [
        ['GET', 'get', ''],
        ['PUT', 'save', ''],
        ['DELETE', 'delete', ''],
        ['POST', 'verify', '/verify/smtp'],
        ['POST', 'verify', '/verify/imap'],
      ]) {
        const response = await fetch(`${origin}/connect/mail-accounts/${route}${suffix}`, {
          method,
          headers : {
            'Content-Type' : 'application/json',
            'If-Match'     : '"3"',
          },
          ...(['PUT', 'POST'].includes(method)
            ? {
                body : JSON.stringify({
                  ...(method === 'PUT' ? { revision: 3 } : {}),
                  data : {
                    account   : {},
                    imap      : {
                      auth : {
                        user : 'imap-user',
                        pass : 'imap-secret',
                      },
                    },
                    conection : {
                      auth : {
                        user : 'fixture-user',
                        pass : 'fixture-password',
                      },
                    },
                  },
                }),
              }
            : {}),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).businessResponse, null);
        const call = calls.at(-1);
        assert.equal(call.service, 'service-connect');
        assert.equal(call.action, `mail-account-${action}`);
        assert.equal(call.options.context, context);
        if (['save', 'verify'].includes(action)) {
          assert.match(call.data.data.conection.auth.pass, /^sealed:/);
          assert.match(call.data.data.imap.auth.pass, /^sealed:/);
          assert(!JSON.stringify(call).includes('imap-secret'));
          if (action === 'verify') assert.equal(call.data.protocol, suffix.split('/').at(-1));
          assert.equal(JSON.stringify(call).includes('fixture-password'), false);
        }
        assert.equal(call.data.userCode, route === 'me' ? undefined : 'target');
      }
    const list = await fetch(`${origin}/connect/mail-accounts?page=2&perPage=20`);
    assert.equal(list.status, 200);
    assert.deepEqual(calls.at(-1).data, {
      page    : 2,
      perPage : 20,
    });
    assert.equal(calls.at(-1).action, 'mail-account-get-list');
    const count = calls.length;
    for (const query of ['scope=global', 'userCode=victim', 'page=x', 'page=1&page=2']) {
      const invalid = await fetch(`${origin}/connect/mail-accounts?${query}`);
      assert.equal(invalid.status, 400);
    }
    for (const extra of [{ userCode: 'victim' }, { workspace: 'other' }, { scope: 'global' }]) {
      const response = await fetch(`${origin}/connect/mail-accounts/me`, {
        method  : 'PUT',
        headers : {
          'Content-Type' : 'application/json',
          'If-Match'     : '"3"',
        },
        body    : JSON.stringify({
          data : {},
          ...extra,
        }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, count);
  } finally {
    await new Promise(
      /** @param {Function} resolve Confirma cierre local. @returns {void} Libera el listener de prueba. */
      (resolve) => server.close(resolve),
    );
  }
});

test('errores SMTP operativos conservan sólo códigos públicos permitidos' /** @returns {void} No devuelve errores técnicos ni secretos del proveedor. */, () => {
  for (const code of [
    'SMTP_CONNECTION_FAILED',
    'SMTP_ENCRYPTION_UNAVAILABLE',
    'SMTP_CREDENTIALS_UNAVAILABLE',
    'SMTP_DNS_FAILED',
    'MAIL_ACCOUNT_UNAVAILABLE',
    'fixture-password',
  ]) {
    let body;
    const response = {
      /** @returns {Object} Respuesta encadenable. */
      status() {
        return this;
      },
      /** @param {Object} value Sobre público. @returns {void} Conserva la respuesta para validar. */
      json(value) {
        body = value;
      },
    };
    responseAdapter.sendError({}, response, 503, code);
    assert.equal(
      body.headerResponse.descriptionCode,
      code === 'fixture-password' ? 'Service Unavailable' : code,
    );
  }
});

test('cifrado HTTP a RPC liga secretos al propietario y falla cerrado sin clave' /** @returns {void} Prueba el formato AES compartido sin persistir secretos ni importar otro repositorio. */, () => {
  const crypto                     = require('node:crypto');
  const { smtpRequestCredentials } = require('../server/adapters/crypto/smtp-request-credentials');
  const key = Buffer.alloc(32, 7),
    data    = {
      conection : {
        auth : {
          user : 'fixture-user',
          pass : 'fixture-password',
        },
      },
    };
  const sealed = smtpRequestCredentials(key.toString('base64'))(data, 'actor');
  assert.equal(JSON.stringify(sealed).includes('fixture-password'), false);
  assert.equal(data.conection.auth.pass, 'fixture-password');
  const bytes    = Buffer.from(sealed.conection.auth.pass.slice(7), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('smtp-request:actor:pass'));
  decipher.setAuthTag(bytes.subarray(12, 28));
  assert.equal(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    'fixture-password',
  );
  assert.throws(
    /** @returns No delega texto claro si falta la configuración de cifrado. */
    () => smtpRequestCredentials()(data, 'actor'),
    { descriptionCode: 'SMTP_ENCRYPTION_UNAVAILABLE' },
  );
});
