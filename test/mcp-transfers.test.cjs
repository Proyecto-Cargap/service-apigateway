/** @file Capacidades de archivos: caducidad, audiencia, manipulación, tamaño, integridad y revocación. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const fs                       = require('node:fs/promises');
const os                       = require('node:os');
const path                     = require('node:path');
const { createHash }           = require('node:crypto');
const { Readable }             = require('node:stream');
const { once }                 = require('node:events');
const { transferCapabilities } = require('../server/adapters/mcp/transfer-capabilities');
const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');
const { mountTransfers }       = require('../server/modules/mcp/routes/mcp-transfer.routes');
test('capacidad cifrada restringe archivo, método, recurso, tiempo y rotación', /** @returns {void} Rechaza alteraciones sin exponer el contenido. */ () => {
  let now      = 1000000;
  const config = {
    resource                                         : 'https://example.test/mcp',
    cookieKeys                                       : ['a'.repeat(40)],
    /** @returns {number} Reloj controlado. */ clock : () => now,
  };
  const issuer = transferCapabilities(config),
    context    = {
      user       : { userCode: 'U1' },
      workspace  : 'W1',
      delegation : {
        grantCode : 'G1',
        clientId  : 'C1',
      },
    };
  const transfer = issuer.issue(
      {
        transfer : 'download',
        scopes   : ['documents:download'],
      },
      { entryId: 'file1' },
      context,
    ),
    token        = transfer.headers.Authorization.slice(7);
  assert(!transfer.url.includes(token));
  assert.equal(issuer.read(token, 'download').data.entryId, 'file1');
  assert.throws(
    /** @returns {Object} No permite convertir lectura en escritura. */ () =>
      issuer.read(token, 'upload'),
    { statusCode: 401 },
  );
  assert.throws(
    /** @returns {Object} No admite otro recurso. */ () =>
      transferCapabilities({
        ...config,
        resource : 'https://other.test/mcp',
      }).read(token, 'download'),
    { statusCode: 401 },
  );
  assert.throws(
    /** @returns {Object} No admite manipulación. */ () =>
      issuer.read((token[0] === 'X' ? 'Y' : 'X') + token.slice(1), 'download'),
    { statusCode: 401 },
  );
  assert.equal(
    transferCapabilities({
      ...config,
      cookieKeys : ['b'.repeat(40), ...config.cookieKeys],
    }).read(token, 'download').context.user.userCode,
    'U1',
  );
  now += 300001;
  assert.throws(/** @returns {Object} Caducidad absoluta. */ () => issuer.read(token, 'download'), {
    statusCode : 401,
  });
});
test('upload usa streaming acotado, huella exacta y autorización vigente antes del RPC', /** @param {Object} t Prueba. @returns {Promise<void>} Frontera HTTP real con Security sintético. */ async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-transfer-'));
  t.after(
    /** @returns {Promise<void>} Limpia temporales de prueba. */ () =>
      fs.rm(root, {
        recursive : true,
        force     : true,
      }),
  );
  const temporaryFiles = createTemporaryFiles({ root });
  const metadata       = {
    byteLength : 3,
    sha256     : createHash('sha256').update('abc').digest('hex'),
  };
  const file           = await temporaryFiles.createStream(Readable.from(['a', 'bc']), metadata);
  assert.equal(await fs.readFile(file, 'utf8'), 'abc');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await temporaryFiles.remove(file);
  await assert.rejects(temporaryFiles.createStream(Readable.from(['abcd']), metadata), {
    statusCode : 413,
  });
  await assert.rejects(temporaryFiles.createStream(Readable.from(['xyz']), metadata), {
    statusCode : 400,
  });
  assert.deepEqual(await fs.readdir(root), []);
  const express = require('express'),
    app         = express(),
    router      = express.Router();
  const capabilities = transferCapabilities({
    resource   : 'https://example.test/mcp',
    cookieKeys : ['x'.repeat(40)],
  });
  const context      = {
    user       : { userCode: 'U1' },
    workspace  : 'W1',
    delegation : {
      grantCode : 'G1',
      clientId  : 'C1',
    },
    operation  : { idempotencyKey: 'stable-operation-1' },
  };
  const prepared     = capabilities.issue(
    {
      transfer : 'upload',
      scopes   : ['documents:upload'],
    },
    {
      ...metadata,
      repositoryId : 'root',
      fileName     : 'sample.txt',
    },
    context,
  );
  let revoked = false,
    calls     = 0;
  mountTransfers({
    router,
    capabilities,
    temporaryFiles,
    writesEnabled : true,
    /** @returns {Promise<Object>} Consentimiento actual. */ async resolve() {
      return {
        userCode   : 'U1',
        workspace  : 'W1',
        scopes     : revoked ? [] : ['documents:upload'],
        policies   : [],
        workspaces : ['W1'],
      };
    },
    /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Archivo. @param {Object} actor Principal. @returns {Promise<Object>} Productor sintético. */ async request(
      service,
      action,
      data,
      actor,
    ) {
      calls++;
      assert.equal(service, 'service-documents');
      assert.equal(action, 'documents-file-upload');
      assert.equal(await fs.readFile(data.tempFilePath, 'utf8'), 'abc');
      assert.equal(actor.operation.idempotencyKey, 'stable-operation-1');
      return {
        statusCode : 200,
        data       : { id: 'file' },
      };
    },
  });
  app.use(router);
  app.use(
    /** @param {Error} error Fallo público. @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {*} Sobre de prueba. */ (
      error,
      req,
      res,
      next,
    ) => res.status(error.statusCode || 500).json({ error: error.descriptionCode }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(/** @returns {void} Cierra HTTP. */ () => server.close());
  const url  = 'http://127.0.0.1:' + server.address().port + '/mcp/transfers/upload';
  let result = await fetch(url, {
    method  : 'POST',
    headers : prepared.headers,
    body    : 'abc',
  });
  assert.equal(result.status, 200);
  await result.json();
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(root), []);
  revoked = true;
  result = await fetch(url, {
    method  : 'POST',
    headers : prepared.headers,
    body    : 'abc',
  });
  assert.equal(result.status, 403);
  await result.json();
  assert.equal(calls, 1);
});
