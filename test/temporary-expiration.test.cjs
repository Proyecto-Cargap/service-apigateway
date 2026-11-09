/** @file Observadores nativos: vencimientos, archivos ajenos, enlaces e inactividad sin lecturas. */
'use strict';
const test                          = require('node:test');
const assert                        = require('node:assert/strict');
const fs                            = require('node:fs/promises');
const os                            = require('node:os');
const path                          = require('node:path');
const { createTemporaryExpiration } = require('../server/adapters/files/temporary-expiration');

/** @param {number} milliseconds Plazo de prueba. @returns {Promise<void>} Espera acotada. */
function delay(milliseconds) {
  return new Promise(
    /** @param {Function} done Continuación. @returns {void} Agenda el vencimiento. */ (done) =>
      setTimeout(done, milliseconds),
  );
}
/** @param {Function} condition Estado esperado. @returns {Promise<void>} Espera eventos nativos con límite de tres segundos. */
async function until(condition) {
  const end = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() >= end) throw new Error('EXPIRATION_TIMEOUT');
    await delay(10);
  }
}

test('TEMP se limpia por cambios y vencimientos sin scans periódicos ni seguimiento de enlaces' /** @returns {Promise<void>} Usa un directorio propio y fs.watch real, incluyendo dos instancias. */, async () => {
  const root    = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-expiration-'));
  const workers = [];
  const originalRead = fs.readdir,
    originalStat     = fs.lstat;
  let reads = 0;
  /** @param {...any} args Argumentos originales. @returns {Promise<Object>} Cuenta sólo lecturas del limpiador. */
  fs.readdir = (...args) => {
    reads++;
    return originalRead(...args);
  };
  /** @param {...any} args Argumentos originales. @returns {Promise<Object>} Cuenta comprobaciones de vencimiento. */
  fs.lstat = (...args) => {
    reads++;
    return originalStat(...args);
  };
  try {
    for (let i = 0; i < 2; i++) {
      const worker = createTemporaryExpiration({
        /** @returns {Promise<string>} Raíz privada acreditada. */
        async rootDirectory() {
          return root;
        },
        /** @param {string} name Nombre controlado. @returns {boolean} Ignora archivos ajenos. */
        accepts(name) {
          return /^own-/.test(name);
        },
        retentionMs : 250,
        now         : Date.now,
        timers      : {
          setTimeout,
          clearTimeout,
        },
      });
      workers.push(worker);
      await worker.start();
    }
    const initial = reads;
    const idleMs = Number(process.env.TEMP_IDLE_MS || 300),
      started    = Date.now();
    await delay(idleMs);
    process.stdout.write(`temporary_idle_ms=${Date.now() - started}; reads=${reads - initial}\n`);
    assert.equal(reads, initial, 'en reposo no hay readdir ni lstat');
    const alien = path.join(root, 'foreign'),
      current   = path.join(root, 'own-current');
    await fs.writeFile(alien, 'preservar');
    await fs.writeFile(current, 'v1');
    await delay(100);
    await fs.appendFile(current, 'v2');
    await delay(170);
    assert.equal(await fs.readFile(current, 'utf8'), 'v1v2', 'la escritura mueve el vencimiento');
    await until(
      /** @returns {Promise<boolean>} La eliminación sucede sin otro evento ni request. */ async () => {
        try {
          await fs.access(current);
          return false;
        } catch (error) {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      },
    );
    assert.equal(await fs.readFile(alien, 'utf8'), 'preservar');
    await fs.symlink(alien, path.join(root, 'own-link'));
    await fs.link(alien, path.join(root, 'own-hard'));
    const old = new Date(Date.now() - 1000);
    await fs.utimes(alien, old, old);
    await delay(350);
    assert.equal(await fs.readFile(alien, 'utf8'), 'preservar');
    assert.equal(await fs.readFile(path.join(root, 'own-hard'), 'utf8'), 'preservar');
    assert.equal((await originalStat(path.join(root, 'own-link'))).isSymbolicLink(), true);
    const settled = reads;
    await delay(300);
    assert.equal(reads, settled, 'sin deadlines no se consulta el directorio');
    for (const worker of workers) await worker.close();
    await fs.writeFile(path.join(root, 'own-after-close'), 'cerrado');
    await delay(300);
    assert.equal(reads, settled, 'el cierre libera ambos observadores');
  } finally {
    for (const worker of workers) await worker.close();
    fs.readdir = originalRead;
    fs.lstat = originalStat;
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});

test('una discontinuidad reabre el observador y recupera archivos perdidos sin aceptar callbacks antiguos' /** @returns {Promise<void>} El directorio se reconsulta únicamente después de perder la observación. */, async () => {
  const root   = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-expiration-recovery-'));
  const opened = [];
  const worker = createTemporaryExpiration({
    /** @returns {Promise<string>} Directorio exclusivo de prueba. */ async rootDirectory() {
      return root;
    },
    /** @param {string} name Nombre. @returns {boolean} Temporal propio. */ accepts(name) {
      return name.startsWith('own-');
    },
    now         : Date.now,
    retentionMs : 20,
    timers      : {
      setTimeout,
      clearTimeout,
    },
    /** @param {string} directory Raíz. @param {Object} options Opciones. @param {Function} callback Avisos. @returns {Object} Observador controlado sin compartir recursos externos. */
    observe(directory, options, callback) {
      assert.equal(directory, root);
      const watcher = new (require('node:events').EventEmitter)();
      watcher.closed = false;
      /** @returns {void} Emite el cierre de esta generación. */
      watcher.close = () => {
        watcher.closed = true;
        watcher.emit('close');
      };
      opened.push({
        watcher,
        callback,
      });
      return watcher;
    },
  });
  try {
    await worker.start();
    opened[0].watcher.emit('error', new Error('WATCH_LOST'));
    await fs.writeFile(path.join(root, 'own-lost'), 'pendiente durante el fallo');
    await until(
      /** @returns {Promise<boolean>} La reapertura reconcilia el intervalo perdido. */ async () => {
        if (opened.length !== 2) return false;
        try {
          await fs.access(path.join(root, 'own-lost'));
          return false;
        } catch (error) {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      },
    );
    opened[0].watcher.emit('error', new Error('OLD_ERROR'));
    opened[0].callback('rename', null);
    assert.equal(opened[1].watcher.closed, false);
    await worker.close();
    assert.equal(opened[1].watcher.closed, true);
  } finally {
    await worker.close();
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
