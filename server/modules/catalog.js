/** @file Catálogo RPC del Gateway: puente Meta interno explícito y contratos técnicos. */
'use strict';
/** @param {Object} dependencies Mensajería y adaptadores. @returns {Object[]} Acciones internas del Gateway. */
function createCatalog(dependencies) {
  const handler =
    require('./meta-bridge/compositions/meta-bridge.composition').metaBridgeComposition(
      dependencies,
    );
  return [
    {
      name : 'meta-platform-execute',
      kind : 'action',
      handler,
    },
  ];
}
module.exports = { createCatalog: require('../contracts/index').catalogFactory(createCatalog) };
