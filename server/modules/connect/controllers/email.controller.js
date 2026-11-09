/**
 * @file Rutas HTTP de correo electrónico expuestas por el gateway. Traduce solicitudes Express a
 * operaciones RPC y adapta las respuestas al cliente.
 */
'use strict';
/**
 * Construye las rutas HTTP de correos electrónicos con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function emailController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response = dependencies.response;
  const express  = require('express');
  const app      = express.Router();
  const MQ       = dependencies.messaging;

  const server                                         = 'connect';
  const serviceQueue                                   = `service-${server}`;
  const { authorizationValidation, withOutValidation } = dependencies.authorization;
  /**
   * Completa la comprobación previa HTTP con una respuesta satisfactoria sin datos adicionales.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @returns {*} Resultado devuelto por response.send con los argumentos preparados por la función.
   */
  const sendOk                                         = (req, res) => response.send(req, res, 200);

  /**
   * OPTIONS /connect/email: resuelve la petición en el gateway.
   *
   * @param {import('express').Request} req Solicitud Express.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {import('express').Response|Promise<import('express').Response|void>} Resultado de la
   * respuesta HTTP enviada al cliente.
   */
  app.options(`/${server}/email`, withOutValidation, sendOk);
  /**
   * OPTIONS /connect/email/plain: resuelve la petición en el gateway.
   *
   * @param {import('express').Request} req Solicitud Express.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {import('express').Response|Promise<import('express').Response|void>} Resultado de la
   * respuesta HTTP enviada al cliente.
   */
  app.options(`/${server}/email/plain`, withOutValidation, sendOk);
  /**
   * OPTIONS /connect/email/:code: resuelve la petición en el gateway.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {import('express').Response|Promise<import('express').Response|void>} Resultado de la
   * respuesta HTTP enviada al cliente.
   */
  app.options(`/${server}/email/:code`, withOutValidation, sendOk);

  /**
   * POST /connect/email: envía email-create a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 201; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.post(
    `/${server}/email`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-create`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 201:
            return response.send(req, res, mqResponse.statusCode);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  /**
   * POST /connect/email/draft: envía email-draft-create a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 201; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.post(
    `/${server}/email/draft`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-draft-create`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 201:
            return response.send(req, res, mqResponse.statusCode);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  /**
   * GET /connect/email: envía email-get-list a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/email`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-get-list`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 200:
            return response.send(req, res, mqResponse.statusCode, mqResponse.data);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  /**
   * GET /connect/email/:code: envía email-get-one a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code; body y query se
   * delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/email/:code`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-get-one`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 200:
            return response.send(req, res, mqResponse.statusCode, mqResponse.data);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  /**
   * PATCH /connect/email/:code: envía email-update a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code; body y query se
   * delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.patch(
    `/${server}/email/:code`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-update`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 200:
            return response.send(req, res, mqResponse.statusCode);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  /**
   * DELETE /connect/email/:code: envía email-delete a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code; body y query se
   * delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.delete(
    `/${server}/email/:code`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const mqResponse = await MQ.request(serviceQueue, `email-delete`, mergeRequest(req), {
          context : req.system,
        });

        switch (mqResponse.statusCode) {
          case 200:
            return response.send(req, res, mqResponse.statusCode);
          default:
            return response.sendError(req, res, mqResponse.statusCode, mqResponse.descriptionCode);
        }
      } catch (err) {
        logger.error({
          component : 'application',
          event     : 'operation_failed',
        });
        return response.sendError(req, res, 500, err);
      }
    },
  );

  return app;
}
module.exports = { emailController };
