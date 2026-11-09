/** @file Normaliza el guardado multipart de imágenes sin aceptar rutas temporales del cliente. */
'use strict';
/**
 * Compone middleware multipart usado sólo al guardar un registro con imagen pendiente.
 * @param {Object} dependencies Temporales y middleware multipart del gateway.
 * @returns {Function} Middleware Express compatible con solicitudes JSON existentes.
 */
module.exports = function pictureUploadInput({
  temporaryFiles,
  fileUpload = require('express-fileupload'),
  response,
}) {
  const multipart = fileUpload({
    limits          : {
      fileSize : 20 * 1024 * 1024,
      files    : 1,
      fields   : 2,
    },
    abortOnLimit    : true,
    defParamCharset : 'utf8',
  });
  /**
   * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      if (req.body && typeof req.body === 'object') req.body.pictureUpload = undefined;
      return next();
    }
    return multipart(
      req,
      res,

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Error} error Fallo recibido por la continuación.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (error) => {
        if (error) return next(error);
        let filename;
        try {
          const input   = JSON.parse(req.body.input);
          const options = JSON.parse(req.body.pictureOptions);
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            !options ||
            !['public', 'private'].includes(options.visibility) ||
            typeof options.generateVariants !== 'boolean'
          )
            return response.sendError(req, res, 400, 'INVALID_PICTURE_INPUT');
          filename = await temporaryFiles.createUpload(req.files?.picture);
          req.body = {
            ...input,
            pictureUpload : {
              fileId           : options.fileId,
              name             : req.files.picture.name,
              visibility       : options.visibility,
              generateVariants : options.generateVariants,
              tempFilePath     : filename,
            },
          };
          res.on(
            'finish',

            /**
             * Atiende el evento emitido por el colaborador.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              if (res.statusCode < 500) void temporaryFiles.remove(filename);
            },
          );
          return next();
        } catch {
          if (filename) await temporaryFiles.remove(filename);
          return response.sendError(req, res, 400, 'INVALID_PICTURE_INPUT');
        }
      },
    );
  };
};
