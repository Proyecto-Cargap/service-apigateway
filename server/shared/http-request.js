/** @file Construcción inmutable del payload RPC con precedencia de identidad de ruta y campos del servidor. */
'use strict';
const forbidden = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'Authorization',
  'authorization',
]);
/**
 * Ejecuta mergeRequest dentro del flujo de http-request.
 * @param {Object} req Solicitud HTTP recibida por el middleware.
 * @param {...*} serverValues Valor de serverValues utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function mergeRequest(req, ...serverValues) {
  const output = {};
  for (const source of [req.query, req.body, req.params, ...serverValues]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) if (!forbidden.has(key)) output[key] = value;
  }
  return output;
}
module.exports = { mergeRequest };
