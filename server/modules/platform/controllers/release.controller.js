/**
 * @file Rutas HTTP de versiones publicadas expuestas por el gateway. Traduce solicitudes Express a
 * operaciones RPC y adapta las respuestas al cliente.
 */
'use strict';
/**
 * Construye las rutas HTTP de versiones con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function releaseController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response = dependencies.response;
  const express  = require('express');
  const app      = express.Router();
  const MQ       = dependencies.messaging;

  const server                      = 'platform';
  const object                      = 'release';
  const { authorizationValidation } = dependencies.authorization;
  /**
   * Ejecuta requirePermission dentro del flujo de release.controller.
   * @param {string} action Valor de action utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const requirePermission           =
    (action) =>
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @param {Function} next Continuación de la cadena de middleware.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res, next) =>
      req.system?.policies?.includes(`platform.release.${action}.global`)
        ? next()
        : response.sendError(req, res, 403, 'FORBIDDEN');

  /** @param {Object} req Solicitud con permiso global de publicación. @param {Object} res Respuesta HTTP. @returns {Promise<void>} Compilación verificada del dominio del servidor. */
  app.get(
    `/${server}/${object}/web-build`,
    authorizationValidation,
    requirePermission('update'),
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await MQ.request(
          'service-platform',
          'release-web-build',
          {},
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'RELEASE_UNAVAILABLE');
      }
    },
  );

  /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta HTTP. @returns {Promise<void>} Versión vigente o null. */
  app.get(
    `/${server}/${object}/current`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await MQ.request(
          'service-platform',
          'release-current',
          {},
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data, { includeNull: true })
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'RELEASE_UNAVAILABLE');
      }
    },
  );

  /** @param {Object} req Solicitud autenticada con paginación. @param {Object} res Respuesta HTTP. @returns {Promise<void>} Historial publicado. */
  app.get(
    `/${server}/${object}/history`,
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await MQ.request(
          'service-platform',
          'release-history',
          {
            page    : req.query.page,
            perPage : req.query.perPage,
          },
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'RELEASE_UNAVAILABLE');
      }
    },
  );

  /**
   * POST /platform/release: envía release-create a service-platform.
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
    `/${server}/${object}`,
    authorizationValidation,
    requirePermission('create'),
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
   * PATCH /platform/release/:code: envía release-update a service-platform.
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
    `/${server}/${object}/:code`,
    authorizationValidation,
    requirePermission('update'),
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
   * DELETE /platform/release/:code: envía release-delete a service-platform.
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
    `/${server}/${object}/:code`,
    authorizationValidation,
    requirePermission('delete'),
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
          `${object}-delete`,
          mergeRequest(req),
          { context: req.system },
        );

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
   * GET /platform/release: envía release-get-list a service-platform.
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
    requirePermission('view'),
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
   * GET /platform/release/:code: envía release-get-one a service-platform.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Conserva 204 sin cuerpo cuando el recurso está ausente.
   * Acepta respuesta RPC 200 o 204; los demás estados pasan al adaptador de errores HTTP.
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
    `/${server}/${object}/:code`,
    authorizationValidation,
    requirePermission('view'),
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
          case 204:
            return response.send(req, res, 204);
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
   * PUT /platform/release/:code/published: envía release-published a service-platform.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Conserva 204 sin cuerpo cuando el recurso está ausente.
   * Acepta respuesta RPC 200 o 204; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code; body y query se
   * delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.put(
    `/${server}/${object}/:code/published`,
    authorizationValidation,
    requirePermission('update'),
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
          `${object}-published`,
          mergeRequest(req),
          { context: req.system },
        );

        switch (mqResponse.statusCode) {
          case 204:
            return response.send(req, res, 204);
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
module.exports = { releaseController };
