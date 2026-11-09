/** @file Verifica altas Meta con nombres resueltos, recuperación concurrente y conservación de contactos existentes. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  metaPlatformService,
} = require('../server/modules/meta-bridge/services/meta-platform.service');
/** @param {Object} files Puerto de fotos opcional para casos sin imagen. @returns {Object} Puente real y respuestas canónicas controlables sin red ni base externa. */
function fixture(files) {
  const binding = {
    workspaceCode      : 'w',
    ownerUserCode      : 'owner',
    contactCode        : 'META-fixture',
    externalUserCode   : 'META-fixture',
    externalGroupCodes : [],
    contactRoleCode    : 'customer',
    externalId         : '123456789',
    displayName        : 'Juan Pablo Lemus García',
    contactName        : {
      firstName        : 'Juan Pablo',
      lastNamePaternal : 'Lemus',
      lastNameMaternal : 'García',
    },
  };
  const state   = {
    contact           : null,
    calls             : [],
    conflict          : false,
    unavailable       : false,
    createUnavailable : false,
  };
  const service = metaPlatformService({
    files,
    messaging : {
      /** @param {string} target Servicio. @param {string} action Contrato. @param {Object} data Solicitud. @param {Object} options Contexto acreditado. @returns {Promise<Object>} Respuestas de ausencia, creación y conflicto distinguibles. */
      async request(target, action, data, options) {
        state.calls.push({
          target,
          action,
          data,
        });
        if (action === 'meta-conversation-binding-get')
          return {
            statusCode : 200,
            data       : binding,
          };
        if (action === 'workspace-principals-get-list')
          return {
            statusCode : 200,
            data       : {
              items : [
                {
                  userCode : 'owner',
                  policies : ['connect.meta.update.global'],
                },
              ],
            },
          };
        if (target === 'service-directory') {
          assert.equal(options.context.workspace, 'w');
          assert.equal(options.context.user.userCode, 'owner');
        }
        if (action === 'contact-get-one')
          return state.unavailable
            ? {
                statusCode      : 503,
                descriptionCode : 'DIRECTORY_UNAVAILABLE',
              }
            : state.contact
              ? {
                  statusCode : 200,
                  data       : structuredClone(state.contact),
                }
              : { statusCode: 404 };
        if (action === 'contact-create') {
          if (state.rejectPicture) {
            state.rejectPicture = false;
            return {
              statusCode      : 409,
              descriptionCode : 'FILE_NOT_READY',
            };
          }
          if (state.createUnavailable) {
            state.createUnavailable = false;
            return {
              statusCode      : 503,
              descriptionCode : 'STORAGE_WRITE_UNCERTAIN',
            };
          }
          state.contact = {
            ...structuredClone(data),
            userCode : data.contactCode,
            code     : 'CON0000006',
          };
          if (state.conflict) {
            state.contact.name = {
              firstName        : 'Nombre editado durante otra alta',
              lastNamePaternal : '',
              lastNameMaternal : '',
            };
            return { statusCode: 409 };
          }
          return {
            statusCode : 200,
            data       : structuredClone(state.contact),
          };
        }
        if (action === 'external-principal-provision')
          return {
            statusCode : 200,
            data       : {
              userCode    : data.contactCode,
              contactCode : data.contactCode,
            },
          };
        throw Error('UNEXPECTED_ACTION');
      },
    },
  });
  /** @returns {Promise<Object>} La operación pública privada sólo admite el origen Connect. */
  async function provision() {
    return service.execute(
      {
        operation        : 'provision',
        conversationCode : 'conversation',
        data             : {},
      },
      'service-connect',
    );
  }
  return {
    binding,
    state,
    provision,
  };
}

test('alta Meta usa las tres partes del binding y reintentos no sobrescriben una edición manual', /** @returns {Promise<void>} ID, código, rol y ámbito permanecen estables. */ async () => {
  const f = fixture();
  await f.provision();
  assert.deepEqual(f.state.contact.name, f.binding.contactName);
  assert.equal(f.state.contact.code, 'CON0000006');
  assert.equal(
    Object.hasOwn(
      f.state.calls.find(
        /** @param {Object} call Solicitud registrada. @returns {boolean} Alta canónica. */ (
          call,
        ) => call.action === 'contact-create',
      ).data,
      'code',
    ),
    false,
  );
  assert.equal(f.state.contact.roleCode, 'customer');
  const manual = {
    firstName        : 'Nombre corregido',
    lastNamePaternal : 'Paterno corregido',
    lastNameMaternal : 'Materno corregido',
  };
  f.state.contact.name = manual;
  f.binding.contactName = null;
  await f.provision();
  assert.deepEqual(f.state.contact.name, manual);
  assert.equal(
    f.state.calls.filter(
      /** @param {Object} call Operación registrada. @returns {boolean} Alta de contacto. */ (
        call,
      ) => call.action === 'contact-create',
    ).length,
    1,
  );
  assert(
    !f.state.calls.some(
      /** @param {Object} call Operación registrada. @returns {boolean} Una actualización no está autorizada. */ (
        call,
      ) => call.action === 'contact-update',
    ),
  );
});

