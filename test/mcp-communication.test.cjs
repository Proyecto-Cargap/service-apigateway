/** @file Frontera pública de Comunicación: esquemas cerrados, identidades de intención y capacidades binarias específicas. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const express                  = require('express');
const fs                       = require('node:fs/promises');
const os                       = require('node:os');
const path                     = require('node:path');
const { once }                 = require('node:events');
const { createHash }           = require('node:crypto');
const tools                    = require('../server/modules/mcp/contracts/mcp-tools.json');
const { toolInput }            = require('../server/modules/mcp/presenters/mcp-schema.presenter');
const { mcpExecution }         = require('../server/modules/mcp/services/mcp-execution.service');
const { requestIdentifier }    = require('../server/adapters/mcp/request-identity');
const { transferCapabilities } = require('../server/adapters/mcp/transfer-capabilities');
const { mountTransfers }       = require('../server/modules/mcp/routes/mcp-transfer.routes');
const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');
test('Chat exige intención, revisión y audiencia y excluye autoridad interna del esquema público' /** @returns {Promise<void>} Comprueba contexto y derivación estable del RPC de escritura. */, async () => {
  const tool     = tools.find(
    /** @param {Object} entry Herramienta. @returns {boolean} Envío canónico. */
    (entry) => entry.name === 'chat-send',
  );
  const endpoint = {
    request : {
      type       : 'object',
      properties : {
        code                    : { type: 'string' },
        requestId               : { type: 'string' },
        text                    : { type: 'string' },
        expectedRevision        : { type: 'integer' },
        expectedAudienceVersion : { type: 'string' },
        sourceBindings          : { type: 'array' },
        audioTranscript         : { type: 'string' },
        authorizedDispatch      : { type: 'string' },
      },
      required   : ['code', 'requestId'],
    },
  };
  const schema   = toolInput(endpoint, tool);
  assert.deepEqual(
    schema.required.sort(),
    ['code', 'expectedRevision', 'expectedAudienceVersion', 'idempotencyKey'].sort(),
  );
  for (const name of ['requestId', 'sourceBindings', 'audioTranscript', 'authorizedDispatch'])
    assert.equal(schema.properties[name], undefined);
  assert.equal(schema.properties.text.maxLength, 10000);
  const principal = {
    userCode   : 'u',
    clientId   : 'c',
    grantCode  : 'g',
    workspace  : 'W1',
    workspaces : ['W1'],
    scopes     : ['communication:send'],
    policies   : ['communication.chat.create.global'],
  };
  const calls = [],
    execution = mcpExecution({
      writesEnabled : true,
      requestIdentifier,
      clock         : Date.now,
      /** @returns {Promise<Object>} Consentimiento vigente. */
      async resolve() {
        return principal;
      },
      /** @returns {Promise<void>} Auditoría sin argumentos privados. */
      async audit() {},
      /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Entrada. @param {Object} context Delegación. @returns {Promise<Object>} Captura el contrato RPC sin enviar nada. */
      async request(service, action, data, context) {
        calls.push({
          service,
          action,
          data,
          context,
        });
        return {
          statusCode : 200,
          data       : {},
        };
      },
    });
  const args = {
    code                    : 'chat',
    text                    : 'Texto',
    expectedRevision        : 0,
    expectedAudienceVersion : 'a'.repeat(64),
    idempotencyKey          : 'unique-operation-key',
  };
  await execution.execute(tool, args, principal);
  await execution.execute(tool, args, principal);
  assert.equal(calls[0].data.requestId, calls[1].data.requestId);
  assert.match(calls[0].data.requestId, /^mcp:[a-f0-9]{64}$/);
  assert.equal(calls[0].context.operation.idempotencyKey, args.idempotencyKey);
  assert.equal(calls[0].data.idempotencyKey, undefined);
  assert.notEqual(
    requestIdentifier(
      'chat-send',
      {
        ...principal,
        grantCode : 'other',
      },
      args.idempotencyKey,
    ),
    calls[0].data.requestId,
  );
  assert.equal(
    tools.filter(
      /** @param {Object} entry Acción. @returns {boolean} Agente interno no publicable. */
      (entry) => entry.service === 'service-communication' && entry.name.startsWith('agent-'),
    ).length,
    0,
  );
});
test('transferencias Chat y Timeline usan destinos cerrados, integridad, limpieza y permisos actuales' /** @param {Object} t Ciclo de vida local. @returns {Promise<void>} HTTP real con bytes sintéticos y sin proveedores remotos. */, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-communication-'));
  const temporaryFiles = createTemporaryFiles({ root }),
    app                = express(),
    router             = express.Router();
  const capabilities = transferCapabilities({
    resource   : 'https://example.test/mcp',
    cookieKeys : ['s'.repeat(40)],
  });
  const context      = {
    user       : { userCode: 'u' },
    workspace  : 'W',
    delegation : {
      grantCode : 'g',
      clientId  : 'c',
    },
    operation  : { idempotencyKey: 'unique-operation-key' },
  };
  let revoked = false,
    calls     = 0,
    expectedAction;
  mountTransfers({
    router,
    capabilities,
    temporaryFiles,
    writesEnabled : true,
    /** @returns {Promise<Object>} Permiso revocable durante la descarga. */
    async resolve() {
      return {
        userCode   : 'u',
        workspace  : 'W',
        workspaces : ['W'],
        scopes     : revoked
          ? []
          : [
              'communication:upload',
              'communication:download',
              'communication:write',
              'communication:timeline-read',
            ],
        policies   : [],
      };
    },
    /** @param {string} owner Destino. @param {string} action Acción. @param {Object} data Entrada. @param {Object} actor Contexto. @returns {Promise<Object>} Productor simulado de archivos privados. */
    async request(owner, action, data, actor) {
      calls++;
      assert.equal(owner, 'service-communication');
      assert.equal(action, expectedAction);
      assert.equal(actor.delegation.grantCode, 'g');
      if (action === 'chat-upload' || action === 'chat-group-picture-upload') {
        assert.equal(await fs.readFile(data.tempFilePath, 'utf8'), 'abc');
        if (action === 'chat-upload') {
          assert.equal(data.size, 3);
          assert.match(data.digest, /^[a-f0-9]{64}$/);
          assert.equal(data.byteLength, undefined);
        }
        return {
          statusCode : 200,
          data       : {
            attachmentCode : 'attachment',
            tempFilePath   : '/never-public',
          },
        };
      }
      const file = path.join(root, 'download-' + calls);
      await fs.writeFile(file, 'abc');
      if (data.code === 'revoke') revoked = true;
      return {
        statusCode : 200,
        data       : {
          tempFilePath : file,
          name         : 'foto.png',
        },
      };
    },
  });
  app.use(router);
  app.use(
    /** @param {Error} error Fallo. @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Object} Sobre público de prueba. */
    (error, req, res, next) =>
      res.status(error.statusCode || 500).json({ error: error.descriptionCode }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    /** @returns {Promise<void>} Cierra el servidor y borra exclusivamente sus archivos sintéticos. */
    async () => {
      server.closeAllConnections();
      await new Promise(
        /** @param {Function} done Cierre. @returns {void} Espera el listener propio. */
        (done) => server.close(done),
      );
      await fs.rm(root, {
        recursive : true,
        force     : true,
      });
    },
  );
  const names = [
    'chat-upload-prepare',
    'chat-group-picture-update-prepare',
    'chat-download-prepare',
    'chat-preview-prepare',
    'chat-sender-picture-prepare',
    'chat-group-picture-prepare',
    'timeline-author-picture-prepare',
  ];
  for (const name of names) {
    const tool = tools.find(
      /** @param {Object} entry Herramienta permitida. @returns {boolean} Preparación específica. */
      (entry) => entry.name === name,
    );
    expectedAction = tool.transferAction;
    const ticket   = capabilities.issue(
      tool,
      {
        code                   : 'chat',
        requestId              : 'mcp:request',
        name                   : 'sample.txt',
        byteLength             : 3,
        sha256                 : createHash('sha256').update('abc').digest('hex'),
        expectedPictureVersion : '',
      },
      context,
    );
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + '/mcp/transfers/' + tool.transfer,
      {
        method  : ticket.method,
        headers : ticket.headers,
        ...(ticket.method === 'POST' ? { body: 'abc' } : {}),
      },
    );
    assert.equal(response.status, 200);
    const result = await response.text();
    assert.equal(result.includes('tempFilePath'), false);
  }
  for (let attempt = 0; attempt < 50 && (await fs.readdir(root)).length; attempt++)
    await new Promise(
      /** @param {Function} done Limpieza asíncrona del cierre HTTP. @returns {Object} Espera acotada de recursos propios. */
      (done) => setTimeout(done, 10),
    );
  assert.deepEqual(await fs.readdir(root), []);
  const download = tools.find(
    /** @param {Object} entry Herramienta. @returns {boolean} Descarga. */
    (entry) => entry.name === 'chat-download-prepare',
  );
  expectedAction = download.transferAction;
  const ticket   = capabilities.issue(
    download,
    {
      code           : 'revoke',
      attachmentCode : 'attachment',
    },
    context,
  );
  const response = await fetch(
    'http://127.0.0.1:' + server.address().port + '/mcp/transfers/chat-download',
    { headers: ticket.headers },
  );
  assert.equal(response.status, 403);
  await response.text();
  assert.deepEqual(await fs.readdir(root), []);
});
