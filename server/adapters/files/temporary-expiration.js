/** @file Expiración de temporales mediante observadores nativos y deadlines, sin barridos periódicos. */
'use strict';
const fs        = require('node:fs/promises');
const { watch } = require('node:fs');
const path      = require('node:path');

/** @param {Object} options Raíz acreditada, nombres propios, retención, reloj y temporizadores. @returns {Object} Recuperación inicial, observación y cierre de recursos propios. */
function createTemporaryExpiration({
  rootDirectory,
  accepts,
  retentionMs,
  now,
  logger,
  timers,
  observe = watch,
}) {
  const deadlines = new Map();
  const pending   = new Set();
  let root,
    watcher,
    timer,
    running = false,
    task,
    recover = false,
    retryAt;

  /** @returns {void} Informa un fallo sin nombres de archivos ni datos del usuario. */
  function failed() {
    logger?.error?.({
      component : 'temporary_files',
      event     : 'upload_cleanup_deferred',
      code      : 'UPLOAD_CLEANUP_PENDING',
    });
  }
  /** @param {string} name Nombre propio dentro de TEMP. @returns {Promise<number>} Comprueba identidad y vencimiento antes de desvincular; nunca sigue enlaces. */
  async function inspect(name) {
    const location = path.join(root, name);
    try {
      const stat = await fs.lstat(location);
      if (!stat.isFile() || stat.nlink !== 1) {
        deadlines.delete(name);
        return 0;
      }
      const expiresAt = stat.mtimeMs + retentionMs;
      if (expiresAt > now()) {
        deadlines.set(name, expiresAt);
        return 0;
      }
      const current = await fs.lstat(location);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.mtimeMs !== stat.mtimeMs
      ) {
        pending.add(name);
        return 0;
      }
      await fs.unlink(location);
      deadlines.delete(name);
      return 1;
    } catch (error) {
      if (error.code === 'ENOENT') {
        deadlines.delete(name);
        return 0;
      }
      throw error;
    }
  }
  /** @returns {void} Programa exclusivamente el vencimiento más cercano o un reintento fallido. */
  function arm() {
    if (timer) timers.clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    let deadline = retryAt;
    if (retryAt === undefined && (recover || pending.size)) deadline = now();
    if (retryAt === undefined)
      for (const value of deadlines.values())
        deadline = deadline === undefined ? value : Math.min(deadline, value);
    if (deadline === undefined) return;
    timer = timers.setTimeout(
      /** @returns {void} El trabajo se ejecuta sólo por un vencimiento ya registrado. */
      () => {
        timer = undefined;
        retryAt = undefined;
        void drain();
      },
      Math.max(0, Math.min(2147483647, deadline - now())),
    );
    timer.unref?.();
  }
  /** @param {Object} candidate Observador perdido. @returns {void} Una generación anterior nunca cierra el observador nuevo. */
  function lost(candidate) {
    if (!running || watcher !== candidate) return;
    watcher = undefined;
    candidate.close();
    recover = true;
    retryAt = now() + 1000;
    failed();
    arm();
  }
  /** @returns {void} Abre el observador antes de reconciliar, para conservar cambios durante la lectura. */
  function open() {
    if (watcher || !running) return;
    const candidate = observe(
      root,
      { persistent: false },
      /** @param {string} event Evento del sistema operativo. @param {string|Buffer|null} filename Archivo o pérdida de detalle. @returns {void} Coalesce cambios de nombres propios con cola acotada. */
      (event, filename) => {
        if (!running || watcher !== candidate) return;
        const name = filename?.toString();
        if (!name) recover = true;
        else if (accepts(name)) {
          if (pending.size >= 4096) {
            pending.clear();
            recover = true;
          } else pending.add(name);
        } else return;
        if (!task && retryAt === undefined) void drain();
      },
    );
    watcher = candidate;
    candidate.on(
      'error',
      /** @returns {void} Una pérdida del observador requiere reabrirlo y reconciliar, sin fallback a sondeo. */
      () => lost(candidate),
    );
    candidate.on(
      'close',
      /** @returns {void} Recupera también el cierre espontáneo del observador nativo. */
      () => lost(candidate),
    );
  }
  /** @returns {Promise<number>} Recuperación explícita del directorio; sólo arranque o discontinuidad la requieren. */
  async function scan() {
    let deleted = 0;
    const names = new Set((await fs.readdir(root)).filter(accepts));
    for (const name of deadlines.keys()) if (!names.has(name)) deadlines.delete(name);
    for (const name of names) deleted += await inspect(name);
    return deleted;
  }
  /** @returns {Promise<void>} Serializa eventos y vencimientos; una caída programa un reintento concreto. */
  function drain() {
    if (!running || task) return task;
    task = (
      /** @returns {Promise<void>} Atiende un lote sin perder eventos que llegan durante una lectura. */
      async () => {
        open();
        if (recover) {
          recover = false;
          try {
            await scan();
          } catch (error) {
            recover = true;
            throw error;
          }
        }
        for (const [name, deadline] of deadlines) if (deadline <= now()) pending.add(name);
        const batch = [...pending];
        pending.clear();
        for (const name of batch) {
          if (!running) break;
          try {
            await inspect(name);
          } catch (error) {
            pending.add(name);
            throw error;
          }
        }
      }
    )()
      .catch(
        /** @returns {void} Conserva los pendientes y el fallo sin generar rechazos huérfanos. */
        () => {
          retryAt = now() + 1000;
          failed();
        },
      )
      .finally(
        /** @returns {void} Una señal pendiente o deadline arma la siguiente ejecución. */
        () => {
          task = undefined;
          arm();
        },
      );
    return task;
  }
  return {
    /** @returns {Promise<Object>} Consulta explícita de mantenimiento; no inicia un temporizador periódico. */
    async cleanup() {
      root ||= await rootDirectory();
      if (task) await task;
      const deletedCount = await scan();
      arm();
      return { deletedCount };
    },
    /** @returns {Promise<void>} Establece observación y reconcilia una vez al arrancar. */
    async start() {
      if (running) return task;
      root = await rootDirectory();
      running = true;
      recover = true;
      await drain();
    },
    /** @returns {Promise<void>} No deja observadores ni temporizadores después del cierre. */
    async close() {
      running = false;
      watcher?.close();
      watcher = undefined;
      if (timer) timers.clearTimeout(timer);
      timer = undefined;
      await task;
      pending.clear();
      deadlines.clear();
      retryAt = undefined;
    },
  };
}
module.exports = { createTemporaryExpiration };
