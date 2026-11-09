/** @file Reserva atómica por chat y reconciliación de la admisión sin cancelar runs existentes. */
'use strict';
/** @param {Object} model Modelo de admisión inyectado. @returns {Object} CAS y lectura durable, sin lógica de proveedor. */
function metaRunRepository(model) {
  return {
    /** @param {string} code Chat canónico. @returns {Promise<Object|null>} Reserva actual o ausencia real. */
    async get(code) {
      return model.findOne({ chatConversationCode: code }).lean();
    },
    /** @param {Object} input Reserva inicial. @returns {Promise<Object>} Reserva creada; duplica sólo si un competidor ganó. */
    async create(input) {
      return (await model.create(input)).toObject();
    },
    /** @param {Object} filter Revisión de la reserva observada. @param {Object} values Cambios propios del gate. @returns {Promise<Object|null>} CAS aceptado o conflicto concurrente. */
    async change(filter, values) {
      return model
        .findOneAndUpdate(
          filter,
          {
            $set : values,
            $inc : { revision: 1 },
          },
          { returnDocument: 'after' },
        )
        .lean();
    },
  };
}
module.exports = { metaRunRepository };
