/** @file Pruebas de comportamiento de authorization.test en service-apigateway. */
'use strict';
const test                      = require('node:test');
const assert                    = require('node:assert/strict');
const { sessionAuthentication } = require('../server/adapters/http/session-authentication');
/**
 * Ejecuta identity dentro del flujo de authorization.test.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
const identity                  = () => ({
  sessionId       : 'id',
  sessionCode     : 's',
  userCode        : 'u',
  activeWorkspace : 'w',
  workspaces      : ['w'],
  policies        : ['read'],
  expiration      : Date.now() / 1000 + 3600,
});

test('políticas vigentes se solicitan por operación y fallan cerrado si Security no las confirma' /** @returns {Promise<void>} La misma sesión refleja la retirada de permisos sin modificar las rutas ordinarias. */, async () => {
  let policies  = ['connect.mail-account.update.owner'];
  let verified  = true;
  const calls   = [];
  const adapter = sessionAuthentication({
    messaging : {
      /** @param {string} service Destino. @param {string} action Operación. @param {Object} data Solicitud. @returns {Promise<Object>} Security de prueba con cambios entre solicitudes. */
      async request(service, action, data) {
        calls.push(data);
        return {
          statusCode : 200,
          data       : {
            ...identity(),
            policies,
            currentPoliciesVerified : verified,
          },
        };
      },
    },
  });
  assert.deepEqual(
    (await adapter.authenticate('same-token', { currentPolicies: true })).policies,
    policies,
  );
  policies = [];
  assert.deepEqual(
    (await adapter.authenticate('same-token', { currentPolicies: true })).policies,
    [],
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      /** @param {Object} call Datos solicitados. @returns {boolean} Siempre recalcula en Security. */ (
        call,
      ) => call.currentPolicies === true,
    ),
  );
  verified = false;
  await assert.rejects(adapter.authenticate('same-token', { currentPolicies: true }), {
    statusCode : 503,
  });
  await adapter.authenticate('same-token');
  assert.equal(calls.at(-1).currentPolicies, undefined);
});
test('session adapter uses only the Security contract and requests bounded access refresh' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const expected = identity();
  let calls      = 0;
  const sessions = sessionAuthentication({
    messaging : {
      /**
       * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
       * @param {...*} args Valor de args utilizado por esta operación.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      request : async (...args) => {
        calls++;
        assert.deepEqual(args, [
          'service-security',
          'session-authenticate',
          {
            token         : 'token',
            refreshAccess : true,
          },
          {
            context   : {},
            timeoutMs : 8000,
          },
        ]);
        return {
          statusCode : 200,
          data       : expected,
        };
      },
    },
  });
  assert.deepEqual(await sessions.authenticate('token'), expected);
  assert.equal(calls, 1);
});
test('revocation, unavailable Security, and malformed identity fail closed' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  for (const response of [
    { statusCode: 401 },
    { statusCode: 503 },
    {
      statusCode : 200,
      data       : {
        ...identity(),
        activeWorkspace : 'other',
      },
    },
    {
      statusCode : 200,
      data       : {
        ...identity(),
        expiration : 0,
      },
    },
  ]) {
    const sessions = sessionAuthentication({
      messaging : {
        /**
         * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        request : async () => response,
      },
    });
    await assert.rejects(
      sessions.authenticate('token'),

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {*} e Valor de e utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (e) => e.statusCode === (response.statusCode === 503 ? 503 : 401),
    );
  }
});
test('middleware preserves human context and delegates agents to their existing capability' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  process.env.PLATFORM_ID = 'fixture';
  process.env.ENV_NAME = 'test';
  const jwt                     = require('jsonwebtoken');
  const { jwtContext }          = require('../server/shared/jwt-context');
  const { createAuthorization } = require('../server/adapters/http/authorization');
  const secret                  = 'fixture-only';
  let nextCalls = 0,
    requests    = 0;
  const authorization = createAuthorization({
    tokenSecret : secret,
    identity    : { id: 'test' },
    logger      : {
      /**
       * Ofrece el punto de extensión error sin efectos por defecto.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      error() {},
    },
    response    : {
      /**
       * Ejecuta init dentro del flujo de authorization.test.
       * @returns {Promise<string>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      init      : async () => 'txn',

      /**
       * Ejecuta sendError dentro del flujo de authorization.test.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @param {Object} res Respuesta HTTP que completa la solicitud.
       * @param {string} code Identificador público del recurso.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      sendError : (req, res, code) => {
        res.status = code;
      },
    },
    sessions    : {
      /**
       * Ejecuta authenticate dentro del flujo de authorization.test.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      authenticate : async () => ({
        ...identity(),
        user : {
          userCode    : 'u',
          contactCode : 'contact',
        },
      }),
    },
    messaging   : {
      /**
       * Ejecuta runWithContext dentro del flujo de authorization.test.
       * @param {Object} context Contexto de identidad y alcance de la operación.
       * @param {Function} next Continuación de la cadena de middleware.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      runWithContext : (context, next) => {
        assert.equal(context.user.userCode, 'u');
        return next();
      },
      /**
       * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
       * @param {*} service Valor de service utilizado por esta operación.
       * @param {string} action Valor de action utilizado por esta operación.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      request        : async (service, action) => {
        requests++;
        assert.equal(action, 'agent-principal-authenticate');
        return {
          statusCode : 200,
          data       : {
            expiration : Date.now() / 1000 + 300,
            principal  : {
              actorType  : 'agent',
              userCode   : 'u',
              agentCode  : 'a',
              runCode    : 'r',
              workspace  : 'w',
              workspaces : ['w'],
              policies   : [],
            },
          },
        };
      },
    },
  });
  for (const purpose of ['session', 'agent_execution']) {
    const token = jwt.sign(
      {
        purpose,
        user : {
          userCode : 'u',
          userType : 'human',
        },
      },
      secret,
      {
        ...jwtContext(purpose),
        expiresIn : 60,
      },
    );
    const req = {
        /**
         * Obtiene el valor solicitado.
         * @returns {string} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        get     : () => `Bearer ${token}`,
        query   : { geolocation: '1,2' },
        headers : {},
      },
      res     = {};
    await authorization.authorizationValidation(
      req,
      res,

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {
        nextCalls++;
      },
    );
    assert.equal(res.status, undefined);
    assert.equal(req.system.idTransaction, 'txn');
    assert.equal(req.system.workspace, 'w');
    if (purpose === 'session') {
      assert.equal(req.system.idSession, 'id');
      assert.equal(req.system.sessionCode, 's');
      assert.equal(req.system.user.contactCode, 'contact');
    }
  }
  assert.equal(nextCalls, 2);
  assert.equal(requests, 1);
});

test('un fallo de transporte de Security conserva la condición de indisponibilidad' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const adapter = sessionAuthentication({
    messaging : {
      /**
       * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
       * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
       */
      request : async () => {
        throw new Error('sin conexión');
      },
    },
  });
  await assert.rejects(
    adapter.authenticate('token'),

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Error} error Fallo recibido por la continuación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (error) => error.statusCode === 503,
  );
});
