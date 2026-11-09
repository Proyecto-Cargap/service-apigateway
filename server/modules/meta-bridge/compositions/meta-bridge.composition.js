/** @file Composición del puente interno y sus recursos compartidos, sin iniciar listeners. */
'use strict';
/** @param {Object} dependencies Mensajería y sustitutos explícitos para pruebas. @returns {Function} Handler del puente Meta. */
function metaBridgeComposition(dependencies) {
  const temporaryFiles =
    dependencies.temporaryFiles ||
    require('../../../adapters/files/temporary-files').createTemporaryFiles({
      root   : process.env.TEMP,
      logger : dependencies.logger,
    });
  const files          =
    dependencies.metaFiles ||
    require('../../../adapters/files/meta-files').metaFiles(temporaryFiles);
  const repository     =
    dependencies.metaRuns ||
    require('../repositories/meta-run.repository').metaRunRepository(
      require('../models/meta-run.model'),
    );
  const admission      = require('../services/meta-run-admission.service').metaRunAdmission(repository);
  const service        = require('../services/meta-platform.service').metaPlatformService({
    messaging : dependencies.messaging,
    files,
    admission,
  });
  return require('../controllers/meta-platform.controller').metaPlatformController({
    service,
    messaging : dependencies.messaging,
  });
}
module.exports = { metaBridgeComposition };
