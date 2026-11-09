/**
 * @file Respuesta HTTP de servicio no encontrado para la ruta vacía del gateway.
 */
'use strict';
/**
 * Construye las rutas HTTP de servicio no encontrado con dependencias inyectadas.
 *
 * @param {Object} dependencies Adaptadores usados por estas rutas.
 * @param {Object} dependencies.response Adaptador de sobres y errores HTTP.
 * @param {Object} dependencies.identity Identidad del gateway para sus códigos de respuesta.
 * @param {Object} dependencies.authorization Middlewares que preparan el contexto del servidor.
 * @returns {import('express').Router} Rutas construidas para esta instancia del gateway.
 */
function notFoundController(dependencies) {
  const response              = dependencies.response;
  const express               = require('express');
  const app                   = express.Router();
  const { id }                = dependencies.identity;
  const { withOutValidation } = dependencies.authorization;

  const controller = 'C000';

  /**
   * ALL (ruta vacía): resuelve la petición en el gateway.
   * Devuelve el error HTTP 501 de servicio no encontrado.
   *
   * @param {import('express').Request} req Solicitud Express.
   * @param {import('express').Response} res Respuesta HTTP enviada al cliente.
   * @returns {Promise<import('express').Response|void>} Resultado de la respuesta HTTP enviada al
   * cliente.
   */
  app.all(
    '',
    withOutValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      return response.sendError(req, res, 501, `${id}-${controller}-E0001:Service not found`);
    },
  );

  return app;
}
module.exports = { notFoundController };
