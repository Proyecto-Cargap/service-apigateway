/** @file Rutas HTTP de directory y composición de sus controladores. */
'use strict';
/**
 * Compone createRouter con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRouter(dependencies) {
  const express = require('express');
  const app     = express.Router();
  app.use(
    require('../controllers/fiscal-catalog.controller').fiscalCatalogController(dependencies),
  );

  app.use(require('../controllers/settings.controller').settingsController(dependencies));

  app.use(require('../controllers/contact.controller').contactController(dependencies));
  app.use(require('../controllers/job.controller').jobController(dependencies));
  app.use(require('../controllers/department.controller').departmentController(dependencies));
  app.use(require('../controllers/businessline.controller').businesslineController(dependencies));
  app.use(require('../controllers/role.controller').roleController(dependencies));

  return app;
}
module.exports = { createRouter };
