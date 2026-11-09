/** @file El catálogo MCP conserva JSON Schema sin compilación anticipada y mantiene rechazo de entradas y salidas inválidas. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { fromJsonSchema }         = require('@modelcontextprotocol/server');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
const { lazySchemaValidator }    = require('../server/adapters/mcp/lazy-schema-validator');
test('descubrir el contrato no compila; usarlo valida tipos, campos y formatos en cada entrega', /** @returns {void} El proveedor real rechaza datos inválidos antes de exponerlos o ejecutarlos. */ () => {
  const provider   = new AjvJsonSchemaValidator();
  let compilations = 0;
  const validator  = lazySchemaValidator({
    /** @param {Object} schema Contrato original. @returns {Function} Validador real del SDK. */
    getValidator(schema) {
      compilations++;
      return provider.getValidator(schema);
    },
  });
  const source     = {
    type                 : 'object',
    properties           : {
      name  : {
        type      : 'string',
        minLength : 1,
      },
      email : {
        type   : 'string',
        format : 'email',
      },
    },
    required             : ['name', 'email'],
    additionalProperties : false,
  };
  const standard   = fromJsonSchema(source, validator)['~standard'];
  assert.deepEqual(standard.jsonSchema.input(), source);
  assert.deepEqual(standard.jsonSchema.output(), source);
  assert.equal(compilations, 0);
  assert(
    standard.validate({
      name  : '',
      email : 'invalid',
    }).issues.length,
  );
  assert.equal(compilations, 1);
  const valid = {
    name  : 'Fixture',
    email : 'fixture@example.invalid',
  };
  assert.deepEqual(standard.validate(valid), { value: valid });
  assert(
    standard.validate({
      ...valid,
      extra : 'forbidden',
    }).issues.length,
  );
  assert(
    standard.validate({
      name  : 3,
      email : valid.email,
    }).issues.length,
  );
  assert.equal(compilations, 1);
});
