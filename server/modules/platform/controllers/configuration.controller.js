/**
 * @file Rutas HTTP de configuración pública de la plataforma expuestas por el gateway. Traduce
 * solicitudes Express a operaciones RPC y adapta las respuestas al cliente.
 */
'use strict';
const policy                                      = require('../policies/configuration.policy');
const { configurationTag, validConfigurationTag } = require('../../../shared/configuration-tag');
/**
 * Construye las rutas HTTP de configuración de plataforma con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.messaging Cliente RPC de los servicios destinatarios.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Express} Aplicación de rutas de configuración para esta instancia.
 */
function configurationController(dependencies) {
  const app                                            = require('express')();
  const MQ                                             = dependencies.messaging;
  const response                                       = dependencies.response;
  const { authorizationValidation, withOutValidation } = dependencies.authorization;

  /**
   * Solicita la operación de configuración a Platform, evita almacenar la respuesta en caché y
   * convierte
   * fallos de transporte en un error controlado.
   * Reenvía configuration-get-one o configuration-update al servicio service-platform.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {string} action Nombre de la acción que debe ejecutar el destinatario.
   * @param {Object} data Datos de entrada utilizados por la operación.
   * @returns {Promise<import('express').Response>} Respuesta 200 del servicio o error HTTP;
   * los fallos de transporte producen 503.
   */
  async function forward(req, res, action, data) {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await MQ.request('service-platform', action, data, {
        context   : req.system,
        timeoutMs : 8000,
      });
      if (result.statusCode !== 200)
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      res.set('ETag', configurationTag(result.data));
      return response.send(req, res, 200, result.data);
    } catch {
      return response.sendError(req, res, 503, 'N0005-CONFIG-UNAVAILABLE');
    }
  }
  /**
   * GET /platform/configuration: envía configuration-get-one a service-platform.
   * Usa el marcador guest local, evita caché y devuelve 200; denegación 403 o indisponibilidad 503.
   *
   * @param {import('express').Request} req Solicitud Express; system aporta el contexto de
   * autorización.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {import('express').Response|Promise<import('express').Response|void>} Resultado de la
   * respuesta HTTP enviada al cliente.
   */
  app.get(
    '/platform/configuration',
    withOutValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res) => {
      if (!policy.authorize('view', {}, policy.trustedScopes.guest, req.system))
        return response.sendError(req, res, 403, 'N0005-CONFIG-FORBIDDEN');
      return forward(req, res, 'configuration-get-one', {});
    },
  );
  /**
   * PUT /platform/configuration: envía configuration-update a service-platform.
   * Requiere el contexto autenticado preparado por authorizationValidation.
   * Envía el cuerpo como configuration y req.query.scope por separado; Platform filtra el registro.
   * If-Match se reenvía como precondición fuera del cuerpo público y admite un solo ETag fuerte.
   * Devuelve 200; entrada inválida 400, denegación 403, conflicto 412 o indisponibilidad 503.
   *
   * @param {import('express').Request} req Solicitud Express; system aporta el contexto de
   * autorización.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {import('express').Response|Promise<import('express').Response|void>} Resultado de la
   * respuesta HTTP enviada al cliente.
   */
  app.put(
    '/platform/configuration',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res) => {
      const scope = req.query.scope === undefined ? '' : req.query.scope;
      if (!policy.authorize('update', {}, scope, req.system))
        return response.sendError(req, res, 403, 'N0005-CONFIG-FORBIDDEN');
      const expectedTag = req.get('If-Match');
      if (expectedTag !== undefined && !validConfigurationTag(expectedTag))
        return response.sendError(req, res, 400, 'N0005-CONFIG-INVALID');
      return forward(req, res, 'configuration-update', {
        configuration : req.body,
        scope,
        ...(expectedTag === undefined ? {} : { expectedTag }),
      });
    },
  );
  return app;
}
module.exports = { configurationController };
