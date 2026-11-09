/** @file Verifica copias de fotos Meta privadas, íntegramente confinadas y reutilizables entre intentos. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const fs                       = require('node:fs/promises');
const os                       = require('node:os');
const path                     = require('node:path');
const { createHash }           = require('node:crypto');
const { metaFiles }            = require('../server/adapters/files/meta-files');
const { createTemporaryFiles } = require('../server/adapters/files/temporary-files');
test('la copia de foto valida digest, permisos, tamaño, identidad y enlaces sin consumir el original', /** @returns {Promise<void>} Usa temporales reales y verifica limpieza de la transferencia. */ async () => {
  const root    = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meta-picture-copy-')));
  const source  = path.join(root, 'original');
  const content = Buffer.from('synthetic-image-bytes');
  const files   = metaFiles(createTemporaryFiles({ root }));
  try {
    await fs.writeFile(source, content, { mode: 0o600 });
    const picture = {
      fileId       : '11111111-1111-4111-8111-111111111111',
      tempFilePath : source,
      mime         : 'image/png',
      name         : 'perfil.png',
      size         : content.length,
      digest       : createHash('sha256').update(content).digest('hex'),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const upload = await files.picture(picture);
      assert.notEqual(upload.tempFilePath, source);
      assert.equal(upload.fileId, picture.fileId);
      assert.equal(upload.visibility, 'private');
      assert.equal(upload.generateVariants, true);
      assert.deepEqual(await fs.readFile(upload.tempFilePath), content);
      assert.equal((await fs.stat(upload.tempFilePath)).mode & 0o077, 0);
      await files.remove(upload.tempFilePath);
      assert.deepEqual(await fs.readFile(source), content);
    }
    for (const changes of [
      { digest: '0'.repeat(64) },
      { mime: 'image/svg+xml' },
      { size: 0 },
      { fileId: '../bad' },
    ])
      await assert.rejects(
        files.picture({
          ...picture,
          ...changes,
        }),
        { descriptionCode: 'META_INVALID_MEDIA' },
      );
    const linked = path.join(root, 'symlink');
    await fs.symlink(source, linked);
    await assert.rejects(
      files.picture({
        ...picture,
        tempFilePath : linked,
      }),
    );
    await fs.chmod(source, 0o644);
    await assert.rejects(files.picture(picture), { descriptionCode: 'META_INVALID_MEDIA' });
    await fs.chmod(source, 0o600);
    await fs.link(source, path.join(root, 'hardlink'));
    await assert.rejects(files.picture(picture), { descriptionCode: 'META_INVALID_MEDIA' });
  } finally {
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
