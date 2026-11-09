/** @file La reutilización de validadores conserva aislamiento, consentimiento y contratos vigentes. */
'use strict';
const test                 = require('node:test');
const assert               = require('node:assert/strict');
const express              = require('express');
const { createMcpRequest } = require('../server/adapters/mcp/mcp-server');
const tools                = require('../server/modules/mcp/contracts/mcp-tools.json');
/** @param {string} requiredField Campo de la versión canónica simulada. @returns {Object} Contratos independientes de identidades o concesiones. */
function contractsFor(requiredField) {
  const contracts = {};
  for (const tool of tools) {
    contracts[tool.service] ||= { endpoints: [] };
    contracts[tool.service].endpoints.push({
      name        : tool.name,
      request     : {
        type                 : 'object',
        properties           : { [requiredField]: { type: 'string' } },
        required             : [requiredField],
        additionalProperties : false,
      },
      successData : {
        type                 : 'object',
        properties           : { actor: { type: 'string' } },
        required             : ['actor'],
        additionalProperties : false,
      },
    });
  }
  return contracts;
}
/** @param {Object} t Ciclo de la prueba. @returns {Promise<Object>} Transporte SDK real con conexiones exclusivamente sintéticas. */
async function fixture(t) {
  const state = {
    contracts     : contractsFor('label'),
    writesEnabled : true,
    connections   : {
      alice : {
        userCode   : 'alice',
        workspaces : ['WA'],
        scopes     : ['customer:read', 'customer:write'],
      },
      bob   : {
        userCode   : 'bob',
        workspaces : ['WB'],
        scopes     : ['customer:read'],
      },
    },
    calls         : [],
  };
  const app   = express();
  app.use(express.json());
  app.post(
    '/:identity',
    /** @param {Object} req Solicitud local. @param {Object} res Respuesta. @returns {Promise<void>} Cada petición construye su servidor y sus callbacks propios. */ async (
      req,
      res,
    ) => {
      const connection = state.connections[req.params.identity];
      await createMcpRequest({
        contracts     : state.contracts,
        connection,
        writesEnabled : state.writesEnabled,
        execution     : {
          /** @param {Object} tool Operación. @param {Object} args Argumentos. @param {Object} principal Conexión de esta ejecución. @returns {Promise<Object>} Devuelve sólo la identidad sintética para comprobar concurrencia. */
          async execute(tool, args, principal) {
            await Promise.resolve();
            state.calls.push({
              tool     : tool.name,
              args,
              userCode : principal.userCode,
            });
            return {
              statusCode      : 200,
              descriptionCode : 'OK',
              data            : { actor: principal.userCode },
            };
          },
        },
      })(req, res);
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise(
    /** @param {Function} resolve Listener disponible. @returns {void} Espera sólo el servidor de prueba. */ (
      resolve,
    ) => server.once('listening', resolve),
  );
  t.after(
    /** @returns {Promise<void>} Libera todas las conexiones sintéticas. */ async () => {
      server.closeAllConnections();
      await new Promise(
        /** @param {Function} resolve Cierre. @returns {void} Finaliza el listener. */ (resolve) =>
          server.close(resolve),
      );
    },
  );
  /** @param {string} identity Cuenta sintética. @param {string} method Método MCP. @param {Object} params Parámetros públicos. @returns {Promise<Object>} Resultado JSON-RPC sobre el transporte HTTP oficial. */
  async function request(identity, method, params = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/' + identity, {
      method  : 'POST',
      headers : {
        'Content-Type'         : 'application/json',
        Accept                 : 'application/json, text/event-stream',
        'MCP-Protocol-Version' : '2025-11-25',
      },
      body    : JSON.stringify({
        jsonrpc : '2.0',
        id      : 1,
        method,
        params,
      }),
    });
    assert.equal(response.status, 200);
    const text    = await response.text();
    const payload = response.headers.get('content-type').includes('text/event-stream')
      ? text
          .split('\n')
          .find(
            /** @param {string} line Línea SSE. @returns {boolean} Resultado del SDK. */ (line) =>
              line.startsWith('data:'),
          )
          .slice(5)
      : text;
    return JSON.parse(payload);
  }
  return {
    state,
    request,
  };
}
test('catálogo preparado conserva permisos, validación e identidades de solicitudes concurrentes', /** @param {Object} t Prueba aislada. @returns {Promise<void>} Comprueba que compartir esquemas no comparte autoridad ni callbacks. */ async (t) => {
  const f     = await fixture(t);
  const alice = await f.request('alice', 'tools/list');
  assert.ok(
    alice.result.tools.some(
      /** @param {Object} tool Herramienta pública. @returns {boolean} Escritura autorizada. */ (
        tool,
      ) => tool.name === 'customer-create',
    ),
  );
  const bob = await f.request('bob', 'tools/list');
  assert.ok(
    bob.result.tools.every(
      /** @param {Object} tool Herramienta pública. @returns {boolean} Sólo lectura después de preparar escrituras para otra cuenta. */ (
        tool,
      ) => tool.annotations.readOnlyHint,
    ),
  );
  const denied = await f.request('bob', 'tools/call', {
    name      : 'customer-create',
    arguments : {
      label          : 'test',
      idempotencyKey : '00000000-0000-4000-8000-000000000003',
    },
  });
  assert.ok(denied.error || denied.result?.isError);
  assert.equal(f.state.calls.length, 0);
  const missingKey = await f.request('alice', 'tools/call', {
    name      : 'customer-create',
    arguments : { label: 'test' },
  });
  assert.ok(missingKey.error || missingKey.result?.isError);
  assert.equal(f.state.calls.length, 0);
  const [contextA, contextB, readA, readB] = await Promise.all([
    f.request('alice', 'tools/call', {
      name      : 'xidden-context-get',
      arguments : {},
    }),
    f.request('bob', 'tools/call', {
      name      : 'xidden-context-get',
      arguments : {},
    }),
    f.request('alice', 'tools/call', {
      name      : 'customer-get-list',
      arguments : { label: 'A' },
    }),
    f.request('bob', 'tools/call', {
      name      : 'customer-get-list',
      arguments : { label: 'B' },
    }),
  ]);
  assert.equal(contextA.result.structuredContent.data.userCode, 'alice');
  assert.deepEqual(contextA.result.structuredContent.data.workspaces, ['WA']);
  assert.equal(contextB.result.structuredContent.data.userCode, 'bob');
  assert.deepEqual(contextB.result.structuredContent.data.workspaces, ['WB']);
  assert.equal(readA.result.structuredContent.data.actor, 'alice');
  assert.equal(readB.result.structuredContent.data.actor, 'bob');
  f.state.writesEnabled = false;
  const disabled = await f.request('alice', 'tools/list');
  assert.ok(
    disabled.result.tools.every(
      /** @param {Object} tool Herramienta pública. @returns {boolean} La configuración se evalúa en cada petición. */ (
        tool,
      ) => tool.annotations.readOnlyHint,
    ),
  );
  f.state.connections.alice.scopes = [];
  const reduced = await f.request('alice', 'tools/list');
  assert.deepEqual(
    reduced.result.tools.map(
      /** @param {Object} tool Herramienta. @returns {string} Nombre público. */ (tool) =>
        tool.name,
    ),
    ['xidden-context-get'],
  );
});
test('un contrato nuevo invalida sus validadores sin reutilizar la versión anterior', /** @param {Object} t Prueba aislada. @returns {Promise<void>} Rechaza entradas obsoletas tras reemplazar el catálogo canónico. */ async (t) => {
  const f = await fixture(t);
  await f.request('alice', 'tools/list');
  f.state.contracts = contractsFor('updatedLabel');
  const obsolete = await f.request('alice', 'tools/call', {
    name      : 'customer-create',
    arguments : {
      label          : 'old',
      idempotencyKey : '00000000-0000-4000-8000-000000000003',
    },
  });
  assert.ok(obsolete.error || obsolete.result?.isError);
  assert.equal(f.state.calls.length, 0);
  const accepted = await f.request('alice', 'tools/call', {
    name      : 'customer-create',
    arguments : {
      updatedLabel   : 'new',
      idempotencyKey : '00000000-0000-4000-8000-000000000003',
    },
  });
  assert.equal(accepted.result.isError, false);
  assert.equal(accepted.result.structuredContent.data.actor, 'alice');
  assert.equal(f.state.calls.length, 1);
});
