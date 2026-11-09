/** @file Rutas HTTP de connect y composición de sus controladores. */
'use strict';
/**
 * Compone createRouter con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRouter(dependencies) {
  const express = require('express');
  const app     = express.Router();

  app.use(require('../controllers/meta.controller').metaController(dependencies));
  app.use(require('../controllers/mailbox.controller').mailboxController(dependencies));
  app.use(require('../controllers/settings.controller').settingsController(dependencies));
  app.use(require('../controllers/mail-account.controller').mailAccountController(dependencies));

  app.use(require('../controllers/mail-receiver.controller').mailReceiverController(dependencies));
  app.use(require('../controllers/mail-template.controller').mailTemplateController(dependencies));

  app.use(require('../controllers/email.controller').emailController(dependencies));

  return app;
}
module.exports = { createRouter };
