/** @file Cifra credenciales SMTP antes del RPC para evitar texto claro en colas y registros de mensajería. */
'use strict';
const crypto               = require('node:crypto');
const { ApplicationError } = require('../../shared/application-error');
/** @param {string|undefined} encodedKey Clave del servidor compartida exclusivamente con Connect. @returns {Function} Transformación HTTP a credenciales RPC selladas y ligadas al propietario. */
function smtpRequestCredentials(encodedKey) {
  const key = typeof encodedKey === 'string' ? Buffer.from(encodedKey, 'base64') : null;
  /** @param {Object} data Configuración HTTP; el DTO de Connect valida su estructura completa. @param {string} userCode Propietario derivado de ruta o sesión. @returns {Object} Copia sin valores de autenticación en claro para el RPC. */
  return function sealRequest(data, userCode) {
    if (!userCode || typeof userCode !== 'string') throw new ApplicationError(403, 'FORBIDDEN');
    const current = data?.conection?.auth;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return data;
    const auth = { ...current };
    for (const [name, limit] of [
      ['user', 1024],
      ['pass', 4096],
    ]) {
      const value = auth[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > limit)
        throw new ApplicationError(400, 'INVALID_SMTP_INPUT');
      if (!value.trim()) {
        auth[name] = '';
        continue;
      }
      if (!key || key.length !== 32 || key.toString('base64') !== encodedKey)
        throw new ApplicationError(503, 'SMTP_ENCRYPTION_UNAVAILABLE');
      const iv     = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`smtp-request:${userCode}:${name}`));
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      auth[name] = 'sealed:' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    }
    return {
      ...data,
      conection : {
        ...data.conection,
        auth,
      },
    };
  };
}
module.exports = { smtpRequestCredentials };
