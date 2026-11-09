/** @file Verifica que las rutas canónicas autentican agentes y no confían en identidad del cliente. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  chatAuthorization,
} = require('../server/modules/communication/controllers/chat-authorization');

test('Bearer de agente acredita el workspace; una cabecera sola o un workspace distinto no autoriza' /** @returns {Promise<void>} Rechaza suplantación y conserva la ruta de autenticación humana. */, async () => {
  let nextCalls    = 0;
  let humanCalls   = 0;
  let valid        = true;
  const headers    = {
    'X-Agent-Execution' : '1',
    Authorization       : 'Bearer fixture',
    Workspace           : 'w',
  };
  const req        = {
    /** @param {string} key Cabecera. @returns {string} Valor recibido. */
    get(key) {
      return headers[key];
    },
  };
  const middleware = chatAuthorization({
    authorization : {
      /** @returns {void} Flujo humano existente. */
      authorizationValidation() {
        humanCalls++;
      },
    },
    response      : {
      /** @returns {Promise<void>} Inicializa contexto de respuesta. */
      async init() {},
      /** @param {Object} request Solicitud. @param {Object} response Respuesta. @param {number} status Estado. @returns {number} Rechazo. */
      sendError(request, response, status) {
        return status;
      },
    },
    messaging     : {
      /** @param {string} service Dominio. @param {string} action Acción. @param {Object} data Credencial. @returns {Promise<Object>} Principal verificado. */
      async request(service, action, data) {
        assert.equal(service, 'service-security');
        assert.equal(action, 'agent-principal-authenticate');
        assert.deepEqual(data, { token: 'fixture' });
        return valid
          ? {
              statusCode : 200,
              data       : {
                principal : {
                  actorType : 'agent',
                  workspace : 'w',
                  userCode  : 'a',
                  agentCode : 'agent',
                  runCode   : 'run',
                  policies  : [],
                },
              },
            }
          : {
              statusCode      : 401,
              descriptionCode : 'UNAUTHORIZED',
            };
      },
    },
  });
  /** @returns {void} Registra acceso al controlador. */
  function next() {
    nextCalls++;
  }
  await middleware(req, {}, next);
  assert.equal(req.system.user.userCode, 'a');
  assert.equal(nextCalls, 1);
  headers.Workspace = 'forbidden';
  assert.equal(await middleware(req, {}, next), 403);
  valid = false;
  headers.Workspace = 'w';
  assert.equal(await middleware(req, {}, next), 401);
  delete headers.Authorization;
  assert.equal(await middleware(req, {}, next), 401);
  delete headers['X-Agent-Execution'];
  await middleware(req, {}, next);
  assert.equal(humanCalls, 1);
  assert.equal(nextCalls, 1);
});
