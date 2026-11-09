/** @file Rutas HTTP de documents y composición de sus controladores. */
'use strict';
/**
 * Compone createRouter con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRouter(dependencies) {
  const express = require('express');
  const app     = express.Router();

  app.use(require('../controllers/settings.controller').settingsController(dependencies));

  app.use(require('../controllers/files-storage.controller')(dependencies));
  app.use(require('../controllers/file.controller').fileController(dependencies));
  app.use(require('../controllers/documents.controller').documentsController(dependencies));

  return app;
}
module.exports = { createRouter };
