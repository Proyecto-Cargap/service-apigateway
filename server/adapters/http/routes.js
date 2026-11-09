/** @file Composición de routers HTTP con las dependencias proporcionadas por bootstrap. */
'use strict';
/**
 * Compone createRoutes con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRoutes(dependencies) {
  const express = require('express');
  const app     = express.Router();
  app.use(require('../../modules/security/routes/routes').createRouter(dependencies));
  app.use(
    require('../../modules/connect/routes/routes').createRouter({
      ...dependencies,
      sealSmtpCredentials : require('../crypto/smtp-request-credentials').smtpRequestCredentials(
        process.env.CONNECT_SMTP_ENCRYPTION_KEY,
      ),
    }),
  );
  app.use(require('../../modules/communication/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/documents/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/intelligence/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/platform/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/directory/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/customer/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/supplier/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/billing/routes/routes').createRouter(dependencies));
  app.use(require('../../modules/product/routes/routes').createRouter(dependencies));
  app.use(require('./not-found.controller').notFoundController(dependencies));

  return app;
}
module.exports = { createRoutes };
