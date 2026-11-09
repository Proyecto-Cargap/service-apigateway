/** @file Serializa admisión por chat; un timeout conserva solicitud para reconciliación idempotente. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const TERMINAL             = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
/** @param {Object} repository Lectura y CAS de la reserva por chat. @returns {Object} Admisión y lectura limitada al run enlazado. */
function metaRunAdmission(repository) {
  /** Resuelve una solicitud incierta reusando el requestId canónico; nunca ejecuta cancel.
   * @param {Object} row Reserva durable.
   * @param {Function} rpc Llamada Intelligence con identidad externa verificada.
   * @returns {Promise<Object>} Estado canónico de la ejecución admitida.
   */
  async function reconcile(row, rpc) {
    if (row.terminal && row.rejectionCode)
      throw new ApplicationError(row.rejectionStatus, row.rejectionCode);
    if (row.runCode)
      return rpc('run-get-one', {
        runCode : row.runCode,
        scope   : 'owner',
      });
    try {
      const run = await rpc('run-create', row.input);
      await repository.change(
        {
          chatConversationCode : row.chatConversationCode,
          requestId            : row.requestId,
          revision             : row.revision,
        },
        { runCode: run.runCode },
      );
      return run;
    } catch (error) {
      if (
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        ![408, 425, 429].includes(error.statusCode) &&
        error.uncertain !== true
      )
        await repository.change(
          {
            chatConversationCode : row.chatConversationCode,
            revision             : row.revision,
          },
          {
            terminal        : true,
            rejectionStatus : error.statusCode,
            rejectionCode   : error.descriptionCode || 'META_RUN_REJECTED',
          },
        );
      throw error;
    }
  }
  return {
    /** Reconcilia sólo una admisión previa, incluso después de takeover o cambio de agente.
     * @param {string} code Chat enlazado.
     * @param {string} requestId Solicitud previamente reservada.
     * @param {string} messageCode Mensaje canónico de la solicitud.
     * @param {Function} rpc Cliente Intelligence autenticado.
     * @returns {Promise<Object|null>} Run previo o ausencia de esa admisión.
     */
    async resume(code, requestId, messageCode, rpc) {
      const row = await repository.get(code);
      if (!row || row.requestId !== requestId) return null;
      if (row.input.input.messageCode !== messageCode)
        throw new ApplicationError(409, 'META_RUN_REQUEST_CONFLICT');
      return reconcile(row, rpc);
    },
    /** @param {string} code Chat enlazado. @param {Object} input Solicitud canónica derivada del vínculo. @param {Function} rpc Intelligence acreditado. @returns {Promise<Object>} Run único o conflicto explícito. */
    async create(code, input, rpc) {
      let row = await repository.get(code);
      if (!row) {
        try {
          row = await repository.create({
            chatConversationCode : code,
            requestId            : input.requestId,
            input,
            revision             : 1,
          });
        } catch (error) {
          if (error.code !== 11000) throw error;
          row = await repository.get(code);
        }
      }
      if (!row) throw new ApplicationError(503, 'META_ADMISSION_UNAVAILABLE');
      if (row.requestId === input.requestId) {
        if (JSON.stringify(row.input) !== JSON.stringify(input))
          throw new ApplicationError(409, 'META_RUN_REQUEST_CONFLICT');
        return reconcile(row, rpc);
      }
      if (!row.terminal) {
        const prior = await reconcile(row, rpc);
        if (!TERMINAL.has(prior.status)) throw new ApplicationError(409, 'META_RUN_ACTIVE');
      }
      row = await repository.change(
        {
          chatConversationCode : code,
          revision             : row.revision,
        },
        {
          requestId       : input.requestId,
          input,
          runCode         : '',
          terminal        : false,
          rejectionStatus : 0,
          rejectionCode   : '',
        },
      );
      if (!row) throw new ApplicationError(409, 'META_RUN_ACTIVE');
      return reconcile(row, rpc);
    },
    /** @param {string} code Chat enlazado. @param {string} runCode Ejecución solicitada. @param {Function} rpc Intelligence acreditado. @returns {Promise<Object>} Únicamente el run de ese chat. */
    async get(code, runCode, rpc) {
      const row = await repository.get(code);
      if (!row || (row.runCode && row.runCode !== runCode))
        throw new ApplicationError(403, 'META_RUN_FORBIDDEN');
      const run = await reconcile(row, rpc);
      if (run.runCode !== runCode) throw new ApplicationError(403, 'META_RUN_FORBIDDEN');
      return run;
    },
  };
}
module.exports = { metaRunAdmission };
