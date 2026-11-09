/** @file Verifica temporales de medios Meta bajo TEMP compartido, sin bytes ni secretos en MQ. */
'use strict';
const fs                   = require('node:fs/promises');
const { constants }        = require('node:fs');
const { createHash }       = require('node:crypto');
const path                 = require('node:path');
const { ApplicationError } = require('../../shared/application-error');
const LIMIT                = 20 * 1024 * 1024;
/** Construye una frontera de archivos privados compartida con Communication y Connect.
 * @param {Object} temporaryFiles Validador canónico del Gateway.
 * @returns {Object} Validación de carga y descarga sin rutas arbitrarias.
 */
function metaFiles(temporaryFiles) {
  /** Acredita archivo regular privado, sin enlaces ni tamaños inventados.
   * @param {Object} input Referencia temporal y metadatos cerrados.
   * @returns {Promise<Object>} Referencia canónica con tamaño real.
   */
  async function validate(input) {
    const filename = await temporaryFiles.validate(input.tempFilePath);
    const stat     = await fs.lstat(input.tempFilePath);
    if (
      stat.isSymbolicLink() ||
      path.resolve(input.tempFilePath) !== filename ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > LIMIT ||
      (input.size !== undefined && input.size !== stat.size)
    )
      throw new ApplicationError(400, 'META_INVALID_MEDIA');
    return {
      tempFilePath : filename,
      name         : input.name,
      mime         : input.mime || 'application/octet-stream',
      size         : stat.size,
    };
  }
  return {
    /** @param {Object} input Foto privada del binding autoritativo. @returns {Promise<Object>} Copia de transferencia consumible por Documents; conserva el original y la identidad entre intentos. */
    async picture(input) {
      const file = await validate(input);
      if (
        file.size > 5 * 1024 * 1024 ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(file.mime) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.fileId)
      )
        throw new ApplicationError(400, 'META_INVALID_MEDIA');
      const handle = await fs.open(file.tempFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content;
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0 ||
          stat.size !== file.size
        )
          throw new ApplicationError(400, 'META_INVALID_MEDIA');
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (
        content.length !== file.size ||
        createHash('sha256').update(content).digest('hex') !== input.digest
      )
        throw new ApplicationError(400, 'META_INVALID_MEDIA');
      return {
        fileId           : input.fileId,
        tempFilePath     : await temporaryFiles.createUpload({ data: content }),
        name             : file.name,
        visibility       : 'private',
        generateVariants : true,
      };
    },
    /** @param {Object} input Archivo confinado con digest SHA256. @returns {Promise<Object>} Datos compatibles con Chat. */
    async upload(input) {
      const file   = await validate(input);
      const digest = await temporaryFiles.digest(file.tempFilePath);
      if (digest !== input.digest) throw new ApplicationError(400, 'META_INVALID_MEDIA');
      return {
        ...file,
        digest,
      };
    },
    download : validate,
    remove   : temporaryFiles.remove,
  };
}
module.exports = { metaFiles };
