/**
 * @file Rutas HTTP de parámetros de configuración expuestas por el gateway. Traduce solicitudes
 * Express a
 * operaciones RPC y adapta las respuestas al cliente.
 */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye las rutas HTTP de parámetros de configuración con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function settingsController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response = dependencies.response;
  const express  = require('express');
  const app      = express.Router();
  const MQ       = dependencies.messaging;

  const server                      = 'connect';
  const object                      = 'settings';
  const { authorizationValidation } = dependencies.authorization;

  app.post(
    '/connect/settings/mail-connection/verify',
    dependencies.authorization.authorizationValidation,
    /** @param {Object} req Candidato SMTP autenticado. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Resultado de la prueba global con secretos sellados antes del RPC. */
    async function verify(req, res) {
      res.set('Cache-Control', 'no-store');
      try {
        if (
          Object.keys(req.query || {}).length ||
          Object.keys(req.body || {}).some(
            /** @param {string} key Campo HTTP. @returns {boolean} Rechaza selectores de identidad o propiedades ajenas. */
            (key) => !['data', 'scope'].includes(key),
          ) ||
          (req.body?.scope !== undefined && req.body.scope !== 'global')
        )
          return response.sendError(req, res, 400, 'INVALID_INPUT');
        const result = await MQ.request(
          'service-connect',
          'settings-verify',
          {
            data  : dependencies.sealSmtpCredentials(req.body?.data, 'global:mail-connection'),
            scope : 'global',
          },
          {
            context   : req.system,
            timeoutMs : 15000,
          },
        );
        if (result.statusCode === 200) return response.send(req, res, 200, result.data);
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch (error) {
        if (error instanceof ApplicationError)
          return response.sendError(req, res, error.statusCode, error.descriptionCode);
        return response.sendError(req, res, 503, 'SMTP_VERIFICATION_UNAVAILABLE');
      }
    },
  );

  /**
   * POST /connect/settings: crea SMTP global; Connect valida el permiso y sanea credenciales.
   * @param {import('express').Request} req Solicitud con parameter y data.
   * @param {import('express').Response} res Respuesta HTTP 201 con configuración saneada.
   * @returns {Promise<import('express').Response|void>} Resultado de la operación RPC.
   */
  app.post(
    `/${server}/${object}`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const result = await MQ.request('service-connect', 'settings-create', mergeRequest(req), {
          context : req.system,
        });
        if (result.statusCode === 201) return response.send(req, res, 201, result.data);
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 500, 'OPERATION_FAILED');
      }
    },
  );

  /**
   * GET /connect/settings: envía settings-get-list a service-connect.
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
    `/${server}/${object}`,
    authorizationValidation,

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
          `${object}-get-list`,
          mergeRequest(req),
          { context: req.system },
        );

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
   * GET /connect/settings/:parameter: envía settings-get-one a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene parameter; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/${object}/:parameter`,
    authorizationValidation,

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
          `${object}-get-one`,
          mergeRequest(req),
          { context: req.system },
        );

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
   * PATCH /connect/settings/:parameter: envía settings-update a service-connect.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene parameter; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.patch(
    `/${server}/${object}/:parameter`,
    authorizationValidation,

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
          `${object}-update`,
          mergeRequest(req),
          { context: req.system },
        );

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

  return app;
}
module.exports = { settingsController };
