/** @file Integración local de temporales: confinamiento, limpieza, permisos y huella del contenido. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const fs                       = require('node:fs/promises');
const os                       = require('node:os');
const path                     = require('node:path');
const { createHash }           = require('node:crypto');
const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');

test('multipart limpia sólo archivos vencidos y calcula huellas con permisos privados' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, async () => {
  const root  = await fs.mkdtemp(path.join(os.tmpdir(), 'solid-gateway-'));
  const clock = Date.now();
  const port  = createTemporaryFiles({
    root,
    /**
     * Ejecuta now y devuelve el resultado al flujo que lo invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    now : () => clock,
  });
  try {
    const directory = await port.prepareMultipart('communication-uploads');
    const expired   = path.join(directory, 'old');
    const current   = path.join(directory, 'current');
    await fs.writeFile(expired, 'old');
    await fs.writeFile(current, 'content');
    await fs.utimes(expired, new Date(clock - 172800000), new Date(clock - 172800000));
    await port.prepareMultipart('communication-uploads');
    await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
    await port.restrict(current);
    assert.equal((await fs.stat(current)).mode & 0o777, 0o600);
    assert.equal(await port.digest(current), createHash('sha256').update('content').digest('hex'));
    await assert.rejects(port.prepareMultipart('../escape'));
    await assert.rejects(port.digest(path.join(root, '..', 'unowned')));
    await fs.symlink(os.tmpdir(), path.join(root, 'redirect'));
    await assert.rejects(port.prepareMultipart('redirect'), /Invalid multipart directory/);
  } finally {
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
