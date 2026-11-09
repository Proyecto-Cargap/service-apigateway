/** @file Frontera HTTP real de expedientes: identidad vigente, carga acotada y descarga privada. */
'use strict';
const test                    = require('node:test');
const assert                  = require('node:assert/strict');
const fs                      = require('node:fs/promises');
const os                      = require('node:os');
const path                    = require('node:path');
const { once }                = require('node:events');
const { randomUUID }          = require('node:crypto');
const express                 = require('express');
const { enrollmentRoutes }    = require('../server/shared/enrollment.routes');
const { createAuthorization } = require('../server/adapters/http/authorization');
test('ambos dominios exigen contexto vigente, verifican archivos y mantienen descargas privadas', /** @param {Object} t Ciclo de la prueba. @returns {Promise<void>} Acredita middleware real y streaming sin servicios externos. */ async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cargap-enrollment-http-'));
  const calls = [],
    removed   = [];
  const app = express();
  app.use(express.json());
  const dependencies = {
    temporaryFiles : {
      /** @param {Object} file Archivo multipart. @returns {Promise<string>} Temporal privado creado por el adaptador. */
      async createUpload(file) {
        const filename = path.join(directory, randomUUID());
        await fs.writeFile(filename, file.data);
        return filename;
      },
      /** @param {string} filename Temporal del servicio. @returns {Promise<string>} Ruta confinada. */
      async validate(filename) {
        assert.equal(path.dirname(filename), directory);
        return filename;
      },
      /** @param {string} filename Temporal acreditado. @returns {Promise<void>} Limpieza propia. */
      async remove(filename) {
        removed.push(filename);
        await fs.rm(filename, { force: true });
      },
    },
    messaging      : {
      /** @param {string} service Dominio. @param {string} action Acción. @param {Object} data Entrada. @param {Object} options Contexto. @returns {Promise<Object>} Sobre RPC controlado. */
      async request(service, action, data, options) {
        calls.push({
          service,
          action,
          data,
          options,
        });
        if (action === 'enrollment-document-read') {
          const tempFilePath = path.join(directory, randomUUID());
          const bytes        = Buffer.from('%PDF-private');
          await fs.writeFile(tempFilePath, bytes);
          return {
            statusCode : 200,
            data       : {
              tempFilePath,
              mime : 'application/pdf',
              size : bytes.length,
            },
          };
        }
        if (action === 'enrollment-approve')
          return {
            statusCode      : 403,
            descriptionCode : 'ENROLLMENT_REVIEW_FORBIDDEN',
          };
        return {
          statusCode : 200,
          data       : { revision: 2 },
        };
      },
    },
    response       : {
      /** @param {Object} req Petición. @param {Object} res Respuesta. @param {number} status HTTP. @param {Object} data Datos. @returns {Object} Sobre HTTP. */
      send(req, res, status, data) {
        return res.status(status).json(data);
      },
      /** @param {Object} req Petición. @param {Object} res Respuesta. @param {number} status HTTP. @param {string} code Causa. @returns {Object} Rechazo HTTP. */
      sendError(req, res, status, code) {
        return res.status(status).json({ code });
      },
    },
  };
  const previous     = {
    PLATFORM_ID : process.env.PLATFORM_ID,
    ENV_NAME    : process.env.ENV_NAME,
  };
  process.env.PLATFORM_ID = 'cargap';
  process.env.ENV_NAME = 'test';
  t.after(
    /** @returns {void} Restaura la identidad aislada del proceso de pruebas. */ () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  );
  const tokenSecret = 'isolated-enrollment-authorization-test';
  const token       = require('jsonwebtoken').sign({ user: { userCode: 'owner' } }, tokenSecret, {
    ...require('../server/shared/jwt-context').jwtContext('session'),
    expiresIn : 3600,
  });
  /** @param {Object} context Identidad autenticada. @param {Function} next Continuación HTTP. @returns {*} Ejecuta el siguiente middleware. */
  dependencies.messaging.runWithContext = (context, next) => next();
  /** @returns {Promise<string>} Transacción sintética de la petición. */
  dependencies.response.init = async () => 'ENROLLMENT-HTTP-TEST';
  dependencies.authorization = createAuthorization({
    messaging : dependencies.messaging,
    response  : dependencies.response,
    identity  : { id: 'CARGAP' },
    tokenSecret,
    logger    : { /** @returns {void} No registra datos de la prueba. */ error() {} },
    sessions  : {
      /** @param {string} value Credencial efímera. @param {Object} options Modo de autenticación solicitado. @returns {Promise<Object>} Sesión vigente sin lectura externa. */
      async authenticate(value, options) {
        assert.equal(value, token);
        assert.equal(options.currentPolicies, true);
        return {
          userCode        : 'owner',
          sessionId       : 'SESSION-ID',
          sessionCode     : 'S',
          user            : {
            userCode    : 'owner',
            contactCode : 'C',
            userType    : 'human',
            roleCode    : '100-customer',
          },
          policies        : [],
          activeWorkspace : 'WS',
          workspaces      : ['WS'],
          expiration      : Math.floor(Date.now() / 1000) + 3600,
        };
      },
    },
  });
  for (const actor of ['customer', 'supplier']) app.use(enrollmentRoutes(dependencies, actor));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const actor of ['customer', 'supplier']) {
      assert.equal((await fetch(base + '/' + actor + '/enrollment')).status, 401);
      assert.equal(
        (
          await fetch(base + '/' + actor + '/account/me', {
            headers : { Authorization: token },
          })
        ).status,
        200,
      );
      assert.equal(calls.at(-1).options.context.user.userCode, 'owner');
      assert.equal(
        (
          await fetch(base + '/' + actor + '/enrollments/E/approve', {
            method  : 'POST',
            headers : {
              Authorization  : token,
              'Content-Type' : 'application/json',
            },
            body    : '{"expectedRevision":1}',
          })
        ).status,
        403,
      );
      for (const [bytes, expected] of [
        [Buffer.from('%PDF-valid'), 200],
        [Buffer.from('<script>bad</script>'), 400],
        [Buffer.alloc(10485761), 413],
      ]) {
        const form = new FormData();
        form.append(
          'input',
          JSON.stringify({
            requirementCode  : 'fiscal',
            operationCode    : randomUUID(),
            expectedRevision : 1,
          }),
        );
        form.append('document', new Blob([bytes], { type: 'application/pdf' }), 'fiscal.pdf');
        const result = await fetch(base + '/' + actor + '/enrollment/documents', {
          method  : 'POST',
          headers : { Authorization: token },
          body    : form,
        });
        assert.equal(result.status, expected);
        if (expected === 200) {
          assert.equal(calls.at(-1).data.documentUpload.mimeType, 'application/pdf');
          assert.equal(calls.at(-1).data.documentUpload.size, bytes.length);
          assert.match(calls.at(-1).data.documentUpload.digest, /^[0-9a-f]{64}$/);
        }
      }
      const before = calls.length;
      assert.equal(
        (
          await fetch(base + '/' + actor + '/enrollment/documents', {
            method  : 'POST',
            headers : {
              Authorization  : token,
              'Content-Type' : 'application/json',
            },
            body    : '{"documentUpload":{"tempFilePath":"/untrusted"}}',
          })
        ).status,
        400,
      );
      assert.equal(calls.length, before);
      const result = await fetch(base + '/' + actor + '/enrollment/documents/fiscal/1', {
        headers : { Authorization: token },
      });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await result.text(), '%PDF-private');
      assert.equal(calls.at(-1).data.version, 1);
    }
  } finally {
    await new Promise(
      /** @param {Function} resolve Cierre. @returns {void} Libera el puerto. */ (resolve) =>
        server.close(resolve),
    );
    await fs.rm(directory, {
      recursive : true,
      force     : true,
    });
  }
});
