/** @file Frontera HTTP Customer: rutas canónicas, tipos de query, revisión y contexto autenticado sin suplantación. */
'use strict';
const test             = require('node:test');
const assert           = require('node:assert/strict');
const { once }         = require('node:events');
const express          = require('express');
const { createRouter } = require('../server/modules/customer/routes/routes');
test('rutas Customer conservan revisiones numéricas y contexto, y no publican Company o sucursales' /** @returns {Promise<void>} Verifica el adaptador HTTP real con RPC sustituible y servidor efímero. */, async () => {
  const calls = [],
    app       = express();
  app.use(express.json());
  app.use(
    createRouter({
      authorization : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Instala contexto acreditado de prueba. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'alice' },
            workspace : 'workspace-a',
          };
          next();
        },
      },
      messaging     : {
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Payload. @param {Object} options Contexto. @returns {Promise<Object>} Sobre de negocio. */
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
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado HTTP. @param {Object} data Contenido. @returns {Object} Respuesta emitida. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado HTTP. @param {string} descriptionCode Causa pública. @returns {Object} Error emitido. */
        sendError(req, res, status, descriptionCode) {
          return res.status(status).json({ descriptionCode });
        },
      },
      logger        : {
        /** @returns {void} Sin registros de cargas. */
        error() {},
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal(
      (await fetch(base + '/customer/activity?opportunityCode=opp-a&state=pending&page=2')).status,
      200,
    );
    assert.equal(calls.at(-1).action, 'activity-get-list');
    assert.equal(calls.at(-1).data.opportunityCode, 'opp-a');
    assert.equal(calls.at(-1).data.state, 'pending');
    assert.equal(calls.at(-1).options.context.workspace, 'workspace-a');
    await fetch(base + '/customer/activity/activity-a', {
      method  : 'PATCH',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        state            : 'completed',
        expectedRevision : 3,
      }),
    });
    assert.deepEqual(calls.at(-1).data, {
      activityCode     : 'activity-a',
      state            : 'completed',
      expectedRevision : 3,
    });
    for (const resource of ['customer', 'pipeline-type', 'pipeline', 'opportunity', 'activity']) {
      assert.equal(
        (await fetch(base + '/customer/' + resource + '?page=2&perPage=20')).status,
        200,
      );
      const call = calls.at(-1);
      assert.equal(call.action, resource + '-get-list');
      assert.equal(call.data.page, 2);
      assert.equal(call.data.perPage, 20);
      assert.equal(call.options.context.user.userCode, 'alice');
      assert.equal(
        (
          await fetch(base + '/customer/' + resource + '/record?expectedRevision=3', {
            method : 'DELETE',
          })
        ).status,
        200,
      );
      assert.equal(calls.at(-1).data.expectedRevision, 3);
    }
    assert.equal(
      (await fetch(base + '/customer/opportunity/summary?pipelineCode=PIP-local&search=Venta'))
        .status,
      200,
    );
    assert.equal(calls.at(-1).action, 'opportunity-get-summary');
    assert.equal(calls.at(-1).data.pipelineCode, 'PIP-local');
    assert.equal(calls.at(-1).data.search, 'Venta');
    assert.equal(calls.at(-1).options.context.workspace, 'workspace-a');
    assert.equal(
      (await fetch(base + '/customer/pipeline/PIP-local/assignees?codes=alice,bob,alice')).status,
      200,
    );
    assert.equal(calls.at(-1).action, 'pipeline-get-assignees');
    assert.deepEqual(calls.at(-1).data.codes, ['alice', 'bob']);
    assert.equal(calls.at(-1).options.context.workspace, 'workspace-a');
    assert.equal(
      (
        await fetch(
          base +
            '/customer/pipeline/PIP-local/customers?codes=company,person,company&pipelineCode=forged',
        )
      ).status,
      200,
    );
    assert.equal(calls.at(-1).action, 'pipeline-get-customers');
    assert.deepEqual(calls.at(-1).data, {
      pipelineCode : 'PIP-local',
      codes        : ['company', 'person'],
    });
    assert.equal(calls.at(-1).options.context.workspace, 'workspace-a');
    assert.equal((await fetch(base + '/directory/company')).status, 404);
    assert.equal((await fetch(base + '/directory/company/record/branch')).status, 404);
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre del servidor propio. @returns {void} Libera el puerto efímero. */
      (resolve) => server.close(resolve),
    );
  }
});

