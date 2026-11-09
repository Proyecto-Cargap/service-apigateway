/** @file Optimización MCP con aislamiento por solicitud y carga de contratos acotada a tres productores. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  requestPrincipal,
} = require('../server/modules/mcp/services/mcp-request-principal.service');
const { mcpContracts }            = require('../server/modules/mcp/services/mcp-contracts.service');
const { setImmediate: yieldTurn } = require('node:timers/promises');

test('el principal no cruza solicitudes, concesiones, clientes ni workspaces', /** @returns {Promise<void>} Reutiliza sólo la autorización de la misma solicitud y contexto. */ async () => {
  const calls = [];
  /** @param {Object} data Contexto diferente. @returns {Promise<Object>} Autoridad nueva emitida por Security. */
  async function resolve(data) {
    calls.push(data);
    return {
      ...data,
      policies : [],
    };
  }
  const alice  = {
    grantCode : 'a',
    clientId  : 'client',
    workspace : 'A',
    policies  : ['read'],
  };
  const bob    = {
    grantCode : 'b',
    clientId  : 'client',
    workspace : 'B',
    policies  : [],
  };
  const first  = requestPrincipal({
    principal : alice,
    resolve,
  });
  const second = requestPrincipal({
    principal : bob,
    resolve,
  });
  const [a, b] = await Promise.all([first(alice), second(bob)]);
  assert.equal(a, alice);
  assert.equal(b, bob);
  assert.equal(calls.length, 0);
  for (const input of [
    {
      ...alice,
      workspace : 'B',
    },
    {
      ...alice,
      clientId : 'other',
    },
    {
      ...alice,
      grantCode : 'b',
    },
  ]) {
    assert.notEqual(await first(input), alice);
  }
  assert.equal(calls.length, 3);
  const revoked = requestPrincipal({
    principal : {
      ...alice,
      policies : [],
    },
    resolve,
  });
  assert.deepEqual((await revoked(alice)).policies, []);
});

test('contratos independientes se cargan con máximo tres RPC y nunca se devuelve un catálogo parcial', /** @returns {Promise<void>} Mide concurrencia real y propaga un productor indisponible. */ async () => {
  let active  = 0;
  let maximum = 0;
  const seen  = [];
  /** @param {string} service Productor canónico. @param {string} action Acción pública. @returns {Promise<Object>} Contrato sintético sin identidad. */
  async function request(service, action) {
    assert.equal(action, 'service-contracts-get');
    active++;
    maximum = Math.max(maximum, active);
    seen.push(service);
    await yieldTurn();
    active--;
    return {
      statusCode : service === 'bad' ? 503 : 200,
      data       : { service },
    };
  }
  const services = ['a', 'b', 'c', 'd', 'e', 'a'];
  const result   = await mcpContracts({
    services,
    request,
  });
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.deepEqual(Object.keys(result).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(seen.length, 5);
  await assert.rejects(
    mcpContracts({
      services : ['a', 'bad', 'c'],
      request,
    }),
    { statusCode: 503 },
  );
  assert.equal(active, 0);
});
