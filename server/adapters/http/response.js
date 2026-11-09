/**
 * @file Construcción de respuestas HTTP del gateway con estado, metadatos y datos de aplicación.
 */
'use strict';

const { randomUUID }      = require('node:crypto');
const PUBLIC_SERVER_CODES = new Set([
  'BILLING_ENCRYPTION_NOT_CONFIGURED',

  'META_UNAVAILABLE',
  'META_ENCRYPTION_UNAVAILABLE',
  'META_MEDIA_UNAVAILABLE',
  'MAILBOX_UNAVAILABLE',
  'MAILBOX_ATTACHMENT_UNAVAILABLE',
  'MAILBOX_STORAGE_UNAVAILABLE',
  'MAILBOX_DOWNLOAD_FAILED',
  'SMTP_DNS_FAILED',
  'SMTP_CONNECTION_FAILED',
  'SMTP_VERIFICATION_UNAVAILABLE',
  'SMTP_ENCRYPTION_UNAVAILABLE',
  'SMTP_CREDENTIALS_UNAVAILABLE',
  'MAIL_ACCOUNT_UNAVAILABLE',
  'IMAP_CONNECTION_FAILED',
  'STORAGE_WRITE_UNCERTAIN',
  'DOCUMENT_WRITE_UNCERTAIN',
  'DOCUMENT_SETTINGS_INVALID',
  'DOCUMENT_TRANSACTIONS_REQUIRED',
  'DOCUMENT_STORAGE_CONFIGURATION_REQUIRED',
  'DOCUMENT_CONTENT_UNAVAILABLE',
  'RELEASE_UNAVAILABLE',
  'DESKTOP_RELEASE_UNAVAILABLE',
  'DESKTOP_RELEASE_INVALID',
  'DESKTOP_DOWNLOAD_UNAVAILABLE',
  'RELEASE_WEB_BUILD_UNAVAILABLE',
  'RELEASE_WEB_BUILD_UNVERIFIED',
  'RELEASE_ENVIRONMENT_UNSUPPORTED',
  'RELEASE_INDEXES_REQUIRED',
  'RELEASE_TRANSACTIONS_REQUIRED',
]);
const statusCode          = {
  100 : 'Continue',
  101 : 'Switching Protocols',
  102 : 'Processing',

  200 : 'OK',
  201 : 'Created',
  202 : 'Accepted',
  203 : 'Non-Authoritative Information',
  204 : 'No Content',
  205 : 'Reset Content',
  206 : 'Partial Content',
  207 : 'Multi-Status',
  208 : 'Already Reported',
  226 : 'IM Used',

  300 : 'Multiple Choices',
  301 : 'Moved Permanently',
  302 : 'Found',
  303 : 'See Other',
  304 : 'Not Modified',
  305 : 'Use Proxy',
  306 : '(Unused)',
  307 : 'Temporary Redirect',
  308 : 'Permanent Redirect',

  400 : 'Bad Request',
  401 : 'Unauthorized',
  402 : 'Payment Required',
  403 : 'Forbidden',
  404 : 'Not Found',
  405 : 'Method Not Allowed',
  406 : 'Not Acceptable',
  407 : 'Proxy Authentication Required',
  408 : 'Request Timeout',
  409 : 'Conflict',
  410 : 'Gone',
  411 : 'Length Required',
  412 : 'Precondition Failed',
  413 : 'Request Entity Too Large',
  414 : 'Request-URI Too Long',
  415 : 'Unsupported Media Type',
  416 : 'Requested Range Not Satisfiable',
  417 : 'Expectation Failed',
  422 : 'Unprocessable Entity',

  500 : 'Internal Server Error',
  501 : 'Not Implemented',
  502 : 'Bad Gateway',
  503 : 'Service Unavailable',
  504 : 'Gateway Timeout',
  505 : 'HTTP Version Not Supported',
};

