/** @file Aceptación HTTP de instaladores: sesión, bytes, rangos y confinamiento de rutas. */
'use strict';
const test                                                 = require('node:test');
const assert                                               = require('node:assert/strict');
const { once }                                             = require('node:events');
const { createHash }                                       = require('node:crypto');
const { mkdtemp, mkdir, writeFile, realpath, symlink, rm } = require('node:fs/promises');
const path                                                 = require('node:path');
const os                                                   = require('node:os');
const express                                              = require('express');
const {
  desktopReleaseController,
} = require('../server/modules/platform/controllers/desktop-release.controller');
const { desktopReleaseFiles } = require('../server/adapters/files/desktop-release.files');

test('descarga sólo con sesión; conserva bytes, nombre, Range y versión autorizada' /** @returns {Promise<void>} Servidor HTTP y archivo temporales sin datos productivos. */, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'desktop-http-'));
  const root      = await realpath(temporary);
  const bytes     = Buffer.from('contenido sintético de un instalador');
  const version   = '0.1.1';
  const artifact  = {
    target   : 'win-x64',
    filename : 'Xidden-Documentos-0.1.1-win-x64.exe',
    bytes    : bytes.length,
    sha256   : createHash('sha256').update(bytes).digest('hex'),
  };
  await mkdir(path.join(root, version));
  await writeFile(path.join(root, version, artifact.filename), bytes);
  let requests = 0;
  const app    = express();
  app.use(
    desktopReleaseController({
      desktopReleaseFiles : desktopReleaseFiles(root),
      authorization       : {
        /** @param {Object} req Solicitud HTTP. @param {Object} res Respuesta. @param {Function} next Continuación. @returns {Object|void} Acredita una sesión de prueba. */
        authorizationValidation(req, res, next) {
          if (req.headers.authorization !== 'test-session') return res.sendStatus(401);
          req.system = {
            user        : { userCode: 'user' },
            sessionCode : 'session',
          };
          next();
        },
      },
      messaging           : {
        /** @param {string} service Destino. @param {string} action Acción. @param {Object} input DTO. @param {Object} options Contexto de servidor. @returns {Promise<Object>} Resultado controlado del puerto RPC. */
        async request(service, action, input, options) {
          requests++;
          assert.equal(service, 'service-platform');
          assert.equal(options.context.user.userCode, 'user');
          if (action === 'desktop-release-current')
            return {
              statusCode : 200,
              data       : { release: null },
            };
          if (input.version !== version)
            return {
              statusCode      : 409,
              descriptionCode : 'DESKTOP_RELEASE_CHANGED',
            };
          if (input.target !== artifact.target)
            return {
              statusCode      : 404,
              descriptionCode : 'DESKTOP_ARTIFACT_UNAVAILABLE',
            };
          return {
            statusCode : 200,
            data       : {
              version,
              artifact,
            },
          };
        },
      },
      response            : {
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {Object} data Resultado. @returns {Object} Respuesta. */
        send(req, res, status, data) {
          return res.status(status).json(data);
        },
        /** @param {Object} req Solicitud. @param {Object} res Respuesta. @param {number} status Estado. @param {string} code Causa. @returns {Object} Error sin ruta interna. */
        sendError(req, res, status, code) {
          return res.status(status).json({ code });
        },
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base    = 'http://127.0.0.1:' + server.address().port + '/platform/desktop-release';
  const headers = { authorization: 'test-session' };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base + '/0.1.1/win-x64/download')).status, 401);
    assert.equal(requests, 0);
    assert.deepEqual(await (await fetch(base, { headers })).json(), { release: null });
    const response = await fetch(base + '/0.1.1/win-x64/download?userCode=other', { headers });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-disposition'),
      /attachment; filename="Xidden-Documentos-0.1.1-win-x64.exe"/,
    );
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const partial = await fetch(base + '/0.1.1/win-x64/download', {
      headers : {
        ...headers,
        Range : 'bytes=0-4',
      },
    });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 5));
    assert.equal((await fetch(base + '/0.1.0/win-x64/download', { headers })).status, 409);
    assert.equal((await fetch(base + '/0.1.1/mac-x64/download', { headers })).status, 404);
    await rm(path.join(root, version, artifact.filename));
    await writeFile(path.join(root, 'outside'), bytes);
    await symlink(path.join(root, 'outside'), path.join(root, version, artifact.filename));
    assert.equal((await fetch(base + '/0.1.1/win-x64/download', { headers })).status, 503);
    await assert.rejects(
      desktopReleaseFiles(root).resolve({
        version : '../escape',
        artifact,
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise(
      /** @param {Function} resolve Confirma el cierre del servidor propio. @returns {void} Cierra el listener. */
      (resolve) => server.close(resolve),
    );
    await rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
