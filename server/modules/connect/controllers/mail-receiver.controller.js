/**
 * @file Rutas HTTP de mail receiver expuestas por el gateway. Traduce solicitudes Express a
 * operaciones
 * RPC y adapta las respuestas al cliente.
 */
'use strict';
/**
 * Construye las rutas HTTP de recepción de correo con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function mailReceiverController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response              = dependencies.response;
  const { withOutValidation } = dependencies.authorization;
  const express               = require('express');
  const app                   = express.Router();
  const MQ                    = dependencies.messaging;

  const server = 'connect';
  const object = 'email-receiver';

  /**
   * POST /connect/email-receiver: envía email-receiver-create a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 201; los demás estados pasan al adaptador de errores HTTP.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.post(
    `/${server}/${object}`,
    withOutValidation,
    express.text({ type: '*/*' }),
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(
          `service-${server}`,
          `${object}-create`,
          mergeRequest(req),
          { context: req.system },
        );

        switch (mqResponse.statusCode) {
          case 201:
            return response.send(req, res, mqResponse.statusCode);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (e) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, e);
      }
    },
  );

  return app;
}
module.exports = { mailReceiverController };
