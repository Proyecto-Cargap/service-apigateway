/** @file Frontera de herramientas: aislamiento concurrente, consentimiento, esquemas y resultados inciertos. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { mcpExecution }           = require('../server/modules/mcp/services/mcp-execution.service');
const { mcpConfig }              = require('../server/adapters/mcp/mcp-config');
const { toolInput, publicValue } = require('../server/modules/mcp/presenters/mcp-schema.presenter');
const tools                      = require('../server/modules/mcp/contracts/mcp-tools.json');
test('ejecuciones concurrentes mantienen principal, workspace y recibo independientes', /** @returns {Promise<void>} Comprueba que nunca comparten contexto mutable. */ async () => {
  const calls = [],
    audit     = [];
  const executor = mcpExecution({
    writesEnabled                                                                       : true,
    clock                                                                               : Date.now,
    /** @param {Object} value Traza. @returns {number} Captura sólo metadatos. */ audit : (value) =>
      audit.push(value),
    /** @param {Object} input Concesión. @returns {Promise<Object>} Principal específico de cada solicitud. */ async resolve(
      input,
    ) {
      await Promise.resolve();
      return {
        ...input,
        userCode   : input.grantCode,
        workspace  : input.workspace,
        workspaces : [input.workspace],
        scopes     : ['customer:write'],
        policies   : ['customer.customer.create.workspace'],
      };
    },
    /** @param {string} service Destino. @param {string} name Acción. @param {Object} data Cuerpo. @param {Object} context Principal. @returns {Promise<Object>} Respuesta de negocio independiente. */ async request(
      service,
      name,
      data,
      context,
    ) {
      await Promise.resolve();
      calls.push({
        data,
        context,
      });
      return {
        statusCode      : 201,
        descriptionCode : 'OK',
        data            : { customerCode: context.user.userCode },
      };
    },
  });
  const tool     = {
    service              : 'service-customer',
    name                 : 'customer-create',
    scopes               : ['customer:write'],
    write                : true,
    canonicalIdempotency : true,
  };
  await Promise.all(
    ['A', 'B'].map(
      /** @param {string} identity Identidad. @returns {Promise<Object>} Llamada simultánea. */ (
        identity,
      ) =>
        executor.execute(
          tool,
          {
            workspaceCode  : 'W' + identity,
            idempotencyKey : 'operation-key-' + identity,
            tradeName      : identity,
          },
          {
            grantCode : identity,
            clientId  : 'C' + identity,
            scopes    : ['customer:write'],
          },
        ),
    ),
  );
  for (const call of calls) {
    const identity = call.context.user.userCode;
    assert.equal(call.context.workspace, 'W' + identity);
    assert.equal(call.context.delegation.clientId, 'C' + identity);
    assert.equal(call.data.idempotencyKey, 'operation-key-' + identity);
    assert.equal(call.data.workspaceCode, undefined);
  }
  assert.equal(JSON.stringify(audit).includes('tradeName'), false);
  await assert.rejects(
    executor.execute(
      tool,
      { workspaceCode: 'WA' },
      {
        grantCode : 'A',
        scopes    : [],
      },
    ),
    { statusCode: 403 },
  );
});
test('un timeout de escritura no se reintenta y devuelve incertidumbre', /** @returns {Promise<void>} Impide repetir automáticamente un efecto externo. */ async () => {
  let count      = 0;
  const executor = mcpExecution({
    writesEnabled : true,
    clock         : Date.now,
    /** @returns {void} Sin efectos. */ audit() {},
    /** @returns {Promise<Object>} Principal consentido. */ async resolve() {
      return {
        workspace : 'W1',
        scopes    : ['quotation:send'],
      };
    },
    /** @returns {Promise<void>} Simula respuesta perdida. */ async request() {
      count++;
      throw new Error('timeout');
    },
  });
  await assert.rejects(
    executor.execute(
      {
        write  : true,
        scopes : ['quotation:send'],
      },
      { idempotencyKey: 'original-operation-key' },
      { scopes: ['quotation:send'] },
    ),
    { descriptionCode: 'MCP_OPERATION_RESULT_UNKNOWN' },
  );
  assert.equal(count, 1);
});
test('esquemas eliminan autoridad y secretos pero conservan el destino de un emisor', /** @returns {void} Diferencia recurso global de contexto global. */ () => {
  const endpoint = {
    request : {
      type       : 'object',
      properties : {
        workspace : { type: 'string' },
        scope     : { type: 'string' },
        condition : { type: 'object' },
        name      : { type: 'string' },
      },
      required   : ['workspace'],
    },
  };
  const normal   = toolInput(endpoint, { write: true });
  assert.equal(normal.properties.workspace, undefined);
  assert.equal(normal.properties.condition, undefined);
  assert.ok(normal.required.includes('idempotencyKey'));
  assert.equal(normal.additionalProperties, false);
  const issuer = toolInput(endpoint, {
    write             : true,
    resourceWorkspace : true,
  });
  assert.ok(issuer.required.includes('workspace'));
  assert.ok(issuer.properties.workspaceCode);
  assert.deepEqual(
    publicValue({
      data : {
        code   : 'A',
        nested : {
          token        : 'secret',
          tempFilePath : '/tmp/private',
          _id          : 'private',
        },
      },
    }),
    {
      data : {
        code   : 'A',
        nested : {},
      },
    },
  );
  assert.equal(mcpConfig({}), null);
  assert.throws(
    /** @returns Configuración insuficiente. */ () =>
      mcpConfig({
        MCP_ENABLED    : 'true',
        MCP_PUBLIC_URL : 'http://api.test/mcp',
        MCP_WEB_ORIGIN : 'https://web.test',
      }),
    /INVALID_MCP_PUBLIC_URL/,
  );
});
