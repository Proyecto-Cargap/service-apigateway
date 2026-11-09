/** @file HTTP Meta local: secretos sellados, cuerpo firmado exacto y acuse condicionado a persistencia. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { once }                   = require('node:events');
const { createDecipheriv }       = require('node:crypto');
const express                    = require('express');
const response                   = require('../server/adapters/http/response');
const { metaRequestCredentials } = require('../server/adapters/crypto/meta-request-credentials');
const { metaController }         = require('../server/modules/connect/controllers/meta.controller');
const {
  metaPublicController,
} = require('../server/modules/connect/controllers/meta-public.controller');
const key = Buffer.alloc(32, 9);
/** Descifra sólo datos ficticios para acreditar compatibilidad de AAD y wire format.
 * @param {string} value Campo sellado.
 * @param {string} field Campo de credencial.
 * @returns {string} Texto ficticio original.
 */
function open(value, field) {
  assert.match(value, /^meta1\./);
  const bytes    = Buffer.from(value.slice(6), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  decipher.setAAD(Buffer.from(`meta-request:${field}`));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
}
/** @param {Function} callback Prueba que necesita HTTP real. @returns {Promise<void>} Libera listener incluso si falla la prueba. */
async function withHttp(callback) {
  const calls = [],
    state     = {
      fail     : false,
      policies : ['connect.meta.view.global', 'connect.meta.update.global'],
    };
  const app          = express();
  const dependencies = {
    messaging           : {
      /** @param {string} target Servicio. @param {string} action Acción. @param {Object} data DTO sellado. @param {Object} options Contexto. @returns {Promise<Object>} Respuesta durable controlada. */
      async request(target, action, data, options) {
        calls.push({
          target,
          action,
          data,
          options,
        });
        return state.fail
          ? {
              statusCode      : 503,
              descriptionCode : 'META_UNAVAILABLE',
            }
          : {
              statusCode : 200,
              data       : action === 'meta-webhook-verify' ? { challenge: data.challenge } : null,
            };
      },
    },
    sealMetaCredentials : metaRequestCredentials(key.toString('base64')),
    response,
    authorization       : {
      /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Promise<void>} Identidad del servidor y permisos actuales. */
      async authorizationValidation(req, res, next) {
        await response.init(req);
        req.system = {
          user     : { userCode: 'admin' },
          policies : state.policies,
        };
        next();
      },
    },
  };
  app.use(metaPublicController(dependencies));
  app.use(express.json());
  app.use(metaController(dependencies));
  app.use(require('../server/adapters/http/errors').handleError);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, calls, state);
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} resolve Confirma cierre del listener. @returns {Object} Listener cerrado. */
      (resolve) => server.close(resolve),
    );
  }
}
test('settings y conexiones nunca envían secretos planos a MQ; rechazan claves ajenas antes del transporte' /** @returns {Promise<void>} Recorre HTTP real y descifra sólo fixtures. */, async () =>
  withHttp(
    /** @param {string} base URL local. @param {Object[]} calls RPC observadas. @param {Object} state Permisos actuales. @returns {Promise<void>} Validación de frontera. */
    async (base, calls, state) => {
      const body  = {
        revision : 0,
        data     : {
          enabled            : true,
          appId              : 'app',
          graphVersion       : 'v26.0',
          publicBaseUrl      : 'https://example.test',
          workspaceCode      : 'w',
          contactRoleCode    : 'role',
          externalGroupCodes : [],
          appSecret          : 'app-private',
          verifyToken        : 'verify-private',
        },
      };
      const saved = await fetch(base + '/connect/meta/settings', {
        method  : 'PUT',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify(body),
      });
      assert.equal(saved.status, 200);
      assert.equal(open(calls.at(-1).data.data.appSecret, 'appSecret'), 'app-private');
      assert.equal(open(calls.at(-1).data.data.verifyToken, 'verifyToken'), 'verify-private');
      assert(!JSON.stringify(calls).includes('app-private'));
      assert.equal(calls.at(-1).options.context.user.userCode, 'admin');
      const prior = calls.length;
      for (const invalid of [
        {
          ...body,
          userCode : 'victim',
        },
        {
          ...body,
          data : {
            ...body.data,
            accessToken : 'unsealed',
          },
        },
      ]) {
        assert.equal(
          (
            await fetch(base + '/connect/meta/settings', {
              method  : 'PUT',
              headers : { 'Content-Type': 'application/json' },
              body    : JSON.stringify(invalid),
            })
          ).status,
          400,
        );
      }
      assert.equal(calls.length, prior);
      state.policies = ['connect.meta.view.global'];
      assert.equal(
        (
          await fetch(base + '/connect/meta/settings', {
            method  : 'PUT',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify(body),
          })
        ).status,
        403,
      );
      assert.equal(calls.length, prior);
      const get = await fetch(base + '/connect/meta/conversations/unlinked');
      assert.equal((await get.json()).businessResponse, null);
    },
  ));
