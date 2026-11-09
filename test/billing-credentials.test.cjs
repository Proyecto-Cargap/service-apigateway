/** @file Custodia en Gateway: las credenciales viajan cifradas y ligadas al emisor autorizado, sin claves de producción. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { randomBytes, createDecipheriv } = require('node:crypto');
const {
  billingRequestCredentials,
} = require('../server/adapters/crypto/billing-request-credentials');
test('Gateway sella secretos para el emisor acreditado y rechaza propiedades o claves inválidas', /** @returns {void} Comprueba el formato interoperable AES-GCM antes de publicar en Messaging. */ () => {
  const key = randomBytes(32),
    seal    = billingRequestCredentials(key.toString('base64'));
  const issuer = {
    code        : 'I1',
    workspace   : 'W1',
    environment : 'development',
  };
  const input  = {
    code        : 'I1',
    revision    : 1,
    certificate : 'certificate-test',
    privateKey  : 'private-test',
    password    : 'password-test',
  };
  const result                = seal.csd(input, issuer),
    [version, iv, tag, bytes] = result.envelope.split('.');
  assert.equal(version, 'v1');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'envelope', 'revision']);
  assert.equal(JSON.stringify(result).includes('private-test'), false);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from('billing:csd:W1:I1:request'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decoded = JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(bytes, 'base64')), decipher.final()]).toString(),
  );
  assert.equal(decoded.password, input.password);
  assert.throws(
    /** @returns {Object} El usuario no elige el workspace del sobre. */ () =>
      seal.csd(
        {
          ...input,
          workspace : 'OTHER',
        },
        issuer,
      ),
    /BILLING_INVALID_CREDENTIAL_INPUT/,
  );
  assert.throws(
    /** @returns {Object} No se transporta texto claro cuando falta la clave de custodia. */ () =>
      billingRequestCredentials('').csd(input, issuer),
    /BILLING_ENCRYPTION_NOT_CONFIGURED/,
  );
});
test('Gateway sella la cuenta global ligada al ambiente y rechaza campos retirados en el CSD', /** @returns {void} API key separada, validación cerrada y cambio de ambiente sin bloqueo. */ () => {
  const key = randomBytes(32),
    seal    = billingRequestCredentials(key.toString('base64'));
  for (const environment of ['development', 'production']) {
    const result             = seal.pac({
      revision : 3,
      environment,
      apiKey   : 'A'.repeat(32),
    });
    const [, iv, tag, bytes] = result.envelope.split('.');
    const decipher           = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`billing:pac:${environment}:request`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    assert.deepEqual(
      JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(bytes, 'base64')), decipher.final()]).toString(),
      ),
      { apiKey: 'A'.repeat(32) },
    );
    assert.equal(JSON.stringify(result).includes('AAAA'), false);
    assert.deepEqual(
      seal.pac({
        revision : 4,
        environment,
      }),
      {
        revision : 4,
        environment,
      },
    );
  }
  assert.throws(
    /** @returns {Object} La cuenta global no admite propiedad por workspace. */
    () =>
      seal.pac({
        revision    : 0,
        environment : 'development',
        workspace   : 'W1',
      }),
    /BILLING_INVALID_CREDENTIAL_INPUT/,
  );
  assert.throws(
    /** @returns {Object} El CSD no acepta la API key retirada. */
    () =>
      seal.csd(
        {
          revision : 1,
          code     : 'I1',
          apiKey   : 'A'.repeat(32),
        },
        {
          code      : 'I1',
          workspace : 'W1',
        },
      ),
    /BILLING_INVALID_CREDENTIAL_INPUT/,
  );
});
