/** @file El catálogo de sincronización usa consentimiento documental y contexto independiente por espacio. */
'use strict';
const test             = require('node:test');
const assert           = require('node:assert/strict');
const tools            = require('../server/modules/mcp/contracts/mcp-tools.json');
const { mcpExecution } = require('../server/modules/mcp/services/mcp-execution.service');
test('tickets y manifiestos requieren lectura documental, no exponen consumo interno y conservan el espacio solicitado', /** @returns {Promise<void>} Frontera Gateway/Security y Documents. */ async () => {
  const calls    = [];
  const executor = mcpExecution({
    writesEnabled : false,
    clock         : Date.now,
    /** @param {Object} input Concesión y espacio. @returns {Promise<Object>} Principal vigente. */ async resolve(
      input,
    ) {
      return {
        ...input,
        userCode   : 'U1',
        workspaces : ['W1', 'W2'],
        policies   : [],
        scopes     : ['documents:read'],
      };
    },
    /** @returns {Promise<void>} Sin auditoría externa en la prueba. */ async audit() {},
    /** @param {string} service Servicio. @param {string} action Acción. @param {Object} data Entrada cerrada. @param {Object} context Identidad. @returns {Promise<Object>} Respuesta del productor. */ async request(
      service,
      action,
      data,
      context,
    ) {
      calls.push({
        service,
        action,
        data,
        context,
      });
      return {
        statusCode      : 200,
        descriptionCode : 'OK',
        data            : {},
      };
    },
  });
  for (const name of [
    'oauth-realtime-ticket-create',
    'documents-repository-manifest-get',
    'documents-repository-read',
    'documents-repositories-read',
  ]) {
    const tool = tools.find(
      /** @param {Object} item Herramienta. @returns {boolean} Nombre. */ (item) =>
        item.name === name,
    );
    assert.deepEqual(tool.scopes, ['documents:read']);
    assert.equal(tool.write, false);
    await executor.execute(
      tool,
      { workspaceCode: name.startsWith('oauth') ? 'W1' : 'W2' },
      {
        grantCode : 'G1',
        clientId  : 'C1',
        scopes    : ['documents:read'],
      },
    );
  }
  assert.equal(calls[0].service, 'service-security');
  assert.equal(calls[1].service, 'service-documents');
  assert.equal(calls[2].service, 'service-platform');
  assert.equal(calls[3].service, 'service-platform');
  assert.deepEqual(
    calls.map(
      /** @param {Object} item Ejecución. @returns {string} Espacio. */ (item) =>
        item.context.workspace,
    ),
    ['W1', 'W2', 'W2', 'W2'],
  );
  assert.deepEqual(calls[0].context.delegation, {
    grantCode : 'G1',
    clientId  : 'C1',
  });
  assert.equal(calls[0].context.operation, undefined);
  assert.equal(
    tools.some(
      /** @param {Object} item Herramienta. @returns {boolean} Operación privada. */ (item) =>
        item.name === 'oauth-realtime-ticket-consume',
    ),
    false,
  );
  await assert.rejects(
    executor.execute(
      tools.find(
        /** @param {Object} item Herramienta. @returns {boolean} Emisión. */ (item) =>
          item.name === 'oauth-realtime-ticket-create',
      ),
      { workspaceCode: 'W1' },
      {
        grantCode : 'G1',
        clientId  : 'C1',
        scopes    : [],
      },
    ),
    { statusCode: 403 },
  );
});
