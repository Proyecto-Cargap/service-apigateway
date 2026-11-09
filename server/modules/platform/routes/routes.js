/** @file Rutas HTTP de platform y composición de sus controladores. */
'use strict';
/**
 * Compone createRouter con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRouter(dependencies) {
  const express = require('express');
  const app     = express.Router();
  app.use(require('../controllers/realtime.controller').realtimeController(dependencies));
  app.use(require('../controllers/push.controller').pushController(dependencies));
  app.use(require('../controllers/notifications.controller').notificationsController(dependencies));

  app.use(require('../controllers/settings.controller').settingsController(dependencies));
  app.use(require('../controllers/configuration.controller').configurationController(dependencies));

  app.use(require('../controllers/instance.controller').instanceController(dependencies));

  app.use(require('../controllers/release.controller').releaseController(dependencies));
  app.use(
    require('../controllers/desktop-release.controller').desktopReleaseController(dependencies),
  );

  return app;
}
module.exports = { createRouter };
