/** @file Sella secretos Meta antes de entrar al transporte; claves y texto claro nunca salen del adaptador. */
'use strict';
const { randomBytes, createCipheriv } = require('node:crypto');
const { ApplicationError }            = require('../../shared/application-error');
/** Construye cifrado autenticado compatible con el almacén de Connect.
 * @param {string} encodedKey Clave compartida de 32 bytes en base64 canónico.
 * @returns {Function} Sella campos explícitos sin modificar la entrada.
 */
function metaRequestCredentials(encodedKey) {
  const key   = typeof encodedKey === 'string' ? Buffer.from(encodedKey, 'base64') : Buffer.alloc(0);
  const valid = key.length === 32 && key.toString('base64') === encodedKey;
  /** @param {Object} data Datos cerrados. @param {string[]} fields Nombres de secretos permitidos. @returns {Object} Copia cuyos secretos viajan cifrados. */
  return function seal(data, fields) {
    const result = { ...data };
    for (const field of fields) {
      if (result[field] === undefined || result[field] === '') continue;
      if (typeof result[field] !== 'string' || result[field].length > 16384)
        throw new ApplicationError(400, 'META_INVALID_CREDENTIAL');
      if (!valid) throw new ApplicationError(503, 'META_ENCRYPTION_UNAVAILABLE');
      const iv     = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`meta-request:${field}`));
      const bytes = Buffer.concat([cipher.update(result[field], 'utf8'), cipher.final()]);
      result[field] = 'meta1.' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    }
    return result;
  };
}
module.exports = { metaRequestCredentials };
