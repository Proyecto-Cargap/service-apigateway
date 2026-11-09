/** @file Capacidades cifradas de transferencia, acotadas a un archivo y concesión durante cinco minutos. */
'use strict';
const { createCipheriv, createDecipheriv, hkdfSync, randomBytes } = require('node:crypto');
const kinds                                                       = require('../../modules/mcp/contracts/transfer-kinds.json');
const { ApplicationError }                                        = require('../../shared/application-error');
/** @param {Object} options Recurso, llaves rotatorias y reloj. @returns {Object} Emisor y lector de capacidades sin tokens OAuth ni rutas locales. */
function transferCapabilities({ resource, cookieKeys, clock = Date.now }) {
  const keys = cookieKeys.map(
    /** @param {string} secret Llave de instalación. @returns {Buffer} Llave separada por propósito y recurso. */
    (secret) =>
      Buffer.from(hkdfSync('sha256', secret, resource, 'xidden-mcp-file-transfer-v1', 32)),
  );
  /** @param {Object} value Contenido autenticado. @param {string} kind Transferencia esperada. @returns {Object} Capacidad válida. */
  function validate(value, kind) {
    if (
      value.audience !== resource ||
      value.kind !== kind ||
      !Object.hasOwn(kinds, kind) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= clock() ||
      value.expiresAt > clock() + 300000 ||
      !value.context?.delegation?.grantCode ||
      !value.context?.delegation?.clientId ||
      !value.context?.user?.userCode ||
      !value.context.workspace ||
      !Array.isArray(value.scopes)
    )
      throw new ApplicationError(401, 'MCP_TRANSFER_INVALID');
    return value;
  }
  return {
    /** @param {Object} tool Operación permitida. @param {Object} data Entrada cerrada. @param {Object} context Identidad acreditada. @returns {Object} Instrucciones de transferencia privada. */
    issue(tool, data, context) {
      const expiresAt = clock() + 300000;
      const payload   = {
        audience : resource,
        kind     : tool.transfer,
        expiresAt,
        data,
        scopes   : tool.scopes,
        context  : {
          user       : context.user,
          workspace  : context.workspace,
          delegation : context.delegation,
          ...(context.operation ? { operation: context.operation } : {}),
        },
      };
      validate(payload, tool.transfer);
      const nonce = randomBytes(12),
        cipher    = createCipheriv('aes-256-gcm', keys[0], nonce);
      cipher.setAAD(Buffer.from('xidden-mcp-file-transfer-v1'));
      const encrypted  = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
      const capability = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
        'base64url',
      );
      return {
        url     : resource + '/transfers/' + tool.transfer,
        method  : kinds[tool.transfer].method,
        headers : {
          Authorization : 'Bearer ' + capability,
          ...(kinds[tool.transfer].method === 'POST'
            ? { 'Content-Type': 'application/octet-stream' }
            : {}),
        },
        expiresAt,
      };
    },
    /** @param {string} token Capacidad recibida sólo por encabezado. @param {string} kind Ruta solicitada. @returns {Object} Archivo y concesión originales. */
    read(token, kind) {
      if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new ApplicationError(401, 'MCP_TRANSFER_INVALID');
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.length < 29) throw new ApplicationError(401, 'MCP_TRANSFER_INVALID');
      for (const key of keys) {
        try {
          const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          cipher.setAAD(Buffer.from('xidden-mcp-file-transfer-v1'));
          cipher.setAuthTag(bytes.subarray(12, 28));
          const value = JSON.parse(
            Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
          );
          return validate(value, kind);
        } catch {
          /* Intenta la siguiente llave de la rotación sin revelar el fallo criptográfico. */
        }
      }
      throw new ApplicationError(401, 'MCP_TRANSFER_INVALID');
    },
  };
}
module.exports = { transferCapabilities };
