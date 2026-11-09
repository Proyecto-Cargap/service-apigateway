/** @file HTTP de expedientes propios y administrativos; sólo adapta contexto, multipart y archivos privados. */
'use strict';
const { createHash } = require('node:crypto');
/** @param {Object} dependencies Autenticación, mensajería, temporales y respuesta HTTP. @param {string} actor Dominio fijado por composición. @returns {import('express').Router} Rutas del expediente. */
function enrollmentRoutes(dependencies, actor) {
  const { authorization, messaging, response, temporaryFiles } = dependencies;
  const router                                                 = require('express').Router();
  const multipart                                              = require('express-fileupload')({
    limits       : {
      fileSize  : 10 * 1024 * 1024,
      files     : 1,
      fields    : 1,
      fieldSize : 4096,
    },
    abortOnLimit : true,
  });
  /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Promise<*>} Exige políticas vigentes sin autenticación alternativa. */
  const authenticated                                          = (req, res, next) => authorization.authorizationValidation(req, res, next);
  /** @param {Object} req Solicitud ya autenticada. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {void} Normaliza exclusivamente una carga multipart válida. */
  function uploadInput(req, res, next) {
    if (!req.is('multipart/form-data')) {
      response.sendError(req, res, 400, 'ENROLLMENT_MULTIPART_REQUIRED');
      return;
    }
    multipart(
      req,
      res /** @param {Error} error Fallo de tamaño o parser. @returns {Promise<void>} Temporal confinado sin rutas elegibles por el cliente. */,
      async (error) => {
        if (error) {
          next(error);
          return;
        }
        let filename;
        try {
          const input = JSON.parse(req.body.input),
            file      = req.files?.document;
          if (
            !input ||
            Array.isArray(input) ||
            typeof input !== 'object' ||
            Object.keys(input).some(
              /** @param {string} key Campo de entrada. @returns {boolean} Campo no permitido. */
              (key) => !['requirementCode', 'operationCode', 'expectedRevision'].includes(key),
            ) ||
            !file ||
            Array.isArray(file) ||
            file.truncated ||
            !Buffer.isBuffer(file.data) ||
            !file.data.length ||
            file.data.length > 10 * 1024 * 1024
          )
            throw new Error('INVALID_DOCUMENT');
          const bytes    = file.data;
          const mimeType =
            bytes.subarray(0, 5).toString('ascii') === '%PDF-'
              ? 'application/pdf'
              : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                ? 'image/png'
                : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                  ? 'image/jpeg'
                  : '';
          if (!mimeType) throw new Error('INVALID_DOCUMENT');
          filename = await temporaryFiles.createUpload(file);
          req.body = {
            ...input,
            documentUpload : {
              tempFilePath : filename,
              name         : String(file.name || 'documento').slice(0, 255),
              size         : bytes.length,
              mimeType,
              digest       : createHash('sha256').update(bytes).digest('hex'),
            },
          };
          res.once(
            'finish' /** @returns {void} Conserva temporales inciertos para la limpieza por vencimiento. */,
            () => {
              if (res.statusCode < 500) void temporaryFiles.remove(filename);
            },
          );
          next();
        } catch {
          if (filename) await temporaryFiles.remove(filename);
          response.sendError(req, res, 400, 'ENROLLMENT_INVALID_FILE');
        }
      },
    );
  }
  /** @param {string} action Acción canónica. @param {boolean} binary Descarga privada. @returns {Function} Adaptador HTTP sin reglas de negocio. */
  function handle(action, binary = false) {
    /** @param {Object} req Solicitud autenticada. @param {Object} res Respuesta. @returns {Promise<Object>} Sobre o bytes confirmados. */
    return async (req, res) => {
      let filename;
      try {
        const data = {
          ...req.query,
          ...req.body,
          ...req.params,
        };
        for (const key of ['page', 'perPage', 'version', 'expectedRevision'])
          if (typeof data[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(data[key]))
            data[key] = Number(data[key]);
        const result = await messaging.request('service-' + actor, action, data, {
          context : req.system,
          ...(binary || action === 'enrollment-own-upload' ? { timeoutMs: 310000 } : {}),
        });
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        res.set('Cache-Control', 'no-store');
        if (!binary) return response.send(req, res, 200, result.data);
        filename = await temporaryFiles.validate(result.data.tempFilePath);
        res.set({
          'Content-Type'            : result.data.mime,
          'Content-Length'          : String(result.data.size),
          'X-Content-Type-Options'  : 'nosniff',
          'Content-Disposition'     : 'inline; filename="documento"',
          'Content-Security-Policy' : "sandbox; default-src 'none'",
        });
        return res.sendFile(
          filename /** @param {Error} error Fallo de transporte. @returns {void} Libera únicamente el temporal acreditado. */,
          (error) => {
            void temporaryFiles.remove(filename);
            if (error && !res.headersSent)
              response.sendError(req, res, 503, 'ENROLLMENT_FILE_UNAVAILABLE');
          },
        );
      } catch (error) {
        if (filename) await temporaryFiles.remove(filename);
        return response.sendError(
          req,
          res,
          error.statusCode || 503,
          error.descriptionCode || 'ENROLLMENT_UNAVAILABLE',
        );
      }
    };
  }
  router.get('/' + actor + '/account/me', authenticated, handle('account-own-get'));
  router.get('/' + actor + '/enrollment', authenticated, handle('enrollment-own-get'));
  router.put('/' + actor + '/enrollment', authenticated, handle('enrollment-own-save'));
  router.post(
    '/' + actor + '/enrollment/documents',
    authenticated,
    uploadInput,
    handle('enrollment-own-upload'),
  );
  router.post('/' + actor + '/enrollment/submit', authenticated, handle('enrollment-own-submit'));
  router.get(
    '/' + actor + '/enrollment/documents/:requirementCode/:version',
    authenticated,
    handle('enrollment-document-read', true),
  );
  router.get('/' + actor + '/enrollments', authenticated, handle('enrollment-get-list'));
  router.get(
    '/' + actor + '/enrollments/:enrollmentCode',
    authenticated,
    handle('enrollment-get-one'),
  );
  router.post(
    '/' + actor + '/enrollments/:enrollmentCode/review',
    authenticated,
    handle('enrollment-review'),
  );
  router.post(
    '/' + actor + '/enrollments/:enrollmentCode/approve',
    authenticated,
    handle('enrollment-approve'),
  );
  router.get(
    '/' + actor + '/enrollments/:enrollmentCode/documents/:requirementCode/:version',
    authenticated,
    handle('enrollment-document-read', true),
  );
  return router;
}
module.exports = { enrollmentRoutes };
