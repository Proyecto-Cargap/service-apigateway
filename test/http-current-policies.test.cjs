/** @file Cada request HTTP acredita políticas vigentes una sola vez, independientemente de las filas. */
'use strict';
const test                      = require('node:test');
const assert                    = require('node:assert/strict');
const jwt                       = require('jsonwebtoken');
const { jwtContext }            = require('../server/shared/jwt-context');
const { createAuthorization }   = require('../server/adapters/http/authorization');
const { sessionAuthentication } = require('../server/adapters/http/session-authentication');

test('la ruta ordinaria y la autorización opcional descartan políticas antiguas de la misma sesión', /** @returns {Promise<void>} Usa middleware y adaptador reales, cambiando Security entre requests. */ async () => {
  process.env.PLATFORM_ID = 'fixture';
  process.env.ENV_NAME = 'test';
  const secret = 'fixture-only-http-policies';
  const token  = jwt.sign(
    {
      user    : { userCode: 'U1' },
      purpose : 'session',
    },
    secret,
    {
      ...jwtContext('session'),
      expiresIn : 60,
    },
  );
  let calls  = 0,
    verified = true,
    policies = ['directory.contact.view.workspace'];
  const messaging     = {
    /** @param {string} target Servicio. @param {string} action Contrato. @param {Object} data Entrada. @returns {Promise<Object>} Simula cambios reales entre peticiones. */
    async request(target, action, data) {
      assert.equal(target, 'service-security');
      assert.equal(action, 'session-authenticate');
      assert.equal(data.currentPolicies, true);
      calls++;
      return {
        statusCode : 200,
        data       : {
          userCode                : 'U1',
          sessionId               : 'S1',
          sessionCode             : 'S1',
          activeWorkspace         : 'W1',
          workspaces              : ['W1'],
          policies,
          currentPoliciesVerified : verified,
          expiration              : Date.now() / 1000 + 600,
        },
      };
    },
    /** @param {Object} context Principal. @param {Function} next Ruta. @returns {*} Ejecuta la operación bajo el contexto acreditado. */
    runWithContext(context, next) {
      return next();
    },
  };
  const authorization = createAuthorization({
    messaging,
    tokenSecret : secret,
    identity    : { id: 'test' },
    sessions    : sessionAuthentication({ messaging }),
    logger      : { /** @returns {void} Omite logs sintéticos. */ error() {} },
    response    : {
      /** @returns {Promise<string>} Identificador técnico de prueba. */ async init() {
        return 'tx';
      },
      /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @returns {void} Conserva denegación. */
      sendError(req, res, status) {
        res.status = status;
      },
    },
  });
  /** @returns {Object} Solicitud nueva con la misma credencial. */
  function request() {
    return {
      query   : {},
      headers : {},
      /** @returns {string} Credencial sintética. */ get() {
        return 'Bearer ' + token;
      },
    };
  }
  const first = request();
  let rows;
  await authorization.authorizationValidation(
    first,
    {},
    /** @returns {void} Página autorizada por un único contexto. */ () => {
      assert.deepEqual(first.system.policies, ['directory.contact.view.workspace']);
      rows = Array.from(
        { length: 50 },
        /** @param {*} ignored Vacío. @param {number} i Posición. @returns {number} Registro sintético. */ (
          _,
          i,
        ) => i,
      );
    },
  );
  assert.equal(rows.length, 50);
  assert.equal(calls, 1);
  policies = [];
  const second = request();
  await authorization.optionalAuthorization(
    second,
    {},
    /** @returns {void} El nuevo request observa la retirada. */ () => {
      assert.deepEqual(second.system.policies, []);
    },
  );
  assert.equal(calls, 2);
  verified = false;
  const res = {};
  await authorization.authorizationValidation(
    request(),
    res,
    /** @returns {void} Un principal sin comprobación no ejecuta negocio. */ () => {
      assert.fail('No debe continuar');
    },
  );
  assert.equal(res.status, 503);
  assert.equal(calls, 3);
});
