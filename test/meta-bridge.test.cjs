/** @file Pruebas de límites del puente Meta y admisión durable de runs sin cancelaciones. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs/promises');
const os     = require('node:os');
const path   = require('node:path');
const {
  metaRunAdmission,
} = require('../server/modules/meta-bridge/services/meta-run-admission.service');
const {
  metaPlatformService,
} = require('../server/modules/meta-bridge/services/meta-platform.service');
const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');
const { metaFiles }            = require('../server/adapters/files/meta-files');
const contracts                = require('../server/contracts');
/** @returns {Object} Repositorio CAS mínimo para carreras y recuperación. */
function repository() {
  let row;
  return {
    /** @returns {Promise<Object|null>} Copia de reserva actual. */
    async get() {
      return row ? structuredClone(row) : null;
    },
    /** @param {Object} value Nueva reserva. @returns {Promise<Object>} Inserción única por chat. */
    async create(value) {
      if (row) throw Object.assign(new Error('duplicate'), { code: 11000 });
      row = structuredClone(value);
      return structuredClone(row);
    },
    /** @param {Object} filter Revisión esperada. @param {Object} value Campos a cambiar. @returns {Promise<Object|null>} CAS o conflicto. */
    async change(filter, value) {
      if (filter.revision !== row.revision) return null;
      Object.assign(row, value, { revision: row.revision + 1 });
      return structuredClone(row);
    },
  };
}
test('una carrera entre mensajes admite sólo un run y nunca cancela al ya aceptado' /** @returns {Promise<void>} Solicitudes distintas compiten por el mismo chat. */, async () => {
  const admitted = new Map();
  const gate     = metaRunAdmission(repository());
  const calls    = [];
  /** @param {string} action Acción Intelligence. @param {Object} input Solicitud. @returns {Promise<Object>} Run canónico idempotente. */
  async function rpc(action, input) {
    calls.push(action);
    if (action === 'run-create') {
      if (!admitted.has(input.requestId))
        admitted.set(input.requestId, {
          runCode : input.requestId,
          status  : 'running',
        });
      return admitted.get(input.requestId);
    }
    return admitted.get(input.runCode);
  }
  const result = await Promise.allSettled([
    gate.create(
      'chat',
      {
        requestId : 'one',
        input     : { messageCode: 'm1' },
      },
      rpc,
    ),
    gate.create(
      'chat',
      {
        requestId : 'two',
        input     : { messageCode: 'm2' },
      },
      rpc,
    ),
  ]);
  assert.equal(
    result.filter(
      /** @param {Object} item Resultado de la carrera. @returns {boolean} Sólo una admisión exitosa. */
      (item) => item.status === 'fulfilled',
    ).length,
    1,
  );
  assert.equal(admitted.size, 1);
  assert(!calls.includes('run-cancel'));
});
test('un timeout se reconcilia con requestId persistido y puede continuar después de takeover' /** @returns {Promise<void>} Simula respuesta perdida después de creación canónica. */, async () => {
  const gate = metaRunAdmission(repository());
  let writes = 0,
    lost     = true;
  /** @param {string} action Acción. @param {Object} input Solicitud recuperada. @returns {Promise<Object>} Mismo run al reintentar. */
  async function rpc(action, input) {
    assert.notEqual(action, 'run-cancel');
    assert.equal(input.requestId, 'accepted');
    if (lost) {
      lost = false;
      writes++;
      throw new Error('response-lost');
    }
    return {
      runCode : 'run',
      status  : 'running',
    };
  }
  await assert.rejects(
    gate.create(
      'chat',
      {
        requestId : 'accepted',
        input     : { messageCode: 'm' },
      },
      rpc,
    ),
    /response-lost/,
  );
  assert.equal((await gate.resume('chat', 'accepted', 'm', rpc)).runCode, 'run');
  assert.equal(writes, 1);
  await assert.rejects(gate.resume('chat', 'accepted', 'other', rpc), {
    descriptionCode : 'META_RUN_REQUEST_CONFLICT',
  });
});
test('el puente obtiene actor, chat y workspace sólo del vínculo y Security; origen y DTO no admiten suplantación' /** @returns {Promise<void>} La llamada de Chat usa sujeto externo y chat reservado. */, async () => {
  const calls   = [];
  const context = {
    user        : {
      userCode : 'external',
      userType : 'external',
    },
    workspace   : 'w',
    sessionCode : 'internal',
  };
  const service = metaPlatformService({
    messaging : {
      /** @param {string} target Servicio. @param {string} action Acción. @param {Object} data DTO. @param {Object} options Identidad derivada. @returns {Promise<Object>} Capacidades canónicas simuladas. */
      async request(target, action, data, options) {
        calls.push({
          target,
          action,
          data,
          options,
        });
        if (action === 'meta-conversation-binding-get')
          return {
            statusCode : 200,
            data       : {
              workspaceCode        : 'w',
              ownerUserCode        : 'owner',
              contactCode          : 'external',
              externalUserCode     : 'external',
              chatConversationCode : 'chat',
            },
          };
        if (action === 'workspace-principals-get-list')
          return {
            statusCode : 200,
            data       : {
              items : [
                {
                  userCode : 'owner',
                  policies : ['connect.meta.update.global'],
                },
              ],
            },
          };
        if (action === 'external-principal-resolve')
          return {
            statusCode : 200,
            data       : { context },
          };
        return {
          statusCode : 200,
          data       : { conversationCode: 'chat' },
        };
      },
    },
  });
  await assert.rejects(
    service.execute(
      {
        operation        : 'chat-get',
        conversationCode : 'linked',
      },
      'service-directory',
    ),
    { statusCode: 403 },
  );
  assert.equal(calls.length, 0);
  await service.execute(
    {
      operation        : 'chat-get',
      conversationCode : 'linked',
    },
    'service-connect',
  );
  assert.equal(calls.at(-1).action, 'chat-get-one');
  assert.deepEqual(calls.at(-1).data, { code: 'chat' });
  assert.equal(calls.at(-1).options.context, context);
  assert.throws(
    /** @returns {Object} Actor de payload nunca admitido. */
    () =>
      contracts.actionDtos['meta-platform-execute'].input({
        operation        : 'chat-send',
        conversationCode : 'linked',
        data             : {
          requestId : 'req',
          userCode  : 'owner',
        },
      }),
    { statusCode: 400 },
  );
});
test('medios de20MiB viajan por TEMP privado y se rechazan symlink, digest falso y archivos fuera del límite' /** @returns {Promise<void>} No coloca bytes en MQ ni permite rutas externas. */, async () => {
  const root      = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-files-'));
  const temporary = createTemporaryFiles({ root });
  const files     = metaFiles(temporary);
  try {
    const filename = await temporary.createUpload({ data: Buffer.alloc(20 * 1024 * 1024, 7) });
    const digest   = await temporary.digest(filename);
    const input    = {
      tempFilePath : filename,
      size         : 20 * 1024 * 1024,
      name         : 'file.bin',
      mime         : 'application/octet-stream',
      digest,
    };
    assert.equal((await files.upload(input)).size, input.size);
    await assert.rejects(
      files.upload({
        ...input,
        digest : '0'.repeat(64),
      }),
      { descriptionCode: 'META_INVALID_MEDIA' },
    );
    const link = path.join(root, 'link');
    await fs.symlink(filename, link);
    await assert.rejects(
      files.upload({
        ...input,
        tempFilePath : link,
      }),
      { descriptionCode: 'META_INVALID_MEDIA' },
    );
    await fs.appendFile(filename, 'x');
    await assert.rejects(
      files.download({
        ...input,
        size : input.size + 1,
      }),
      { descriptionCode: 'META_INVALID_MEDIA' },
    );
  } finally {
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
test('un rechazo definitivo no se repite y429 conserva la misma reserva para reconciliar' /** @returns {Promise<void>} Diferencia rechazo confirmado de indisponibilidad o rate limit. */, async () => {
  const { ApplicationError } = require('../server/shared/application-error');
  for (const status of [403, 429]) {
    const gate   = metaRunAdmission(repository());
    let attempts = 0;
    /** @returns {Promise<Object>} Rechazo controlado de Intelligence. */
    async function rejected() {
      attempts++;
      throw new ApplicationError(status, 'UPSTREAM_REJECTION');
    }
    const input = {
      requestId : 'request',
      input     : { messageCode: 'message' },
    };
    await assert.rejects(gate.create('chat', input, rejected), { statusCode: status });
    await assert.rejects(gate.resume('chat', 'request', 'message', rejected), {
      statusCode : status,
    });
    assert.equal(attempts, status === 403 ? 1 : 2);
  }
});
test('una lectura antigua de modo automático no admite un run después de takeover confirmado' /** @returns {Promise<void>} El CAS de Connect decide la admisión; el snapshot de binding no concede permiso. */, async () => {
  const calls   = [];
  let reserve   = 0;
  const service = metaPlatformService({
    admission : {
      /** @returns {Promise<null>} No existía una admisión anterior. */ async resume() {
        return null;
      },
      /** @returns {Promise<void>} No debe reservar un run nuevo. */ async create() {
        reserve++;
      },
    },
    messaging : {
      /** @param {string} target Servicio. @param {string} action Operación. @returns {Promise<Object>} Autoridad cambió después del binding. */
      async request(target, action) {
        calls.push(action);
        if (action === 'meta-conversation-binding-get')
          return {
            statusCode : 200,
            data       : {
              workspaceCode        : 'w',
              ownerUserCode        : 'owner',
              contactCode          : 'ext',
              externalUserCode     : 'ext',
              chatConversationCode : 'chat',
              controlMode          : 'automatic',
              agentCode            : 'old-agent',
            },
          };
        if (action === 'workspace-principals-get-list')
          return {
            statusCode : 200,
            data       : {
              items : [
                {
                  userCode : 'owner',
                  policies : ['connect.meta.update.global'],
                },
              ],
            },
          };
        if (action === 'external-principal-resolve')
          return {
            statusCode : 200,
            data       : { context: { user: { userCode: 'ext' } } },
          };
        if (action === 'meta-run-authorize')
          return {
            statusCode      : 409,
            descriptionCode : 'META_AUTOMATION_PAUSED',
          };
        return {
          statusCode : 200,
          data       : { conversationCode: 'chat' },
        };
      },
    },
  });
  await assert.rejects(
    service.execute(
      {
        operation        : 'run-create',
        conversationCode : 'link',
        data             : {
          requestId   : 'req',
          messageCode : 'msg',
        },
      },
      'service-connect',
    ),
    { descriptionCode: 'META_AUTOMATION_PAUSED' },
  );
  assert.equal(reserve, 0);
  assert(calls.includes('meta-run-authorize'));
  assert(!calls.includes('run-create'));
});
