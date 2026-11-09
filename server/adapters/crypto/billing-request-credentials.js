/** @file Sella por separado la cuenta global PAC y el CSD del emisor antes de Messaging. */
'use strict';
const { randomBytes, createCipheriv } = require('node:crypto');
const { ApplicationError }            = require('../../shared/application-error');
/** @param {string} encodedKey Clave de custodia compartida con Billing. @returns {Object} Fronteras cerradas para los dos propietarios de secretos. */
function billingRequestCredentials(encodedKey) {
  const key = Buffer.from(encodedKey || '', 'base64');
  /** @param {Object} input Secretos acreditados. @param {string} binding Propietario autenticado. @returns {string} Sobre opaco. */
  function encrypt(input, binding) {
    if (key.length !== 32 || key.toString('base64') !== encodedKey)
      throw new ApplicationError(503, 'BILLING_ENCRYPTION_NOT_CONFIGURED');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(binding));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      bytes.toString('base64'),
    ].join('.');
  }
  /** @param {Object} data Entrada HTTP. @param {string[]} allowed Campos propios. @param {number} minimum Primera revisión válida. @returns {void} Rechaza contexto y campos ajenos. */
  function validate(data, allowed, minimum) {
    if (
      Object.keys(data).some(
        /** @param {string} field Campo aportado. @returns {boolean} Campo no declarado. */
        (field) => !allowed.includes(field),
      ) ||
      !Number.isInteger(data.revision) ||
      data.revision < minimum
    )
      throw new ApplicationError(400, 'BILLING_INVALID_CREDENTIAL_INPUT');
  }
  return {
    /** @param {Object} data CSD y revisión. @param {Object} issuer Emisor acreditado por Billing. @returns {Object} CSD sellado sin API key. */
    csd(data, issuer) {
      validate(data, ['code', 'revision', 'certificate', 'privateKey', 'password'], 1);
      const input = {};
      for (const [name, limit] of [
        ['certificate', 32768],
        ['privateKey', 32768],
        ['password', 1024],
      ]) {
        const value = data[name] ?? '';
        if (typeof value !== 'string' || value.length > limit || (name !== 'password' && !value))
          throw new ApplicationError(400, 'BILLING_INVALID_CREDENTIAL_INPUT');
        input[name] = value;
      }
      return {
        code     : issuer.code,
        revision : data.revision,
        envelope : encrypt(input, `billing:csd:${issuer.workspace}:${issuer.code}:request`),
      };
    },
    /** @param {Object} data Ambiente, revisión y reemplazo opcional de API key. @returns {Object} Comando global sin credenciales en texto claro. */
    pac(data) {
      validate(data, ['revision', 'environment', 'apiKey', 'externalRefresh'], 0);
      if (!['development', 'production'].includes(data.environment))
        throw new ApplicationError(400, 'BILLING_INVALID_ENVIRONMENT');
      const result = {
        revision    : data.revision,
        environment : data.environment,
        ...(data.externalRefresh !== undefined ? { externalRefresh: data.externalRefresh } : {}),
      };
      if (data.apiKey !== undefined) {
        if (typeof data.apiKey !== 'string' || !/^[A-Za-z0-9]{32}$/.test(data.apiKey))
          throw new ApplicationError(400, 'BILLING_INVALID_PAC_CREDENTIALS');
        result.envelope = encrypt(
          { apiKey: data.apiKey },
          `billing:pac:${data.environment}:request`,
        );
      }
      return result;
    },
  };
}
module.exports = { billingRequestCredentials };
