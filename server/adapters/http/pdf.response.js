/**
 * @file Entrega de PDF desde el gateway: validación de archivos, respuesta de descarga y limpieza del
 * archivo temporal.
 */
'use strict';
/**
 * Compone createPdfResponse con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: logger, response, temporaryFiles, rpcTimeoutMs.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createPdfResponse({ logger, response, temporaryFiles: temporary, rpcTimeoutMs = 60000 }) {
  const handlers = { rpcTimeoutMs };
  const fs       = require('fs');
  const path     = require('path');

  const ERROR = {
    generation : 'N0000-C000-E0010:PDF generation failed',
    file       : 'N0000-C000-E0020:PDF file is not available',
    signature  : 'N0000-C000-E0030:Generated file is not a valid PDF',
    download   : 'N0000-C000-E0040:PDF download failed',
  };

  /**
   * Selecciona un código HTTP válido a partir de la respuesta o utiliza el valor predeterminado.
   *
   * @param {*} value Valor que se examina o transforma.
   * @param {*} [fallback] Valor predeterminado cuando la entrada no puede utilizarse.
   * @returns {number} Código HTTP válido o valor predeterminado recibido.
   */
  const getStatusCode = (value, fallback = 500) => {
    const statusCode = Number(value);
    return statusCode >= 400 && statusCode <= 599 ? statusCode : fallback;
  };

  /**
   * Obtiene la descripción asociada al código o valor de respuesta.
   *
   * @param {*} value Valor que se examina o transforma.
   * @param {*} [fallback] Valor predeterminado cuando la entrada no puede utilizarse.
   * @returns {*} Valores de salida de las ramas descritas; una salida sin expresión devuelve undefined.
   */
  const getDescription = (value, fallback = ERROR.generation) => {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
    if (typeof value?.descriptionCode === 'string' && value.descriptionCode.trim() !== '') {
      return value.descriptionCode;
    }
    if (typeof value?.message === 'string' && /^N\d{4}-C\d{3}-E\d{4}:/.test(value.message.trim())) {
      return value.message;
    }
    return fallback;
  };

  /**
   * Elimina el PDF temporal cuando termina o se interrumpe la descarga.
   *
   * @param {string} filePath Ruta del archivo utilizado por la operación.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  const deleteTempFile = (file) => {
    void temporary.remove(file);
  };

  /**
   * Extrae un nombre de descarga a partir de la ruta del archivo PDF.
   *
   * @param {string} filePath Ruta del archivo utilizado por la operación.
   * @returns {string} Nombre utilizado para la descarga del documento PDF.
   */
  const getDownloadName = (filePath) => {
    return path
      .basename(filePath)
      .replace(/_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\.pdf$)/i, '');
  };

  /**
   * Comprueba que la ruta de descarga corresponda a un archivo PDF utilizable.
   *
   * @param {string} filePath Ruta del archivo utilizado por la operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   * @throws {Error} La promesa se rechaza
   * cuando falla una comprobación explícita o se propaga un error de la operación.
   */
  const validatePdfFile = async (filePath) => {
    const fileStat = await fs.promises.stat(filePath);
    if (!fileStat.isFile() || fileStat.size < 4) {
      throw new Error(ERROR.file);
    }
    await fs.promises.access(filePath, fs.constants.R_OK);

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
      const signature     = Buffer.alloc(4);
      const { bytesRead } = await fileHandle.read(signature, 0, signature.length, 0);
      if (bytesRead !== signature.length || signature.toString('ascii') !== '%PDF') {
        throw new Error(ERROR.signature);
      }
    } finally {
      await fileHandle.close();
    }
  };

  /**
   * Valida la respuesta de generación, entrega el PDF y programa la limpieza del archivo temporal al
   * completar la descarga.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {Object} mqResponse Respuesta de mensajería con estado, descripción y datos de aplicación.
   * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
   * undefined.
   */
  handlers.send = async (req, res, mqResponse) => {
    if (!mqResponse || mqResponse.statusCode !== 200) {
      return response.sendError(
        req,
        res,
        getStatusCode(mqResponse?.statusCode),
        getDescription(mqResponse?.descriptionCode),
      );
    }

    const tempFilePath = mqResponse?.data?.tempFilePath;
    if (typeof tempFilePath !== 'string' || tempFilePath.trim() === '') {
      return response.sendError(req, res, 500, ERROR.file);
    }

    try {
      await temporary.validate(tempFilePath);
      await validatePdfFile(tempFilePath);
    } catch (error) {
      deleteTempFile(tempFilePath);
      return response.sendError(req, res, 500, getDescription(error, ERROR.file));
    }

    res.contentType('application/pdf');
    return res.download(
      tempFilePath,
      getDownloadName(tempFilePath),

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Error} error Fallo recibido por la continuación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (error) => {
        deleteTempFile(tempFilePath);
        if (error) {
          logger.error({
            component : 'application',
            event     : 'operation_failed',
          });
          if (!res.headersSent) {
            return response.sendError(req, res, 500, ERROR.download);
          }
        }
      },
    );
  };

  /**
   * Convierte el fallo de generación o descarga en una respuesta HTTP con código y descripción controlados.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {Error|Object} error Fallo que se clasifica, registra o propaga.
   * @returns {*} Resultado devuelto por response.sendError con los argumentos preparados por la función.
   */
  handlers.sendError = (req, res, error) => {
    return response.sendError(
      req,
      res,
      getStatusCode(error?.statusCode),
      getDescription(error?.descriptionCode || error),
    );
  };

  return handlers;
}
module.exports = { createPdfResponse };
