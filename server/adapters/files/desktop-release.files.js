/** @file Confina la transferencia de instaladores al almacén privado inmutable de distribución. */
'use strict';
const { lstat, realpath } = require('node:fs/promises');
const path                = require('node:path');

/** @param {string} root Raíz privada compartida con Platform. @returns {Object} Resolvedor de artefactos ya autorizados. */
function desktopReleaseFiles(root) {
  const directory = path.resolve(root);
  return {
    /** @param {Object} selection Versión y metadatos devueltos por Platform. @returns {Promise<string>} Ruta acreditada sin symlinks ni escapes. */
    async resolve({ version, artifact }) {
      if (
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) ||
        !['mac-arm64', 'mac-x64', 'win-x64'].includes(artifact?.target)
      )
        throw new Error('INVALID_DESKTOP_ARTIFACT');
      const filename = `Xidden-Documentos-${version}-${artifact.target}.${artifact.target === 'win-x64' ? 'exe' : 'dmg'}`;
      if (
        filename !== artifact.filename ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 1 ||
        artifact.bytes > 1073741824
      )
        throw new Error('INVALID_DESKTOP_ARTIFACT');
      const target = path.join(directory, version, filename);
      if ((await realpath(directory)) !== directory || (await realpath(target)) !== target)
        throw new Error('INVALID_DESKTOP_PATH');
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size !== artifact.bytes) throw new Error('INVALID_DESKTOP_FILE');
      return target;
    },
  };
}
module.exports = { desktopReleaseFiles };
