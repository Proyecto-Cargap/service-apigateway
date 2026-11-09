/** @file Administración Meta global con contexto vigente y secretos sellados antes de RPC. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { validateMetaSave } = require('../contracts/meta-http.contract');
/** Compone rutas administrativas sin ejecutar OAuth ni aceptar actor del cliente.
 * @param {Object} dependencies Autorización, transporte y sellado inyectados.
 * @returns {Object} Router de configuración, conexiones y control de conversación.
 */
function metaController({ messaging, authorization, response, sealMetaCredentials }) {
  const router = require('express').Router();
  const base   = '/connect/meta';
  const routes = [
    ['get', '/settings', 'settings-get'],
    ['put', '/settings', 'settings-save'],
    ['get', '/connections', 'connection-get-list'],
    ['post', '/connections', 'connection-save'],
    ['get', '/connections/:connectionCode', 'connection-get'],
    ['put', '/connections/:connectionCode', 'connection-save'],
    ['delete', '/connections/:connectionCode', 'connection-deactivate'],
    ['post', '/connections/:connectionCode/verify', 'connection-verify'],
    ['get', '/conversations', 'conversation-get-list'],
    ['get', '/conversations/:conversationCode', 'conversation-get'],
    ['post', '/conversations/:conversationCode/control', 'conversation-control'],
  ];
  for (const [method, path, action] of routes) {
    router[method](
      base + path,
      authorization.authorizationValidation,
      /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta HTTP. @returns {Promise<*>} Sobre público de Connect. */
      async function handle(req, res) {
        res.set('Cache-Control', 'no-store');
        try {
          const permission = `connect.meta.${method === 'get' ? 'view' : 'update'}.global`;
          if (!req.system?.policies?.includes(permission))
            throw new ApplicationError(403, 'FORBIDDEN');
          if (
            (method === 'get' && Object.keys(req.body || {}).length) ||
            (!action.endsWith('-get-list') && Object.keys(req.query || {}).length)
          )
            throw new ApplicationError(400, 'INVALID_INPUT');
          const allowedRoot = action.endsWith('-get-list')
            ? ['page', 'perPage', ...(action === 'conversation-get-list' ? ['connectionCode'] : [])]
            : action.endsWith('-save')
              ? ['revision', 'data']
              : action === 'conversation-control'
                ? ['revision', 'mode', 'operatorUserCode']
                : action === 'connection-deactivate'
                  ? ['revision']
                  : [];
          const payload     = method === 'get' ? req.query : req.body || {};
          if (
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            Object.keys(payload).some(
              /** @param {string} key Campo del navegador. @returns {boolean} Rechaza identidad, permisos y secretos fuera de su contrato. */
              (key) => !allowedRoot.includes(key),
            )
          )
            throw new ApplicationError(400, 'INVALID_INPUT');
          if (action.endsWith('-save')) {
            validateMetaSave(action, payload);
            const allowedData =
              action === 'settings-save'
                ? [
                    'enabled',
                    'appId',
                    'graphVersion',
                    'publicBaseUrl',
                    'workspaceCode',
                    'contactRoleCode',
                    'externalGroupCodes',
                    'appSecret',
                    'verifyToken',
                  ]
                : [
                    'name',
                    'channel',
                    'assetId',
                    'businessId',
                    'instagramAuthMode',
                    'pageId',
                    'accessToken',
                    'active',
                    'automation',
                  ];
            if (
              !payload.data ||
              typeof payload.data !== 'object' ||
              Array.isArray(payload.data) ||
              Object.keys(payload.data).some(
                /** @param {string} key Campo de configuración. @returns {boolean} Rechaza cualquier secreto o selector desconocido antes de MQ. */
                (key) => !allowedData.includes(key),
              )
            )
              throw new ApplicationError(400, 'INVALID_INPUT');
            if (
              payload.data.automation &&
              (typeof payload.data.automation !== 'object' ||
                Array.isArray(payload.data.automation) ||
                Object.keys(payload.data.automation).some(
                  /** @param {string} key Campo de automatización. @returns {boolean} Sólo destino configurado y estado. */
                  (key) => !['enabled', 'agentCode', 'teamCode'].includes(key),
                ))
            )
              throw new ApplicationError(400, 'INVALID_INPUT');
          }
          const input = {
            ...(method === 'get' ? req.query : req.body),
            ...req.params,
          };
          for (const key of Object.keys(req.params))
            if (Object.hasOwn(req.body || {}, key))
              throw new ApplicationError(400, 'INVALID_INPUT');
          if (action.endsWith('-get-list'))
            for (const key of ['page', 'perPage']) {
              if (
                input[key] !== undefined &&
                (typeof input[key] !== 'string' ||
                  !/^\d+$/.test(input[key]) ||
                  !Number.isSafeInteger(Number(input[key])))
              )
                throw new ApplicationError(400, 'INVALID_PAGINATION');
              if (input[key] !== undefined) input[key] = Number(input[key]);
            }
          if (action === 'settings-save' || action === 'connection-save')
            input.data = sealMetaCredentials(
              input.data,
              action === 'settings-save' ? ['appSecret', 'verifyToken'] : ['accessToken'],
            );
          const result = await messaging.request('service-connect', `meta-${action}`, input, {
            context   : req.system,
            timeoutMs : 60000,
          });
          return result.statusCode === 200
            ? response.send(req, res, 200, result.data, { includeNull: true })
            : response.sendError(req, res, result.statusCode, result.descriptionCode);
        } catch (error) {
          return response.sendError(
            req,
            res,
            error instanceof ApplicationError ? error.statusCode : 503,
            error instanceof ApplicationError ? error.descriptionCode : 'META_UNAVAILABLE',
          );
        }
      },
    );
  }
  return router;
}
module.exports = { metaController };
