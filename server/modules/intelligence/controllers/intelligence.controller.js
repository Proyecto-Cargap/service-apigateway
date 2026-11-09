/** @file API administrativa y ejecuciones asíncronas de Intelligence con envelopes existentes. */
'use strict';
/**
 * @param {Object} dependencies Mensajería, autorización y respuestas del Gateway.
 * @returns {Object} Router autenticado; ninguna credencial OpenAI llega al navegador.
 */
function intelligenceController({ messaging, authorization, response }) {
  const router    = require('express').Router();
  const resources = [
    ['agents', 'agent', 'agentCode'],
    ['teams', 'team', 'teamCode'],
    ['tools', 'tool', 'toolCode'],
    ['knowledge-bases', 'knowledge-base', 'knowledgeBaseCode'],
    ['triggers', 'trigger', 'triggerCode'],
    ['runs', 'run', 'runCode'],
  ];
  /**
   * Ejecuta route dentro del flujo de intelligence.controller.
   * @param {*} method Valor de method utilizado por esta operación.
   * @param {*} path Valor de path utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  function route(method, path, action) {
    router[method](
      path,
      authorization.authorizationValidation,

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @param {Object} res Respuesta HTTP que completa la solicitud.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
          const query = { ...req.query };
          for (const key of ['page', 'perPage', 'revision']) {
            if (typeof query[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(query[key])) {
              const value = Number(query[key]);
              if (Number.isSafeInteger(value)) query[key] = value;
            }
          }
          const result = await messaging.request(
            'service-intelligence',
            action,
            {
              ...query,
              ...req.body,
              ...req.params,
            },
            { context: req.system },
          );
          return result.statusCode >= 200 && result.statusCode < 300
            ? response.send(req, res, result.statusCode, result.data)
            : response.sendError(req, res, result.statusCode, result.descriptionCode);
        } catch {
          return response.sendError(req, res, 503, 'INTELLIGENCE_UNAVAILABLE');
        }
      },
    );
  }
  for (const [plural, module, key] of resources) {
    const base = `/intelligence/${plural}`;
    route('get', base, `${module}-get-list`);
    route('post', base, `${module}-create`);
    route('get', `${base}/:${key}`, `${module}-get-one`);
    if (module === 'run') route('post', `${base}/:${key}/cancel`, 'run-cancel');
    else {
      route('patch', `${base}/:${key}`, `${module}-update`);
      route('delete', `${base}/:${key}`, `${module}-delete`);
    }
  }
  route('get', '/intelligence/settings', 'settings-get-list');
  route('get', '/intelligence/settings/:parameter', 'settings-get-one');
  route('patch', '/intelligence/settings/:parameter', 'settings-update');
  return router;
}
module.exports = { intelligenceController };
