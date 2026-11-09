/** @file Integración local MCP con contratos, casos de uso y revocación reales de Billing. */
'use strict';
const test               = require('node:test');
const assert             = require('node:assert/strict');
const { randomUUID }     = require('node:crypto');
const { mcpExecution }   = require('../server/modules/mcp/services/mcp-execution.service');
const tools              = require('../server/modules/mcp/contracts/mcp-tools.json');
const { existsSync }     = require('node:fs');
const path               = require('node:path');
const available          =
  existsSync(path.resolve(__dirname, '../../service-billing/test/expense-fixture.cjs')) &&
  existsSync(path.resolve(__dirname, '../../service-billing/node_modules/decimal.js'));
const integration        = {
  skip : available
    ? false
    : 'Requiere checkout contiguo service-billing con npm ci para integración local',
};
const { setup }          = available ? require('../../service-billing/test/expense-fixture.cjs') : {};
const { storage, input } = available
  ? require('../../service-billing/test/expense-files-fixture.cjs')
  : {};
const dtos               = available ? require('../../service-billing/server/contracts/registry') : {};
test(
  'MCP crea, recupera y consulta gastos con DTO cerrado y rechaza conexión revocada',
  integration,
  /** @returns {Promise<void>} Recorre el ejecutor MCP y las transacciones canónicas de Billing. */ async () => {
    const app = await setup({ expenseFiles: storage() }),
      calls   = [],
      tickets = [];
    let revoked    = false;
    const executor = mcpExecution({
      writesEnabled : true,
      clock         : Date.now,
      /** @returns {Promise<Object>} Principal vigente de una conexión consentida. */ async resolve() {
        return {
          userCode   : 'U1',
          workspace  : 'W1',
          workspaces : ['W1'],
          grantCode  : 'G1',
          clientId   : 'C1',
          policies   : app.actor.policies,
          scopes     : revoked ? [] : ['billing:read', 'billing:write'],
        };
      },
      /** @returns {Promise<void>} Auditoría del transporte sustituida. */ async audit() {},
      /** @param {Object} tool Capacidad. @param {Object} data Datos canónicos. @param {Object} context Principal. @returns {Object} Ticket inspeccionable sin transporte externo. */ transfer(
        tool,
        data,
        context,
      ) {
        const value = {
          tool,
          data,
          context,
        };
        tickets.push(value);
        return { url: 'https://local.test/transfer' };
      },
      /** @param {string} service Productor. @param {string} action Operación. @param {Object} data Entrada. @param {Object} context Actor acreditado. @returns {Promise<Object>} Invoca DTO y ejecutor delegado de Billing reales. */ async request(
        service,
        action,
        data,
        context,
      ) {
        assert.equal(service, 'service-billing');
        Object.assign(app.actor, context);
        calls.push({
          action,
          data,
        });
        dtos[action].input(data);
        const handler =
          action === 'billing-expense-create'
            ? app.expenses.create
            : action === 'billing-expense-file-upload-prepare'
              ? app.expenseAttachments.prepareUpload
              : /** @param {Object} query Filtros. @returns {Promise<Object>} Lista autorizada. */ (
                  query,
                ) => app.records.getList('expense', query);
        const value   = await app.delegated.execute(action, data, handler);
        return dtos[action].output({
          statusCode      : action.endsWith('-create') ? 201 : 200,
          descriptionCode : 'OK',
          data            : value,
        });
      },
    });
    const create   = tools.find(
      /** @param {Object} t Herramienta. @returns {boolean} Alta. */ (t) =>
        t.name === 'billing-expense-create',
    );
    const args     = {
      ...app.input,
      workspaceCode : 'W1',
    };
    const result   = await executor.execute(create, args, {
      scopes : ['billing:read', 'billing:write'],
    });
    assert.equal(
      (await executor.execute(create, args, { scopes: ['billing:read', 'billing:write'] })).data
        .code,
      result.data.code,
    );
    assert.equal(calls[0].data.idempotencyKey, args.idempotencyKey);
    const prep                          = tools.find(
      /** @param {Object} t Herramienta. @returns {boolean} Preparación privada. */ (t) =>
        t.name === 'billing-expense-file-upload-prepare',
    );
    const { tempFilePath, ...metadata } = input(result.data);
    await executor.execute(
      prep,
      {
        ...metadata,
        workspaceCode : 'W1',
      },
      { scopes: ['billing:read', 'billing:write'] },
    );
    assert.equal(tickets[0].context.operation.idempotencyKey, metadata.idempotencyKey);
    dtos['billing-expense-file-upload'].input({
      ...tickets[0].data,
      tempFilePath : '/private/transfer',
    });
    assert.equal(prep.transfer, 'billing-expense-upload');
    revoked = true;
    await assert.rejects(
      executor.execute(create, args, { scopes: ['billing:read', 'billing:write'] }),
      { descriptionCode: 'MCP_SCOPE_REQUIRED' },
    );
  },
);
test(
  'MCP importa XML por capacidad privada, paga, revierte y descarga con revocación vigente',
  integration,
  /** @param {Object} t Prueba. @returns {Promise<void>} Recorre HTTP de transferencia y catálogo RPC real sin recursos remotos. */ async (
    t,
  ) => {
    const fs = require('node:fs/promises'),
      os     = require('node:os'),
      path   = require('node:path');
    const { once } = require('node:events'),
      { Readable } = require('node:stream');
    const { createHash }           = require('node:crypto');
    const { expenseXml }           = require('../../service-billing/test/expense-xml-fixture.cjs');
    const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');
    const { transferCapabilities } = require('../server/adapters/mcp/transfer-capabilities');
    const { mountTransfers }       = require('../server/modules/mcp/routes/mcp-transfer.routes');
    const { createCatalog }        = require('../../service-billing/server/modules/catalog');
    const { payment }              = require('../../service-billing/test/expense-fixture.cjs');
    const root                     = await fs.mkdtemp(path.join(os.tmpdir(), 'expense-mcp-'));
    const temporaryFiles           = createTemporaryFiles({ root });
    t.after(
      /** @returns {Promise<void>} Limpia únicamente temporales locales de esta prueba. */ () =>
        fs.rm(root, {
          recursive : true,
          force     : true,
        }),
    );
    const files = storage(),
      app       = await setup({ expenseFiles: files });
    const xml  = expenseXml(),
      metadata = {
        byteLength : Buffer.byteLength(xml),
        sha256     : createHash('sha256').update(xml).digest('hex'),
      };
    /** @param {Object} owner Gasto autorizado. @param {string} resource Dominio. @param {Object} file Referencia adoptada. @returns {Promise<Object>} Copia temporal del original privado sintético. */
    files.read = async (owner, resource, file) => {
      assert.equal(files.originals.get(file.fileId).owner.code, owner.code);
      return {
        tempFilePath : await temporaryFiles.createStream(Readable.from([xml]), metadata),
        fileName     : file.name,
        mimeType     : file.mimeType,
      };
    };
    const express = require('express'),
      http        = express(),
      router      = express.Router();
    const server = http.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(/** @returns {void} Libera el puerto efímero. */ () => server.close());
    const base         = 'http://127.0.0.1:' + server.address().port;
    const capabilities = transferCapabilities({
      resource   : base + '/mcp',
      cookieKeys : ['expense-test-only'.repeat(3)],
    });
    let revoked        = false;
    /** @returns {Promise<Object>} Concesión sintética vigente con los permisos reales de Billing. */
    async function resolve() {
      return {
        userCode   : 'U1',
        workspace  : 'W1',
        workspaces : ['W1'],
        grantCode  : 'G1',
        clientId   : 'C1',
        policies   : app.actor.policies,
        scopes     : revoked ? [] : ['billing:read', 'billing:write'],
      };
    }
    const entries = new Map(
      createCatalog({
        services  : app,
        messaging : {
          /** @param {number} statusCode Estado. @param {Object} data Resultado canónico. @returns {Object} Sobre de mensajería. */
          successResponse(statusCode, data) {
            return {
              statusCode,
              descriptionCode : 'OK',
              data,
            };
          },
        },
      }).map(
        /** @param {Object} entry Acción. @returns {Array} Registro por nombre. */ (entry) => [
          entry.name,
          entry,
        ],
      ),
    );
    /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Entrada. @param {Object} actor Contexto revalidado. @returns {Promise<Object>} Ejecuta productor y DTO reales. */
    async function request(service, action, data, actor) {
      assert.equal(service, 'service-billing');
      Object.assign(app.actor, actor);
      return dtos[action].output(
        await entries.get(action).handler({ data: dtos[action].input(data) }),
      );
    }
    const executor = mcpExecution({
      writesEnabled : true,
      clock         : Date.now,
      resolve,
      request,
      transfer      : capabilities.issue,
      /** @returns {Promise<void>} Auditoría técnica sustituida. */ async audit() {},
    });
    mountTransfers({
      router,
      capabilities,
      resolve,
      request,
      temporaryFiles,
      writesEnabled : true,
    });
    http.use(router);
    http.use(
      /** @param {Error} error Fallo público. @param {Object} req Solicitud. @param {Object} res Respuesta. @param {Function} next Continuación Express. @returns {Object} Rechazo de autorización. */ (
        error,
        req,
        res,
        next,
      ) => res.status(error.statusCode || 500).json({ error: error.descriptionCode }),
    );
    /** @param {string} name Herramienta. @param {Object} data Entrada canónica. @returns {Promise<Object>} Resultado MCP con sesión sintética. */
    async function execute(name, data) {
      const tool = tools.find(
        /** @param {Object} value Capacidad. @returns {boolean} Coincidencia exacta. */ (value) =>
          value.name === name,
      );
      return executor.execute(
        tool,
        {
          ...data,
          workspaceCode : 'W1',
        },
        { scopes: ['billing:read', 'billing:write'] },
      );
    }
    const { date, currency, exchangeRate, lines, ...header } = app.input;
    const prepared                                           = await execute('billing-expense-import-prepare', {
      ...header,
      ...metadata,
      name : 'recibido.xml',
    });
    const transfer                                           = prepared.data.transfer;
    assert(!JSON.stringify(prepared).includes('tempFilePath'));
    const response = await fetch(transfer.url, {
      method  : transfer.method,
      headers : transfer.headers,
      body    : xml,
    });
    assert.equal(response.status, 201);
    const imported = (await response.json()).data;
    assert.equal(imported.total, '116.00');
    const confirmed = (
      await execute('billing-expense-confirm', {
        code           : imported.code,
        revision       : imported.revision,
        idempotencyKey : randomUUID(),
      })
    ).data;
    const paid      = (await execute('billing-expense-payment-create', payment([confirmed], ['116'])))
      .data;
    assert.equal(
      (await execute('billing-expense-get-one', { code: imported.code })).data.balance,
      '0.00',
    );
    await execute('billing-expense-payment-reverse', {
      code           : paid.code,
      revision       : paid.revision,
      reason         : 'Corrección local',
      idempotencyKey : randomUUID(),
    });
    assert.equal(
      (await execute('billing-expense-get-one', { code: imported.code })).data.balance,
      '116.00',
    );
    const download = (
      await execute('billing-expense-file-download-prepare', {
        resource : 'expense',
        code     : imported.code,
        fileId   : imported.files[0].fileId,
      })
    ).data.transfer;
    const bytes    = await fetch(download.url, { headers: download.headers });
    assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), xml);
    assert.equal(files.originals.size, 1);
    revoked = true;
    const rejected = await fetch(download.url, { headers: download.headers });
    assert.equal(rejected.status, 403);
    await rejected.text();
  },
);
