/** @file Registro completo de DTO por dominio; cada acción tiene entrada y salida explícitas. */
'use strict';
module.exports = Object.freeze(
  Object.assign(
    Object.create(null),
    require('../modules/system/dtos/system.actions.dto'),
    require('../modules/meta-bridge/dtos/meta-bridge.actions.dto'),
  ),
);
