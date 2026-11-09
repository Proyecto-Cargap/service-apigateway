/**
 * @file Rutas HTTP de contactos expuestas por el gateway. Traduce solicitudes Express a operaciones
 * RPC y
 * adapta las respuestas al cliente.
 */
'use strict';
/**
 * Construye las rutas HTTP de contactos con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.logger Logger técnico de fallos, sin datos de la petición.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function contactController(dependencies) {
  const logger           = dependencies.logger;
  const { mergeRequest } = require('../../../shared/http-request');

  const response = dependencies.response;
  const express  = require('express');
  const app      = express.Router();
  const MQ       = dependencies.messaging;

  const server                                         = 'directory';
  const object                                         = 'contact';
  const { authorizationValidation, withOutValidation } = dependencies.authorization;
  const pictureInput                                   = require('./contact-picture.http')(dependencies);

  /**
   * POST /directory/contact: envía contact-create a service-directory.
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
    pictureInput,

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
          {
            context : req.system,
            ...(req.body.pictureUpload ? { timeoutMs: 310000 } : {}),
          },
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
   * PATCH /directory/contact/:contactCode: envía contact-update a service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene contactCode; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.patch(
    `/${server}/${object}/:contactCode`,
    authorizationValidation,
    pictureInput,
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
          {
            context : req.system,
            ...(req.body.pictureUpload ? { timeoutMs: 310000 } : {}),
          },
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
   * DELETE /directory/contact/:contactCode: envía contact-delete a service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene contactCode; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.delete(
    `/${server}/${object}/:contactCode`,
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
   * GET /directory/contact: envía contact-get-list a service-directory.
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
   * GET /directory/contact/view: envía contact-get-global a service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/${object}/view`,
    withOutValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        req.body.scope = 'guest';
        const mqResponse = await MQ.request(
          `service-${server}`,
          `${object}-get-global`,
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
   * GET /directory/contact/view/:contactCode: envía contact-get-one a service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene contactCode; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/${object}/view/:contactCode`,
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
   * GET /directory/contact/validation/:contactCode: envía contact-get-validation-token a
   * service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene contactCode; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/${object}/validation/:contactCode`,
    withOutValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        req.body.scope = 'guest';
        const mqResponse = await MQ.request(
          `service-${server}`,
          `${object}-get-validation-token`,
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
   * GET /directory/contact/:contactCode: envía contact-get-one a service-directory.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Acepta respuesta RPC 200; los demás estados pasan al adaptador de errores HTTP.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene contactCode; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.get(
    `/${server}/${object}/:contactCode`,
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
   * Transfiere una variante después de la autorización del contacto en Directory.
   * @param {Object} req Solicitud autenticada con contactCode y size.
   * @param {Object} res Respuesta HTTP de imagen privada.
   * @returns {Promise<Object>} Transferencia y limpieza del temporal confinado.
   */
  app.get(
    '/directory/contact/:contactCode/picture',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let filename;
      try {
        const result = await MQ.request(
          'service-directory',
          'contact-picture-read',
          {
            contactCode : req.params.contactCode,
            size        : req.query.size || 'original',
          },
          {
            context   : req.system,
            timeoutMs : 310000,
          },
        );
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
    },
  );
  return app;
}
module.exports = { contactController };
