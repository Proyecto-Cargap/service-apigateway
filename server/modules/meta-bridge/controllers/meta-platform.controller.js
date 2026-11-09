/** @file Adaptación RPC del puente interno Meta; no registra una ruta pública equivalente. */
'use strict';
const { metaPlatformPresenter } = require('../presenters/meta-platform.presenter');
/** @param {Object} dependencies Caso de uso y mensajería. @returns {Function} Handler con origen del sobre preservado. */
function metaPlatformController({ service, messaging }) {
  /** @param {Object} message Operación cerrada y origen técnico. @returns {Promise<Object>} Sobre canónico. */
  return async function execute(message) {
    return messaging.successResponse(
      200,
      metaPlatformPresenter(
        message.data.operation,
        await service.execute(message.data, message.originService),
      ),
    );
  };
}
module.exports = { metaPlatformController };
