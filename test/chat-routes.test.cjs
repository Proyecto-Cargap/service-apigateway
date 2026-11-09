/** @file Integración HTTP local del gateway con los nombres RPC canónicos del chat. */
'use strict';
const test               = require('node:test');
const assert             = require('node:assert/strict');
const { once }           = require('node:events');
const express            = require('express');
const { chatController } = require('../server/modules/communication/controllers/chat.controller');
const { mergeRequest }   = require('../server/shared/http-request');

test('las rutas HTTP conservan sus URL y envían los nombres canónicos de Communication' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const calls = [];
  const app   = express();
  app.use(express.json());
  app.use(
    chatController({
      messaging      : {
        /**
         * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
         * @param {*} service Valor de service utilizado por esta operación.
         * @param {string} action Valor de action utilizado por esta operación.
         * @param {Object} data Datos de entrada de la operación.
         * @param {Object} options Opciones que delimitan el comportamiento de la operación.
         * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        request : async (service, action, data, options) => {
          calls.push({
            service,
            action,
            data,
            options,
          });
          return {
            statusCode : 200,
            data       : { ok: true },
          };
        },
      },
      authorization  : {
        /**
         * Ejecuta authorizationValidation dentro del flujo de chat-routes.test.
         * @param {Object} req Solicitud HTTP recibida por el middleware.
         * @param {Object} res Respuesta HTTP que completa la solicitud.
         * @param {Function} next Continuación de la cadena de middleware.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        authorizationValidation : (req, res, next) => {
          req.system = {
            user        : { userCode: 'u' },
            sessionCode : 's',
            workspace   : 'w',
          };
          next();
        },
      },
      response       : {
        /**
         * Envía el contenido mediante el colaborador recibido.
         * @param {Object} req Solicitud HTTP recibida por el middleware.
         * @param {Object} res Respuesta HTTP que completa la solicitud.
         * @param {*} status Valor de status utilizado por esta operación.
         * @param {Object} data Datos de entrada de la operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        send      : (req, res, status, data) => res.status(status).json(data),
        /**
         * Ejecuta sendError dentro del flujo de chat-routes.test.
         * @param {Object} req Solicitud HTTP recibida por el middleware.
         * @param {Object} res Respuesta HTTP que completa la solicitud.
         * @param {*} status Valor de status utilizado por esta operación.
         * @param {*} descriptionCode Valor de descriptionCode utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        sendError : (req, res, status, descriptionCode) =>
          res.status(status).json({ descriptionCode }),
      },
      temporaryFiles : {},
      /**
       * Ejecuta fileUpload dentro del flujo de chat-routes.test.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      fileUpload     :
        () =>
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} req Solicitud HTTP recibida por el middleware.
         * @param {Object} res Respuesta HTTP que completa la solicitud.
         * @param {Function} next Continuación de la cadena de middleware.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (req, res, next) =>
          next(),
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const cases = [
      ['GET', '/users', 'chat-participants-get-list'],
      ['GET', '/unread', 'chat-unread-count'],
      ['GET', '/conversations', 'chat-get-list'],
      ['GET', '/conversations?kind=group&unreadOnly=true&page=2&search=Equipo', 'chat-get-list'],
      ['POST', '/conversations', 'chat-create'],
      ['GET', '/conversations/c/contact-profile', 'chat-contact-profile-get'],
      ['GET', '/conversations/c/messages', 'chat-messages-get-list'],
      ['POST', '/conversations/c/messages', 'chat-send'],
      ['POST', '/conversations/c/products', 'chat-product-send'],
      ['POST', '/conversations/c/quotations', 'chat-quotation-send'],
      ['PATCH', '/conversations/c/read', 'chat-messages-mark-read'],
      ['PATCH', '/conversations/c', 'chat-update'],
      ['GET', '/conversations/c', 'chat-get-one'],
    ];
    for (const [method, url, action] of cases) {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/communication/chat${url}`,
        { method },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const call = calls.at(-1);
      assert.equal(call.service, 'service-communication');
      assert.equal(call.action, action);
      assert.equal(call.options.context.sessionCode, 's');
      if (['chat-product-send', 'chat-quotation-send'].includes(action))
        assert.equal(call.options.timeoutMs, 310000);
      if (url.includes('unreadOnly'))
        assert.deepEqual(call.data, {
          kind       : 'group',
          unreadOnly : 'true',
          page       : '2',
          search     : 'Equipo',
        });
    }
    assert.equal(calls.length, cases.length);
  } finally {
    await new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @param {Function} reject Continuación que rechaza la promesa con su causa.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (resolve, reject) =>
        server.close(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (error) => (error ? reject(error) : resolve()),
        ),
    );
  }
});

test('los metadatos de servidor prevalecen y las claves de prototipo no se copian al payload' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {void} Finaliza después de aplicar los efectos de la operación.
 */, () => {
  const body  = JSON.parse('{"constructor":"forged","__proto__":{"admin":true},"code":"body"}');
  const value = mergeRequest(
    {
      query  : { code: 'query' },
      body,
      params : { code: 'route' },
    },
    { code: 'server' },
  );
  assert.deepEqual(value, { code: 'server' });
  assert.equal(Object.hasOwn(value, 'constructor'), false);
  assert.equal(Object.hasOwn(value, '__proto__'), false);
});
