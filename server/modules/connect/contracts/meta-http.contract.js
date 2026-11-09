/** @file Tipos de HTTP Meta antes del sellado: evita que campos anidados inválidos entren en la cola. */
'use strict';
const { validate }         = require('../../../contracts/action-dto');
const { ApplicationError } = require('../../../shared/application-error');
const CODE                 = {
  type      : 'string',
  minLength : 1,
  maxLength : 100,
};
const SECRET               = {
  type      : 'string',
  maxLength : 16384,
};
const AUTOMATION           = {
  type                 : 'object',
  properties           : {
    enabled   : { type: 'boolean' },
    agentCode : {
      type      : 'string',
      maxLength : 100,
    },
    teamCode  : {
      type      : 'string',
      maxLength : 100,
    },
  },
  required             : ['enabled'],
  additionalProperties : false,
};
const SETTINGS             = {
  type                 : 'object',
  additionalProperties : false,
  properties           : {
    enabled            : { type: 'boolean' },
    appId              : CODE,
    graphVersion       : {
      type    : 'string',
      pattern : '^v[0-9]{1,3}[.]0$',
    },
    publicBaseUrl      : {
      type      : 'string',
      minLength : 1,
      maxLength : 2048,
    },
    workspaceCode      : CODE,
    contactRoleCode    : CODE,
    externalGroupCodes : {
      type        : 'array',
      items       : CODE,
      maxItems    : 50,
      uniqueItems : true,
    },
    appSecret          : SECRET,
    verifyToken        : SECRET,
  },
  required             : [
    'enabled',
    'appId',
    'graphVersion',
    'publicBaseUrl',
    'workspaceCode',
    'contactRoleCode',
    'externalGroupCodes',
  ],
};
const CONNECTION           = {
  type                 : 'object',
  additionalProperties : false,
  properties           : {
    name              : {
      type      : 'string',
      minLength : 1,
      maxLength : 200,
    },
    channel           : { enum: ['whatsapp', 'instagram', 'messenger'] },
    assetId           : CODE,
    businessId        : {
      type      : 'string',
      maxLength : 100,
    },
    instagramAuthMode : { enum: ['unified', 'facebook_login'] },
    pageId            : {
      type      : 'string',
      maxLength : 100,
    },
    accessToken       : SECRET,
    active            : { type: 'boolean' },
    automation        : AUTOMATION,
  },
  required             : ['name', 'channel', 'assetId', 'active', 'automation'],
};
const CHALLENGE            = {
  type                 : 'object',
  properties           : {
    mode        : {
      type      : 'string',
      minLength : 1,
      maxLength : 30,
    },
    challenge   : {
      type      : 'string',
      minLength : 0,
      maxLength : 1000,
    },
    verifyToken : {
      type      : 'string',
      minLength : 1,
      maxLength : 16384,
    },
  },
  required             : ['mode', 'challenge', 'verifyToken'],
  additionalProperties : false,
};
/** Selecciona sólo el protocolo de verificación; las extensiones de query no se transportan ni autorizan.
 * @param {Object} query Consulta HTTP analizada por Express.
 * @returns {{ mode: string, challenge: string, verifyToken: string }} Campos canónicos escalares.
 * @throws {ApplicationError} Si falta un campo, supera límites o una clave repetida produce un array.
 */
function readMetaChallenge(query) {
  const input = {
    mode        : query['hub.mode'],
    challenge   : query['hub.challenge'],
    verifyToken : query['hub.verify_token'],
  };
  if (!validate(input, CHALLENGE)) throw new ApplicationError(400, 'INVALID_INPUT');
  return input;
}
/** Valida el DTO HTTP sin leer ni transformar credenciales.
 * @param {string} action Capacidad de guardado.
 * @param {Object} input Cuerpo original del navegador.
 * @returns {void} Rechaza antes de sellar o publicar a MQ.
 */
function validateMetaSave(action, input) {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !validate(input.data, action === 'settings-save' ? SETTINGS : CONNECTION)
  )
    throw new ApplicationError(400, 'INVALID_INPUT');
}
module.exports = {
  validateMetaSave,
  readMetaChallenge,
};
