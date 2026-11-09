/** @file Aceptación HTTP de ajustes de Directory: contexto autenticado, revisión y proyección de visibilidad. */
'use strict';
const test     = require('node:test');
const assert   = require('node:assert/strict');
const { once } = require('node:events');
const express  = require('express');
const {
  settingsController,
} = require('../server/modules/directory/controllers/settings.controller');
const response = require('../server/adapters/http/response');

test('las rutas conservan contexto, datos de revisión y conflictos del servicio', /** @returns {Promise<void>} Ejecuta HTTP local con el adaptador real y RPC observado. */ async () => {
  const calls = [],
    context   = {
      user     : { userCode: 'fixture' },
      policies : [],
    };
  let authenticated = true;
  let reply         = {
    statusCode : 200,
    data       : {
      showAddresses      : false,
      showContactDetails : true,
      showEmailAccount   : false,
    },
  };
  const app         = express();
  app.use(express.json());
  app.use(
    settingsController({
      response,
      logger        : { /** @returns {void} Evita registrar datos de prueba. */ error() {} },
      authorization : {
        /** @param {Object} req Petición. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Acredita una sesión local o devuelve 401. */
        authorizationValidation(req, res, next) {
          if (!authenticated) {
            res.status(401).end();
            return;
          }
          req.system = context;
          req.transaction = {
            id              : 'fixture',
            identifier      : '',
            requestDateTime : Date.now(),
          };
          next();
        },
      },
      messaging     : {
        /** @param {string} service Servicio. @param {string} action Acción. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Respuesta observada. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return reply;
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const visibility = await fetch(origin + '/directory/contact-visibility');
    assert.equal(visibility.status, 200);
    assert.deepEqual((await visibility.json()).businessResponse, reply.data);
    assert.equal(calls[0].action, 'contact-visibility-get');
    assert.equal(calls[0].options.context, context);
    assert.deepEqual(calls[0].data, {});
    reply = {
      statusCode : 200,
      data       : {
        parameter : 'contact-visibility',
        workspace : 'allWorkspaces',
        revision  : 1,
        data      : reply.data,
      },
    };
    const body  = {
      scope            : 'global',
      data             : reply.data.data,
      expectedRevision : 0,
    };
    const saved = await fetch(origin + '/directory/settings/contact-visibility', {
      method  : 'PATCH',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(body),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).businessResponse, reply.data);
    assert.equal(calls[1].action, 'settings-update');
    assert.deepEqual(calls[1].data, {
      ...body,
      parameter : 'contact-visibility',
    });
    reply = {
      statusCode      : 409,
      descriptionCode : 'DIRECTORY_SETTINGS_REVISION_CONFLICT',
    };
    assert.equal(
      (
        await fetch(origin + '/directory/settings/contact-visibility', {
          method  : 'PATCH',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify(body),
        })
      ).status,
      409,
    );
    authenticated = false;
    assert.equal((await fetch(origin + '/directory/contact-visibility')).status, 401);
    assert.equal(calls.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el servidor temporal. */ (
        resolve,
      ) => server.close(resolve),
    );
  }
});
