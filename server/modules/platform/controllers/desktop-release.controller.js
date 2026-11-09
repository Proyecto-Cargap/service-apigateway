/** @file Descarga autenticada de instaladores; delega catálogo y autorización a Platform. */
'use strict';
const express = require('express');

/** @param {Object} dependencies Autorización, RPC, respuestas y almacén privado. @returns {Object} Rutas HTTP sin enlaces públicos ni credenciales en URLs. */
function desktopReleaseController({ messaging, response, authorization, desktopReleaseFiles }) {
  const router = express.Router();
  const base   = '/platform/desktop-release';
  router.get(
    base,
    authorization.authorizationValidation,
    /** @param {Object} req Sesión acreditada. @param {Object} res Salida HTTP. @returns {Promise<Object>} Catálogo privado o error explícito. */
    async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try {
        const result = await messaging.request(
          'service-platform',
          'desktop-release-current',
          {},
          { context: req.system },
        );
        return result.statusCode === 200
          ? response.send(req, res, 200, result.data)
          : response.sendError(req, res, result.statusCode, result.descriptionCode);
      } catch {
        return response.sendError(req, res, 503, 'DESKTOP_RELEASE_UNAVAILABLE');
      }
    },
  );
  router.get(
    `${base}/:version/:target/download`,
    authorization.authorizationValidation,
    /** @param {Object} req Selección y sesión verificadas. @param {Object} res Transferencia HTTP con soporte Range. @returns {Promise<void|Object>} Flujo del instalador sin cargarlo en memoria. */
    async (req, res) => {
      res.set({
        'Cache-Control'          : 'private, no-store',
        'X-Content-Type-Options' : 'nosniff',
      });
      try {
        const result = await messaging.request(
          'service-platform',
          'desktop-release-download',
          {
            version : req.params.version,
            target  : req.params.target,
          },
          { context: req.system },
        );
        if (result.statusCode !== 200)
          return response.sendError(req, res, result.statusCode, result.descriptionCode);
        const filename = await desktopReleaseFiles.resolve(result.data);
        const artifact = result.data.artifact;
        res.set('ETag', `"sha256-${artifact.sha256}"`);
        return res.download(
          filename,
          artifact.filename,
          {
            dotfiles     : 'deny',
            cacheControl : false,
          },
          /** @param {Error|null} error Fallo de transmisión, incluida desconexión. @returns {void} Finaliza sin filtrar rutas internas. */
          (error) => {
            if (!error) return;
            if (res.headersSent) res.destroy();
            else
              response.sendError(
                req,
                res,
                error.statusCode === 416 ? 416 : 503,
                'DESKTOP_DOWNLOAD_UNAVAILABLE',
              );
          },
        );
      } catch {
        if (res.headersSent) return res.destroy();
        return response.sendError(req, res, 503, 'DESKTOP_DOWNLOAD_UNAVAILABLE');
      }
    },
  );
  return router;
}
module.exports = { desktopReleaseController };