test('Customer coordina multipart en altas y cambios sin aceptar temporales desde JSON' /** @returns {Promise<void>} Comprueba middleware real, contexto, timeout y limpieza del temporal. */, async () => {
  const calls = [],
    removed   = [],
    app       = express();
  app.use(express.json());
  app.use(
    createRouter({
      authorization  : {
        /** @param {Object} req Petición. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Instala identidad acreditada. */
        authorizationValidation(req, res, next) {
          req.system = {
            user      : { userCode: 'alice' },
            workspace : 'workspace-a',
          };
          next();
        },
      },
      temporaryFiles : {
        /** @param {Object} file Parte binaria. @returns {Promise<string>} Simula un temporal administrado sin escribir fuera de la prueba. */
        async createUpload(file) {
          assert.equal(file.name, 'logo.png');
          assert.equal(file.data.toString(), 'local-image');
          return '/isolated/logo.png';
        },
        /** @param {string} filename Temporal administrado. @returns {Promise<void>} Registra la limpieza propia. */
        async remove(filename) {
          removed.push(filename);
        },
      },
      messaging      : {
        /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Respuesta canónica. */
        async request(service, action, data, options) {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : action === 'customer-create' ? 201 : 200,
            data       : {},
          };
        },
      },
      response       : {
        /** @param {Object} req Petición. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Datos. @returns {Object} Respuesta HTTP. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Petición. @param {Object} res Respuesta. @param {number} status Estado. @param {string} descriptionCode Causa. @returns {Object} Rechazo HTTP. */
        sendError(req, res, status, descriptionCode) {
          return res.status(status).json({ descriptionCode });
        },
      },
      logger         : { /** @returns {void} No registra datos de la petición. */ error() {} },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const method of ['POST', 'PATCH']) {
      const form = new FormData();
      form.append(
        'input',
        JSON.stringify({
          type             : 'company',
          tradeName        : 'Empresa',
          expectedRevision : 2,
        }),
      );
      form.append(
        'pictureOptions',
        JSON.stringify({
          fileId           : '9a7c9c67-25da-4a4a-9123-45086d210d31',
          visibility       : 'public',
          generateVariants : true,
        }),
      );
      form.append('picture', new Blob(['local-image'], { type: 'image/png' }), 'logo.png');
      const response = await fetch(
        base + '/customer/customer' + (method === 'PATCH' ? '/CUS-local' : ''),
        {
          method,
          body : form,
        },
      );
      assert.equal(response.status, method === 'POST' ? 201 : 200);
      assert.equal(calls.at(-1).data.pictureUpload.tempFilePath, '/isolated/logo.png');
      assert.equal(calls.at(-1).options.timeoutMs, 310000);
      assert.equal(calls.at(-1).options.context.user.userCode, 'alice');
      if (method === 'PATCH') assert.equal(calls.at(-1).data.customerCode, 'CUS-local');
    }
    assert.equal(removed.length, 2);
    await fetch(base + '/customer/customer', {
      method  : 'POST',
      headers : { 'content-type': 'application/json' },
      body    : JSON.stringify({
        tradeName     : 'Empresa',
        pictureUpload : { tempFilePath: '/untrusted' },
      }),
    });
    assert.equal(calls.at(-1).data.pictureUpload, undefined);
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre del servidor propio. @returns {void} Libera el puerto. */
      (resolve) => server.close(resolve),
    );
  }
});