/**
 * Inicializa el identificador, la referencia del cliente y la fecha de la transacción HTTP.
 *
 * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
 * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
 * undefined.
 */
exports.init = async (req) => {
  req.transaction = {};
  req.transaction.id = randomUUID();
  req.transaction.identifier = req.get('Identifier') || '';
  req.transaction.requestDateTime = new Date().getTime();
  return req.transaction.id;
};

/**
 * Construye y envía la respuesta HTTP con metadatos de transacción y datos de aplicación.
 *
 * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
 * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
 * @param {number} status Código de estado de la respuesta HTTP.
 * @param {*} [dataResponse] Datos que se incluyen en la respuesta HTTP.
 * @param {Object} [options] includeNull conserva null cuando forma parte del contrato de lectura.
 * @returns {*} Resultado devuelto por res.status(status).json con los argumentos preparados por la
 * función.
 */
exports.send = (req, res, status, dataResponse = null, { includeNull = false } = {}) => {
  let response           = {};
  const responseDateTime = new Date().getTime();
  if (dataResponse || includeNull) {
    response = {
      headerResponse   : {
        transaction      : req.transaction.id,
        statusCode       : status,
        descriptionCode  : getDescription(status),
        identifier       : req.transaction.identifier,
        responseDateTime : responseDateTime,
        timeExecution    : responseDateTime - req.transaction.requestDateTime,
      },
      businessResponse : dataResponse,
    };
  } else {
    response = {
      headerResponse : {
        transaction      : req.transaction.id,
        statusCode       : status,
        descriptionCode  : getDescription(status),
        identifier       : req.transaction.identifier,
        responseDateTime : responseDateTime,
        timeExecution    : responseDateTime - req.transaction.requestDateTime,
      },
    };
  }
  return res.status(status).json(response);
};

/**
 * Construye y envía la respuesta HTTP de error con los metadatos de la transacción.
 *
 * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
 * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
 * @param {number} status Código de estado de la respuesta HTTP.
 * @param {Object} [message] Mensaje que se procesa en esta ejecución.
 * @param {*} [dataResponse] Datos que se incluyen en la respuesta HTTP.
 * @returns {*} Resultado devuelto por res.status(status).json con los argumentos preparados por la
 * función.
 */
exports.sendError = (req, res, status, message = null, dataResponse = null) => {
  status =
    Number.isInteger(Number(status)) && Number(status) >= 400 && Number(status) <= 599
      ? Number(status)
      : 500;
  if (!req.transaction)
    req.transaction = {
      id              : randomUUID(),
      identifier      : '',
      requestDateTime : Date.now(),
    };
  const symbolicCode     = typeof message === 'string' && /^[A-Z][A-Z0-9_]{0,199}$/.test(message);
  const safeMessage      =
    (status < 500 &&
      typeof message === 'string' &&
      message.length <= 200 &&
      (symbolicCode || /^[A-Z0-9_-]+:[a-zA-Z0-9 .,_-]+$/.test(message))) ||
    (status >= 500 && PUBLIC_SERVER_CODES.has(message))
      ? message
      : getDescription(status);
  let response           = {};
  const responseDateTime = new Date().getTime();
  response = {
    headerResponse : {
      transaction      : req.transaction.id,
      statusCode       : status,
      descriptionCode  : safeMessage,
      identifier       : req.transaction.identifier,
      responseDateTime : responseDateTime,
      timeExecution    : responseDateTime - req.transaction.requestDateTime,
    },
  };
  if (dataResponse) {
    response.businessResponse = dataResponse;
  }
  return res.status(status).json(response);
};

/**
 * Obtiene la descripción asociada al código o valor de respuesta.
 *
 * @param {string} code Código o modalidad utilizado por esta operación.
 * @returns {*} Valores de salida de las ramas descritas; una salida sin expresión devuelve undefined.
 */
function getDescription(code) {
  const codeData = statusCode[code];
  return codeData ? codeData : statusCode[500];
}
