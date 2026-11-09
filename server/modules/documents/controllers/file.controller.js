/** @file Rutas de archivos: preserva URLs públicas y transporta operaciones al servicio Documents. */
'use strict';
/**
 * Construye las rutas HTTP de archivos con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object|Function} dependencies.fileUpload Middleware multipart; usa express-fileupload
 * cuando se omite.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.pdfResponse Adaptador de transferencia y errores de documentos PDF.
 * @param {Object} dependencies.temporaryFiles Adaptador de creación, validación y limpieza de
 * temporales.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function fileController(dependencies) {
  const app                                                = require('express').Router();
  const fileUpload                                         = dependencies.fileUpload || require('express-fileupload');
  const messaging                                          = dependencies.messaging;
  const response                                           = dependencies.response;
  const pdfResponse                                        = dependencies.pdfResponse;
  const temporary                                          = dependencies.temporaryFiles;
  const { mergeRequest }                                   = require('../../../shared/http-request');
  const { authorizationValidation, optionalAuthorization } = dependencies.authorization;
  const multipart                                          = fileUpload({
    limits       : { fileSize: 200 * 1024 * 1024 },
    abortOnLimit : true,
  });

  /**
   * Ejecuta reply dentro del flujo de file.controller.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {*} result Valor de result utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function reply(req, res, result) {
    return result.statusCode >= 200 && result.statusCode < 300
      ? response.send(req, res, result.statusCode, result.data)
      : response.sendError(req, res, result.statusCode, result.descriptionCode);
  }
  /**
   * Ejecuta upload dentro del flujo de file.controller.
   * @param {string} action Valor de action utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function upload(action) {
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    return async (req, res) => {
      let file;
      let handedOff = false;
      try {
        file = await temporary.createUpload(req.files?.file);
        handedOff = true;
        const result = await messaging.request(
          'service-documents',
          action,
          mergeRequest(req, {
            fileName     : req.files.file.name,
            tempFilePath : file,
            userCode     : req.system.user.userCode,
          }),
          {
            context : req.system,
          },
        );
        return reply(req, res, result);
      } catch (error) {
        return response.sendError(
          req,
          res,
          error?.statusCode || 500,
          error?.uncertain ? 'STORAGE_WRITE_UNCERTAIN' : 'OPERATION_FAILED',
        );
      } finally {
        if (file && !handedOff) await temporary.remove(file);
      }
    };
  }
  /**
   * POST /files/pdf/from-html: envía pdf-rich-description-create a service-documents.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * El adaptador PDF valida y transfiere el temporal devuelto por el RPC.
   *
   * @param {import('express').Request} req Solicitud Express; body y query se delegan al contrato
   * RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado del envío HTTP; las descargas
   * pueden completar mediante callback.
   */
  app.post(
    '/files/pdf/from-html',
    authorizationValidation,
    multipart,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        return await pdfResponse.send(
          req,
          res,
          await messaging.request(
            'service-documents',
            'pdf-rich-description-create',
            mergeRequest(req),
            {
              context   : req.system,
              timeoutMs : pdfResponse.rpcTimeoutMs,
            },
          ),
        );
      } catch (error) {
        return pdfResponse.sendError(req, res, error);
      }
    },
  );
  /**
   * POST /files/:scope/:module: envía files-create a service-documents.
   * accessScope selecciona autorización; scope conserva, cuando se usa, la privacidad
   * public/private.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Crea el temporal desde req.files.file y entrega su gestión al servicio al iniciar el RPC.
   * Transmite los estados 2xx del servicio; los errores locales usan statusCode o 500.
   *
   * @param {import('express').Request} req Solicitud con params.scope y params.module,
   * archivo multipart files.file y selector query.accessScope opcional.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.post('/files/:scope/:module', authorizationValidation, multipart, upload('files-create'));
  /**
   * PATCH /files/:scope/:module/:code: envía files-update a service-documents.
   * accessScope selecciona autorización; scope conserva, cuando se usa, la privacidad
   * public/private.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Crea el temporal desde req.files.file y entrega su gestión al servicio al iniciar el RPC.
   * Transmite los estados 2xx del servicio; los errores locales usan statusCode o 500.
   *
   * @param {import('express').Request} req Solicitud con params.scope, params.module y params.code,
   * archivo multipart files.file y selector query.accessScope opcional.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.patch(
    '/files/:scope/:module/:code',
    authorizationValidation,
    multipart,
    upload('files-update'),
  );
  /**
   * DELETE /files/:scope/:code: envía files-delete a service-documents.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * accessScope selecciona autorización; scope conserva, cuando se usa, la privacidad
   * public/private.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene scope, code; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.delete(
    '/files/:scope/:code',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        return reply(
          req,
          res,
          await messaging.request('service-documents', 'files-delete', mergeRequest(req), {
            context : req.system,
          }),
        );
      } catch {
        return response.sendError(req, res, 500);
      }
    },
  );
  /**
   * GET /files/:scope/:code: envía files-get-one a service-documents.
   * Combina consulta, cuerpo y parámetros, con precedencia de estos últimos; el contexto lo fija el
   * servidor.
   * accessScope selecciona autorización; scope conserva, cuando se usa, la privacidad
   * public/private.
   * Admite ausencia de sesión; el servicio decide el acceso al archivo solicitado.
   * Valida la ruta temporal, envía el archivo y solicita su eliminación al terminar la
   * transferencia.
   * Convierte los fallos capturados en una respuesta HTTP 500.
   *
   * @param {import('express').Request} req Solicitud Express; params contiene scope, code; body y
   * query se delegan al contrato RPC.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado del envío HTTP; las descargas
   * pueden completar mediante callback.
   */
  app.get(
    '/files/:scope/:code',
    optionalAuthorization,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        const result = await messaging.request(
          'service-documents',
          'files-get-one',
          mergeRequest(req),
          { context: req.system },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        const file = await temporary.validate(result.data?.tempFilePath);
        res.set('X-Content-Type-Options', 'nosniff');
        return res.sendFile(
          file,

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            void temporary.remove(file);
            if (error && !res.headersSent) response.sendError(req, res, 500);
          },
        );
      } catch {
        return response.sendError(req, res, 500);
      }
    },
  );

  /**
   * POST /files/tmp: crea un temporal y devuelve su ruta al cliente autenticado.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Devuelve 200 con urlResource del temporal creado desde req.files.file.
   *
   * @param {import('express').Request} req Solicitud Express.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.post(
    '/files/tmp',
    authorizationValidation,
    multipart,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      try {
        return response.send(req, res, 200, {
          urlResource : await temporary.createUpload(req.files?.file),
        });
      } catch (error) {
        return response.sendError(req, res, error?.statusCode || 500);
      }
    },
  );
  return app;
}
module.exports = { fileController };