test('alta concurrente conserva el contacto ganador y nunca reemplaza su nombre', /** @returns {Promise<void>} El conflicto se recupera leyendo la identidad existente. */ async () => {
  const f = fixture();
  f.state.conflict = true;
  await f.provision();
  assert.equal(f.state.contact.name.firstName, 'Nombre editado durante otra alta');
  assert.deepEqual(
    f.state.calls.map(
      /** @param {Object} call Operación. @returns {string} Contrato invocado. */ (call) =>
        call.action,
    ),
    [
      'meta-conversation-binding-get',
      'workspace-principals-get-list',
      'contact-get-one',
      'contact-create',
      'contact-get-one',
      'external-principal-provision',
    ],
  );
});

test('sin resolución o con Directory no disponible no crea contactos con IDs ni confunde fallo con ausencia', /** @returns {Promise<void>} El trabajador debe persistir el nombre antes de solicitar un alta. */ async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    f.binding.contactName = null;
    f.state.unavailable = unavailable;
    await assert.rejects(f.provision(), {
      descriptionCode : unavailable ? 'DIRECTORY_UNAVAILABLE' : 'META_CONTACT_NAME_PENDING',
    });
    assert.equal(f.state.contact, null);
    assert(
      !f.state.calls.some(
        /** @param {Object} call Operación. @returns {boolean} Efecto indebido. */ (call) =>
          ['contact-create', 'external-principal-provision'].includes(call.action),
      ),
    );
  }
});

test('foto sólo durante el alta: misma identidad en reintentos y sin cambios a contactos existentes', /** @returns {Promise<void>} El temporal de recuperación no se transfiere directamente a Documents. */ async () => {
  const copies = [],
    removed    = [];
  const f = fixture({
    /** @param {Object} picture Foto del binding. @returns {Promise<Object>} Copia consumible con identidad estable. */
    async picture(picture) {
      const upload = {
        fileId           : picture.fileId,
        tempFilePath     : `/tmp/copy-${copies.length}`,
        name             : picture.name,
        visibility       : 'private',
        generateVariants : true,
      };
      copies.push(upload);
      return upload;
    },
    /** @param {string} filename Copia terminada. @returns {Promise<void>} Captura la limpieza. */
    async remove(filename) {
      removed.push(filename);
    },
  });
  f.binding.contactPicture = {
    fileId       : '11111111-1111-4111-8111-111111111111',
    name         : 'perfil.png',
    tempFilePath : '/tmp/recovery',
  };
  f.state.createUnavailable = true;
  await assert.rejects(f.provision(), { descriptionCode: 'STORAGE_WRITE_UNCERTAIN' });
  assert.deepEqual(removed, []);
  await f.provision();
  assert.equal(copies.length, 2);
  assert.equal(copies[0].fileId, copies[1].fileId);
  assert.notEqual(copies[0].tempFilePath, copies[1].tempFilePath);
  assert.deepEqual(removed, [copies[1].tempFilePath]);
  f.state.contact.picture = 'manual-photo';
  f.binding.contactPicture.fileId = '22222222-2222-4222-8222-222222222222';
  await f.provision();
  assert.equal(copies.length, 2);
  assert.equal(f.state.contact.picture, 'manual-photo');
});

test('foto retirada sólo permite respaldo tras confirmar ausencia del contacto', /** @returns {Promise<void>} No confunde errores de Directory con ausencia ni cambia contactos ganadores. */ async () => {
  const f = fixture({
    /** @returns {Promise<Object>} Carga ya retirada del almacenamiento. */
    async picture() {
      return {
        fileId           : '11111111-1111-4111-8111-111111111111',
        tempFilePath     : '/tmp/copy',
        name             : 'perfil.png',
        visibility       : 'private',
        generateVariants : true,
      };
    },
    /** @returns {Promise<void>} Limpieza consumible simulada. */
    async remove() {},
  });
  f.binding.contactPicture = { fileId: '11111111-1111-4111-8111-111111111111' };
  f.state.rejectPicture = true;
  await assert.rejects(f.provision(), { descriptionCode: 'META_CONTACT_PICTURE_REJECTED' });
  assert.equal(f.state.contact, null);
  f.binding.contactPicture = null;
  await f.provision();
  assert.deepEqual(f.state.contact.name, f.binding.contactName);
  assert.equal(f.state.contact.pictureUpload, undefined);
});
