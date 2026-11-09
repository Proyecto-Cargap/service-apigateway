/** @file Archivos temporales confinados a TEMP; crea nombres aleatorios y limpia solo archivos acreditados. */
'use strict';
const fs                         = require('node:fs/promises');
const path                       = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createReadStream }       = require('node:fs');
const UPLOAD_PREFIX              = 'gateway-upload-v1-';
const UPLOAD_NAME                =
  /^gateway-upload-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPLOAD_TTL_MS              = 60 * 60 * 1000;
/**
 * Compone createTemporaryFiles con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: root, now, logger, timers.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createTemporaryFiles({
  root : configuredRoot,
  now = Date.now,
  logger,
  timers = {
    setTimeout,
    clearTimeout,
  },
}) {
  const expiration = require('./temporary-expiration').createTemporaryExpiration({
    rootDirectory,
    /** @param {string} name Nombre de archivo. @returns {boolean} Sólo las cargas propias del Gateway. */
    accepts     : (name) => UPLOAD_NAME.test(name),
    retentionMs : UPLOAD_TTL_MS,
    now,
    logger,
    timers,
  });
  /**
   * Ejecuta rootDirectory dentro del flujo de temporary-files.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function rootDirectory() {
    if (!configuredRoot) throw new Error('Temporary directory unavailable');
    return fs.realpath(configuredRoot);
  }
  /**
   * Valida la entrada antes de continuar con la operación.
   * @param {*} file Valor de file utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function validate(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file))
      throw new Error('Invalid temporary file');
    const root      = await rootDirectory();
    const canonical = await fs.realpath(file);
    const relative  = path.relative(root, canonical);
    if (
      !relative ||
      relative.startsWith('..' + path.sep) ||
      relative === '..' ||
      path.isAbsolute(relative)
    )
      throw new Error('Invalid temporary file');
    if (!(await fs.stat(canonical)).isFile()) throw new Error('Invalid temporary file');
    return canonical;
  }
  /** Huella privada estable; sólo se calcula después de autorizar y validar el archivo.
   * @param {*} file Valor de file utilizado por esta operación.
   * @param {*} resourceIdentity Valor de resourceIdentity utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function etag(file, resourceIdentity) {
    const canonical = await validate(file);
    const hash      = createHash('sha256').update(JSON.stringify(resourceIdentity));
    for await (const chunk of createReadStream(canonical)) hash.update(chunk);
    return '"' + hash.digest('hex') + '"';
  }
  /**
   * Compone createUpload con las dependencias recibidas y devuelve su interfaz.
   * @param {*} file Valor de file utilizado por esta operación.
   * @param {Object} [options] Colaboradores u opciones: allowEmpty.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function createUpload(file, { allowEmpty = false } = {}) {
    if (
      !file ||
      Array.isArray(file) ||
      !Buffer.isBuffer(file.data) ||
      file.truncated ||
      (!file.data.length && allowEmpty !== true) ||
      file.data.length > 200 * 1024 * 1024
    ) {
      throw Object.assign(new Error('Invalid upload'), { statusCode: 400 });
    }
    const location = path.join(await rootDirectory(), UPLOAD_PREFIX + randomUUID());
    await fs.writeFile(location, file.data, {
      flag : 'wx',
      mode : 0o600,
    });
    return location;
  }
  /**
   * Retira el recurso indicado.
   * @param {*} file Valor de file utilizado por esta operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function remove(file) {
    try {
      await fs.unlink(await validate(file));
    } catch {
      /* El archivo puede haber sido consumido por Documents. */
    }
  }
  /** Prepara una carpeta multipart confinada y limpia archivos inactivos según su antigüedad.
   * @param {string} folder Nombre interno de carpeta, sin segmentos de rutas.
   * @param {number} [maxAgeMs] Antigüedad mínima para retirar temporales abandonados.
   * @returns {Promise<string>} Directorio privado para el analizador multipart.
   */
  async function prepareMultipart(folder, maxAgeMs = 86400000) {
    if (typeof folder !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(folder))
      throw new Error('Invalid multipart folder');
    const root      = await rootDirectory();
    const directory = path.join(root, folder);
    await fs.mkdir(directory, {
      recursive : true,
      mode      : 0o700,
    });
    if ((await fs.realpath(directory)) !== directory)
      throw new Error('Invalid multipart directory');
    for (const entry of await fs.readdir(directory)) {
      const filename = path.join(directory, entry);
      const stat     = await fs.lstat(filename).catch(
        /**
         * Aplica la operación local y devuelve su resultado al flujo que la invoca.
         * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
         */
        () => null,
      );
      if (stat?.isFile() && stat.mtimeMs < now() - maxAgeMs) await remove(filename);
    }
    return directory;
  }
  /** Restringe permisos de un temporal acreditado antes de transferirlo al servicio destino.
   * @param {string} file Temporal que debe permanecer confinado a la raíz configurada.
   * @returns {Promise<void>} Confirma la aplicación de permisos privados.
   */
  async function restrict(file) {
    await fs.chmod(await validate(file), 0o600);
  }
  /** Calcula SHA-256 mediante streaming y sin cargar el archivo completo en memoria.
   * @param {string} file Temporal privado previamente autorizado por el controlador.
   * @returns {Promise<string>} Huella hexadecimal del contenido acreditado.
   */
  async function digest(file) {
    const hash = createHash('sha256');
    for await (const part of createReadStream(await validate(file))) hash.update(part);
    return hash.digest('hex');
  }
  /** @param {AsyncIterable<Buffer>} source Flujo binario. @param {Object} expected Tamaño y SHA-256 autorizados. @returns {Promise<string>} Temporal privado verificado y acotado. */
  async function createStream(source, expected) {
    if (
      !Number.isSafeInteger(expected.byteLength) ||
      expected.byteLength < 0 ||
      expected.byteLength > 200 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw Object.assign(new Error('Invalid transfer'), {
        statusCode      : 400,
        descriptionCode : 'MCP_TRANSFER_INVALID',
      });
    const location = path.join(await rootDirectory(), UPLOAD_PREFIX + randomUUID());
    const file = await fs.open(location, 'wx', 0o600),
      hash     = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > expected.byteLength)
          throw Object.assign(new Error('Transfer too large'), {
            statusCode      : 413,
            descriptionCode : 'MCP_TRANSFER_TOO_LARGE',
          });
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (size !== expected.byteLength || hash.digest('hex') !== expected.sha256)
        throw Object.assign(new Error('Transfer mismatch'), {
          statusCode      : 400,
          descriptionCode : 'MCP_TRANSFER_CONTENT_MISMATCH',
        });
      await file.close();
      return location;
    } catch (error) {
      await file.close();
      await fs.unlink(location);
      throw error;
    }
  }
  return {
    createStream,
    prepareMultipart,
    restrict,
    digest,
    validate,
    etag,
    createUpload,
    remove,
    cleanupExpiredUploads : expiration.cleanup,
    start                 : expiration.start,
    close                 : expiration.close,
  };
}
module.exports = { createTemporaryFiles };
