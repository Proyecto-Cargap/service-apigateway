/** @file Rutas HTTP de security y composición de sus controladores. */
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
    require('../controllers/identity-directory.controller').identityDirectoryController(
      dependencies,
    ),
  );

  app.use(require('../controllers/settings.controller').settingsController(dependencies));

  app.use(require('../controllers/policy.controller').policyController(dependencies));
  app.use(require('../controllers/groups.controller').groupsController(dependencies));
  app.use(require('../controllers/session.controller').sessionController(dependencies));
  app.use(require('../controllers/user.controller').userController(dependencies));
  app.use(require('../controllers/workspaces.controller').workspacesController(dependencies));

  return app;
}
module.exports = { createRouter };