test('Instagram Facebook transmite modalidad y Página explícitas con PAT sellado', /** @returns {Promise<void>} Campos administrativos concretos no permiten estrategias ni tipos de token arbitrarios. */ async () =>
  withHttp(
    /** @param {string} base URL local. @param {Object[]} calls RPC observadas. @returns {Promise<void>} Frontera HTTP y cifrado antes de MQ. */
    async (base, calls) => {
      const body     = {
        revision : 0,
        data     : {
          name              : 'IG propio',
          channel           : 'instagram',
          assetId           : 'ig',
          instagramAuthMode : 'facebook_login',
          pageId            : 'page',
          accessToken       : 'private-pat',
          active            : false,
          automation        : { enabled: false },
        },
      };
      const response = await fetch(base + '/connect/meta/connections', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.equal(calls.at(-1).data.data.instagramAuthMode, 'facebook_login');
      assert.equal(calls.at(-1).data.data.pageId, 'page');
      assert.equal(open(calls.at(-1).data.data.accessToken, 'accessToken'), 'private-pat');
      assert(!JSON.stringify(calls).includes('private-pat'));
      const before = calls.length;
      for (const invalid of [
        {
          ...body.data,
          instagramAuthMode : 'auto',
        },
        {
          ...body.data,
          pageId : { id: 'page' },
        },
      ]) {
        const rejected = await fetch(base + '/connect/meta/connections', {
          method  : 'POST',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify({
            ...body,
            data : invalid,
          }),
        });
        assert.equal(rejected.status, 400);
      }
      assert.equal(calls.length, before);
    },
  ));
test('el webhook conserva cada byte firmado y no confirma cuando falla la persistencia' /** @returns {Promise<void>} Comprueba bytes exactos, ausencia de identidad HTTP y límite previo. */, async () =>
  withHttp(
    /** @param {string} base URL local. @param {Object[]} calls RPC observadas. @param {Object} state Fallo durable. @returns {Promise<void>} Contrato de acuse. */
    async (base, calls, state) => {
      const raw     = '{\n "entry": [], "text": "México" \n}';
      const headers = {
        'Content-Type'        : 'application/json',
        'X-Hub-Signature-256' : 'sha256=' + 'a'.repeat(64),
        Authorization         : 'Bearer ignored',
      };
      const ok      = await fetch(base + '/connect/meta/webhooks/config', {
        method : 'POST',
        headers,
        body   : raw,
      });
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), 'EVENT_RECEIVED');
      assert.equal(Buffer.from(calls.at(-1).data.rawBody, 'base64').toString(), raw);
      assert.deepEqual(calls.at(-1).options.context, {});
      state.fail = true;
      assert.equal(
        (
          await fetch(base + '/connect/meta/webhooks/config', {
            method : 'POST',
            headers,
            body   : raw,
          })
        ).status,
        503,
      );
      const prior = calls.length;
      assert.equal(
        (
          await fetch(base + '/connect/meta/webhooks/config', {
            method : 'POST',
            headers,
            body   : 'a'.repeat(4 * 1024 * 1024 + 1),
          })
        ).status,
        413,
      );
      assert.equal(calls.length, prior);
      assert.equal(
        (
          await fetch(base + '/connect/meta/webhooks/config', {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : raw,
          })
        ).status,
        400,
      );
    },
  ));
