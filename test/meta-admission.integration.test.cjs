/** @file Admisión Meta con índice Mongo real: concurrencia, reserva persistente y recuperación tras reiniciar el caso de uso. */
'use strict';
const test           = require('node:test');
const assert         = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  metaRunRepository,
} = require('../server/modules/meta-bridge/repositories/meta-run.repository');
const {
  metaRunAdmission,
} = require('../server/modules/meta-bridge/services/meta-run-admission.service');
test(
  'Mongo real serializa dos mensajes y reconcilia la reserva después de reconstruir Gateway',
  {
    skip    : !process.env.TEST_META_MONGO_URI,
    timeout : 30000,
  },
  /** @returns {Promise<void>} Usa y elimina exclusivamente una base aleatoria local de la prueba. */
  async () => {
    const mongoose = require('mongoose');
    const uri      = process.env.TEST_META_MONGO_URI;
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const connection = await mongoose
      .createConnection(uri, {
        dbName    : 'meta_gateway_test_' + randomUUID().replaceAll('-', ''),
        autoIndex : false,
      })
      .asPromise();
    try {
      const schema = require('../server/modules/meta-bridge/models/meta-run.model').schema.clone();
      const model  = connection.model('MetaRun', schema, 'APIGATEWAY_META_RUN');
      await model.createCollection();
      for (const { key, ...options } of require('../server/mongodb-indexes.json').collections
        .APIGATEWAY_META_RUN)
        await model.collection.createIndex(key, options);
      const repository = metaRunRepository(model);
      const gate       = metaRunAdmission(repository);
      const runs       = new Map();
      let lost         = true;
      /** @param {string} action Acción remota canónica. @param {Object} input Clave idempotente o código de run. @returns {Promise<Object>} Una sola ejecución por requestId. */
      async function rpc(action, input) {
        assert.notEqual(action, 'run-cancel');
        if (action === 'run-get-one') return runs.get(input.runCode);
        if (!runs.has(input.requestId))
          runs.set(input.requestId, {
            runCode : input.requestId,
            status  : 'running',
          });
        if (lost) {
          lost = false;
          throw new Error('lost-response');
        }
        return runs.get(input.requestId);
      }
      const first = {
        requestId : 'one',
        input     : { messageCode: 'm1' },
      };
      await assert.rejects(gate.create('chat', first, rpc), /lost-response/);
      const restarted = metaRunAdmission(metaRunRepository(model));
      assert.equal((await restarted.resume('chat', 'one', 'm1', rpc)).runCode, 'one');
      await assert.rejects(
        restarted.create(
          'chat',
          {
            requestId : 'two',
            input     : { messageCode: 'm2' },
          },
          rpc,
        ),
        { descriptionCode: 'META_RUN_ACTIVE' },
      );
      assert.equal(runs.size, 1);
      assert.equal(await model.countDocuments(), 1);
      runs.get('one').status = 'completed';
      const concurrent = await Promise.allSettled([
        restarted.create(
          'chat',
          {
            requestId : 'two',
            input     : { messageCode: 'm2' },
          },
          rpc,
        ),
        restarted.create(
          'chat',
          {
            requestId : 'three',
            input     : { messageCode: 'm3' },
          },
          rpc,
        ),
      ]);
      assert.equal(
        concurrent.filter(
          /** @param {Object} result Competidor. @returns {boolean} Admisión aceptada. */
          (result) => result.status === 'fulfilled',
        ).length,
        1,
      );
      assert.equal(runs.size, 2);
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  },
);
