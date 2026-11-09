/**
 * @file Rutas HTTP de sesiones expuestas por el gateway. Traduce solicitudes Express a operaciones
 * RPC y
 * adapta las respuestas al cliente.
 */
'use strict';
/**
 * Construye las rutas HTTP de sesiones con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function sessionController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response = dependencies.response;
  const express  = require('express');
  const app      = express.Router();
  const MQ       = dependencies.messaging;

  const server                                         = 'security';
  const object                                         = 'session';
  const { authorizationValidation, withOutValidation } = dependencies.authorization;

  /** @param {Object} req Contexto autenticado. @param {Object} res Respuesta privada. @param {string} action Lectura propia o administrativa. @param {Object} data Entrada proyectada. @returns {Promise<Object>} Imagen y limpieza del temporal confinado. */
  async function profilePicture(req, res, action, data) {
    let filename;
    try {
      const result = await MQ.request('service-security', action, data, {
        context   : req.system,
        timeoutMs : 310000,
      });
      if (result.statusCode !== 200)
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      filename = await dependencies.temporaryFiles.validate(result.data.tempFilePath);
      res.set({
        'Cache-Control'          : 'no-store',
        'X-Content-Type-Options' : 'nosniff',
        'Content-Type'           : result.data.mimeType,
      });
      return res.sendFile(
        filename,

        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Error} error Fallo recibido por la continuación.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        (error) => {
          void dependencies.temporaryFiles.remove(filename);
          if (error && !res.headersSent) response.sendError(req, res, 503, 'FILE_READ_FAILED');
        },
      );
    } catch {
      if (filename) await dependencies.temporaryFiles.remove(filename);
      return response.sendError(req, res, 503, 'FILE_READ_FAILED');
    }
  }
  /** @param {Object} req Sesión del actor humano. @param {Object} res Respuesta privada. @returns {Promise<Object>} Perfil mínimo, sin identificadores elegibles por query. */
  app.get(
    '/security/session/me/profile',
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
          'service-security',
          'session-own-profile-get',
          {},
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'SESSION_REFERENCES_UNAVAILABLE');
      }
    },
  );
  /** @param {Object} req Sesión vigente y variante de imagen. @param {Object} res Respuesta binaria privada. @returns {Promise<Object>} Foto del contacto propio, con transferencia confinada. */
  app.get(
    '/security/session/me/profile/picture',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res) =>
      profilePicture(req, res, 'session-own-profile-picture-read', {
        size : req.query.size ?? '200',
      }),
  );
  /** @param {Object} req Sesión elegida para consulta administrativa. @param {Object} res Respuesta binaria privada. @returns {Promise<Object>} Imagen después de autorizar la sesión seleccionada. */
  app.get(
    '/security/session/:code/profile/picture',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res) =>
      profilePicture(req, res, 'session-profile-picture-read', {
        code : req.params.code,
        size : req.query.size ?? '100',
      }),
  );

  /**
   * POST /security/session: envía session-create a service-security.
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
   * DELETE /security/session/:code: envía session-delete a service-security.
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
   * DELETE /security/session/token/:code: envía session-delete-by-token a service-security.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene code; body y query se
   * delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.delete(
    `/${server}/${object}/token/:code`,
    withOutValidation,

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
          `${object}-delete-by-token`,
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
   * GET /security/session: envía session-get-list a service-security.
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
   * GET /security/session/:code: envía session-get-one a service-security.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuestas RPC 200 y 204; los demás estados pasan al adaptador de errores HTTP.
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

  /** @param {Object} req Credencial exclusiva del encabezado autenticado. @param {Object} res Respuesta privada. @returns {Promise<Object>} Restaura el acceso vigente sin rotar ni prolongar la sesión compartida. */
  app.post(
    '/security/session/restore',
    authorizationValidation,
    /** @param {Object} req Contexto fijado por Gateway; ignora selectores de query y cuerpo. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Sesión canónica 200 o rechazo del productor. */
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await MQ.request(
          'service-security',
          'session-restore',
          { code: req.get('Authorization')?.replace(/^Bearer\s+/i, '') },
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'SESSION_RESTORE_UNAVAILABLE');
      }
    },
  );

  /**
   * PUT /security/session/renovate: envía session-renovate a service-security.
   * Obtiene la credencial exclusivamente del encabezado Authorization ya autenticado.
   * No acepta selectores del cuerpo, query ni segmentos de URL.
   * Acepta respuesta RPC 201; los demás estados pasan al adaptador de errores HTTP.
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
    `/${server}/${object}/renovate`,
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
          `${object}-renovate`,
          { code: req.get('Authorization')?.replace(/^Bearer\s+/i, '') },
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
   * PATCH /security/session/:code/workspace: envía session-update a service-security.
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
    `/${server}/${object}/:code/workspace`,
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
module.exports = { sessionController };