test('challenge sella verifyToken y devuelve texto plano; falta de clave falla cerrada' /** @returns {Promise<void>} Ningún secreto de query cruza MQ en claro. */, async () => {
  await withHttp(
    /** @param {string} base URL local. @param {Object[]} calls RPC observadas. @returns {Promise<void>} Challenge de Meta. */
    async (base, calls) => {
      const result = await fetch(
        base +
          '/connect/meta/webhooks/c?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=verify-secret',
      );
      assert.equal(result.status, 200);
      assert.equal(await result.text(), '12345');
      assert.equal(open(calls[0].data.verifyToken, 'verifyToken'), 'verify-secret');
      assert(!JSON.stringify(calls).includes('verify-secret'));
    },
  );
  assert.throws(
    /** @returns {Object} Falla antes de encolar el secreto. */
    () => metaRequestCredentials('')({ accessToken: 'secret' }, ['accessToken']),
    { descriptionCode: 'META_ENCRYPTION_UNAVAILABLE' },
  );
});
test('challenge ignora extensiones inertes y rechaza claves canónicas repetidas, anidadas o ausentes', /** @returns {Promise<void>} Sólo tres valores escalares llegan a MQ y el token continúa sellado. */ async () => {
  await withHttp(
    /** @param {string} base URL local. @param {Object[]} calls RPC capturadas. @returns {Promise<void>} Acredita la frontera HTTP sin secretos reales. */ async (
      base,
      calls,
    ) => {
      const route    =
        base +
        '/connect/meta/webhooks/c?hub.mode=subscribe&hub.challenge=0099&hub.verify_token=secret';
      const accepted = await fetch(route + '&auxiliary=value&context[userCode]=ignored');
      assert.equal(accepted.status, 200);
      assert.equal(await accepted.text(), '0099');
      assert.deepEqual(Object.keys(calls.at(-1).data).sort(), [
        'challenge',
        'configurationCode',
        'mode',
        'verifyToken',
      ]);
      assert.equal(open(calls.at(-1).data.verifyToken, 'verifyToken'), 'secret');
      const before = calls.length;
      for (const key of ['hub.mode', 'hub.challenge', 'hub.verify_token']) {
        assert.equal((await fetch(route + '&' + key + '=duplicate')).status, 400);
      }
      for (const query of [
        'hub.mode=subscribe&hub.verify_token=secret',
        'hub.mode[]=subscribe&hub.challenge=0099&hub.verify_token=secret',
        'hub.mode=subscribe&hub.challenge=0099&hub.verify_token=',
      ]) {
        assert.equal((await fetch(base + '/connect/meta/webhooks/c?' + query)).status, 400);
      }
      assert.equal(calls.length, before);
    },
  );
});
test('la telemetría elimina verify_token, URL completa y token temporal de medios' /** @returns {void} Verifica la política real de privacidad sin modificar la biblioteca portable. */, () => {
  const {
    createRouteNormalizer,
    safeAttributes,
    safeLog,
  } = require('../server/library/telemetry/privacy');
  const normalize = createRouteNormalizer(require('../server/telemetry-routes.json'));
  const input     = {
    'http.route'  : '/connect/meta/media/delivery/SECRET_MEDIA',
    'http.url'    : 'https://example.test/connect/meta/webhooks/c?hub.verify_token=SECRET_VERIFY',
    'url.full'    : 'https://example.test/SECRET_MEDIA',
    'http.target' : '/SECRET_MEDIA',
  };
  const safe      = safeAttributes(input, normalize);
  assert.equal(safe['http.route'], '/connect/meta/media/{deliveryCode}/{token}');
  assert(!JSON.stringify(safe).includes('SECRET'));
  assert(
    !JSON.stringify(
      safeLog({
        message     : 'SECRET',
        originalUrl : input['http.url'],
      }),
    ).includes('SECRET'),
  );
  assert.equal(
    normalize('/connect/meta/webhooks/c?hub.verify_token=SECRET_VERIFY'),
    '/connect/meta/webhooks/{configurationCode}',
  );
});
