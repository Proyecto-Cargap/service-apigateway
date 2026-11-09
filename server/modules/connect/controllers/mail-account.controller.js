/** @file Configuración conjunta SMTP/IMAP; el propietario procede de la ruta o del contexto autenticado. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Mensajería, autorización y respuestas HTTP. @returns {Object} Router de cuentas personales. */
function mailAccountController({ messaging, authorization, response, sealSmtpCredentials }) {
  const app = require('express').Router();
  app.use(
    '/connect/mail-accounts',
    /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Configuración privada fuera de cachés. */
    function noCache(req, res, next) {
      res.set('Cache-Control', 'no-store');
      next();
    },
  );
  app.get(
    '/connect/mail-accounts',
    authorization.authorizationValidation,
    /** @param {Object} req Solicitud de página sin selectores de contexto. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Página saneada o error público de Connect. */
    async function list(req, res) {
      try {
        if (
          Object.keys(req.body || {}).length ||
          Object.keys(req.query || {}).some(
            /** @param {string} key Parámetro HTTP. @returns {boolean} Rechaza campos distintos de la paginación. */
            (key) => !['page', 'perPage'].includes(key),
          )
        )
          return response.sendError(req, res, 400, 'INVALID_INPUT');
        const data = {};
        for (const [key, value] of Object.entries(req.query || {})) {
          if (
            typeof value !== 'string' ||
            !/^\d+$/.test(value) ||
            !Number.isSafeInteger(Number(value))
          )
            throw new ApplicationError(400, 'INVALID_PAGINATION');
          data[key] = Number(value);
        }
        const result = await messaging.request('service-connect', 'mail-account-get-list', data, {
          context : req.system,
        });
        if (result.statusCode === 200) return response.send(req, res, 200, result.data);
        return response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch (error) {
        if (error instanceof ApplicationError)
          return response.sendError(req, res, error.statusCode, error.descriptionCode);
        return response.sendError(req, res, 503, 'MAIL_ACCOUNT_UNAVAILABLE');
      }
    },
  );
  for (const prefix of ['/connect/mail-accounts/me', '/connect/mail-accounts/user/:userCode']) {
    for (const [verb, action, suffix] of [
      ['get', 'get', ''],
      ['put', 'save', ''],
      ['delete', 'delete', ''],
      ['post', 'verify', '/verify/:protocol'],
    ]) {
      app[verb](
        prefix + suffix,
        authorization.authorizationValidation,
        /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta HTTP. @returns {Promise<Object>} Datos públicos o error estable. */
        async function handle(req, res) {
          try {
            const data = {
              ...(prefix.includes(':userCode') ? { userCode: req.params.userCode } : {}),
            };
            // El DTO rechaza selectores de propietario y campos no declarados del cuerpo.
            if (
              Object.keys(req.query || {}).length ||
              Object.keys(req.body || {}).some(
                /** @param {string} key Campo recibido. @returns {boolean} Sólo admite data en escrituras. */
                (key) =>
                  !(
                    action === 'save'
                      ? ['data', 'revision']
                      : action === 'verify'
                        ? ['data']
                        : action === 'delete'
                          ? []
                          : []
                  ).includes(key),
              )
            )
              return response.sendError(req, res, 400, 'INVALID_INPUT');
            if (action === 'save') data.revision = req.body?.revision;
            if (action === 'delete') {
              const revision = req.get('If-Match');
              if (typeof revision !== 'string' || !/^"[0-9]+"$/.test(revision))
                return response.sendError(req, res, 400, 'INVALID_INPUT');
              data.revision = Number(revision.slice(1, -1));
            }
            if (action === 'verify') {
              if (!['smtp', 'imap'].includes(req.params.protocol))
                return response.sendError(req, res, 400, 'INVALID_INPUT');
              data.protocol = req.params.protocol;
            }
            if (['save', 'verify'].includes(action)) {
              const owner = data.userCode ?? req.system?.user?.userCode;
              data.data = sealSmtpCredentials(req.body?.data, owner);
              const receiving = req.body?.data?.imap;
              if (!receiving || typeof receiving !== 'object' || Array.isArray(receiving))
                return response.sendError(req, res, 400, 'INVALID_INPUT');
              data.data = {
                ...data.data,
                imap : {
                  ...receiving,
                  auth : sealSmtpCredentials({ conection: { auth: receiving.auth } }, owner)
                    ?.conection?.auth,
                },
              };
            }
            const result = await messaging.request(
              'service-connect',
              `mail-account-${action}`,
              data,
              {
                context   : req.system,
                timeoutMs : 120000,
              },
            );
            if (result.statusCode === 200)
              return response.send(req, res, 200, result.data, { includeNull: true });
            return response.sendError(req, res, result.statusCode, result.descriptionCode);
          } catch (error) {
            if (error instanceof ApplicationError)
              return response.sendError(req, res, error.statusCode, error.descriptionCode);
            return response.sendError(req, res, 503, 'MAIL_ACCOUNT_UNAVAILABLE');
          }
        },
      );
    }
  }
  return app;
}
module.exports = { mailAccountController };
