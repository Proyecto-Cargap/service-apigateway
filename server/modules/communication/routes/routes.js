/** @file Composición HTTP del dominio Communication con dependencias inyectadas. */
'use strict';
/**
 * Registra las rutas autenticadas del chat.
 * @param {Object} dependencies Adaptadores compartidos del gateway.
 * @returns {Object} Router Express del dominio.
 */
function createRouter(dependencies) {
  const router = require('express').Router();
  router.use(require('../controllers/realtime.controller').realtimeController(dependencies));
  router.use(require('../controllers/chat.controller').chatController(dependencies));
  router.use(require('../controllers/timeline.controller').timelineController(dependencies));
  return router;
}
module.exports = { createRouter };
