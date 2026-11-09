/** @file Esquemas y proyecciones públicas MCP derivados de los contratos canónicos. */
'use strict';
const PRIVATE_FIELDS = new Set([
  '_id',
  '__v',
  'tempFilePath',
  'filePath',
  'token',
  'tokenHash',
  'sealedToken',
  'credentials',
  'password',
  'authorization',
  'agentAuthorization',
  'sourceBindings',
  'sourceRunCode',
  'sourceWorkspace',
  'contentUnavailable',
  'authorizedDispatch',
]);
/** @param {Object} schema Esquema de contrato. @returns {Object} Copia sin campos privados de infraestructura. */
function publicSchema(schema) {
  const result = structuredClone(schema);
  if (result.properties)
    for (const key of Object.keys(result.properties)) {
      if (PRIVATE_FIELDS.has(key)) {
        delete result.properties[key];
        result.required = (result.required || []).filter(
          /** @param {string} name Campo obligatorio. @returns {boolean} Campo público. */
          (name) => name !== key,
        );
      } else result.properties[key] = publicSchema(result.properties[key]);
    }
  if (result.items) result.items = publicSchema(result.items);
  for (const union of ['anyOf', 'oneOf', 'allOf'])
    if (result[union]) result[union] = result[union].map(publicSchema);
  return result;
}
/** @param {Object} endpoint Contrato vigente. @param {Object} tool Metadatos permitidos. @returns {Object} Entrada MCP sin campos de autoridad suministrados por el modelo. */
function toolInput(endpoint, tool) {
  const schema = publicSchema(endpoint.request);
  for (const key of [
    'workspace',
    'scope',
    'pictureUpload',
    'imageUpload',
    'condition',
    'fields',
    'workspaces',
    'accessPlatform',
    'userType',
  ]) {
    if (key === 'workspace' && tool.resourceWorkspace) continue;
    delete schema.properties[key];
    schema.required = (schema.required || []).filter(
      /** @param {string} name Campo. @returns {boolean} No forma parte del contexto privado. */
      (name) => name !== key,
    );
  }
  if (tool.inputFields)
    for (const key of Object.keys(schema.properties)) {
      if (!tool.inputFields.includes(key)) {
        delete schema.properties[key];
        schema.required = (schema.required || []).filter(
          /** @param {string} field Campo. @returns {boolean} Campo público permitido por la operación. */
          (field) => field !== key,
        );
      }
    }
  if (tool.requestIdFor) {
    delete schema.properties.requestId;
    schema.required = (schema.required || []).filter(
      /** @param {string} field Campo. @returns {boolean} Identidad de ejecución generada por Gateway. */
      (field) => field !== 'requestId',
    );
  }
  schema.required = [...new Set([...(schema.required || []), ...(tool.requiredInput || [])])];
  if (tool.name === 'chat-send' && schema.properties.text) schema.properties.text.maxLength = 10000;
  schema.properties.workspaceCode = {
    type        : 'string',
    minLength   : 1,
    maxLength   : 100,
    description : 'Workspace autorizado. Obligatorio cuando la conexión permite más de uno.',
  };
  if (tool.write) {
    schema.properties.idempotencyKey = {
      type        : 'string',
      minLength   : 16,
      maxLength   : 128,
      description :
        'Identidad única de esta operación. Conservarla exactamente al recuperar una respuesta perdida.',
    };
    schema.required = [
      ...new Set([
        ...(schema.required || []),
        'idempotencyKey',
        ...(tool.requireRevision && schema.properties.expectedRevision ? ['expectedRevision'] : []),
      ]),
    ];
  }
  schema.additionalProperties = false;
  return schema;
}
/** @param {*} value Respuesta acreditada. @returns {*} Datos sin rutas privadas ni credenciales a cualquier profundidad. */
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value))
      if (!PRIVATE_FIELDS.has(key)) result[key] = publicValue(item);
    return result;
  }
  return value;
}
/** @param {Object} endpoint Contrato canónico. @param {Object} tool Herramienta permitida. @returns {Object} Salida pública con instrucciones de transferencia cuando corresponde. */
function toolOutput(endpoint, tool) {
  const schema = publicSchema(endpoint.successData);
  if (tool.transfer) {
    schema.properties.transfer = {
      type                 : 'object',
      additionalProperties : false,
      required             : ['url', 'method', 'headers', 'expiresAt'],
      properties           : {
        url       : { type: 'string' },
        method    : {
          type : 'string',
          enum : ['GET', 'POST'],
        },
        expiresAt : { type: 'integer' },
        headers   : {
          type                 : 'object',
          additionalProperties : false,
          required             : ['Authorization'],
          properties           : {
            Authorization  : { type: 'string' },
            'Content-Type' : { type: 'string' },
          },
        },
      },
    };
    schema.required = [...(schema.required || []), 'transfer'];
  }
  return schema;
}
module.exports = {
  toolOutput,
  publicSchema,
  publicValue,
  toolInput,
};
