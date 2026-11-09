/** @file Identidad determinista de intención delegada, compartida por todas las fases de una transferencia. */
'use strict';
const { createHash } = require('node:crypto');
/** @param {string} action Acción canónica. @param {Object} principal Usuario, cliente, concesión y destino. @param {string} key Clave del cliente. @returns {string} Identidad privada estable, distinta por recurso de autorización. */
function requestIdentifier(action, principal, key) {
  return (
    'mcp:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          principal.grantCode,
          principal.clientId,
          principal.userCode,
          principal.workspace,
          action,
          key,
        ]),
      )
      .digest('hex')
  );
}
module.exports = { requestIdentifier };
