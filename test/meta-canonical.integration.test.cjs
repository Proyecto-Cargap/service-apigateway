/** @file Aceptación local entre dominios canónicos: contacto, identidad, chat y admisión IA con Mongo real y transporte en memoria. */
'use strict';
const test                  = require('node:test');
const assert                = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID }        = require('node:crypto');
const fs                    = require('node:fs/promises');
const os                    = require('node:os');
const path                  = require('node:path');
const { Readable }          = require('node:stream');
test(
  'el puente Meta reutiliza Directory/Security/Chat/Intelligence reales y conserva audiencia externa',
  {
    skip    : !process.env.TEST_META_CANONICAL || !process.env.TEST_META_MONGO_URI,
    timeout : 60000,
  },
  /** @returns {Promise<void>} No usa AMQP, proveedores IA ni Meta; persiste únicamente en base aleatoria local. */
  async () => {
    const { Mongoose } = require('mongoose');
    const mongoose     = new Mongoose();
    mongoose.set('transactionAsyncLocalStorage', true);
    assert.match(process.env.TEST_META_MONGO_URI, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(process.env.TEST_META_MONGO_URI, {
      dbName    : 'meta_canonical_test_' + randomUUID().replaceAll('-', ''),
      autoIndex : false,
    });
    const tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'meta-canonical-pictures-')),
    );
    const handlers = {},
      manifests    = {},
      context      = new AsyncLocalStorage(),
      emitted      = [];
    /** @param {string} source Servicio emisor. @returns {Object} Transporte local con sobre/DTO/origen/contexto reales. */
    function transport(source) {
      return {
        /** @returns {Object} Contexto de esta llamada, aislado de otras promesas. */
        getContext() {
          return context.getStore() || {};
        },
        /** @param {Object} value Contexto verificado. @param {Function} callback Caso de uso. @returns {Promise<Object>} Resultado contextual. */
        runWithContext(value, callback) {
          return context.run(value, callback);
        },
        /** @param {number} statusCode Estado canónico. @param {Object} data Resultado. @returns {Object} Sobre RPC vigente. */
        successResponse(statusCode, data) {
          return {
            statusCode,
            descriptionCode : 'OK',
            data,
          };
        },
        /** @param {Function} callback Operación transaccional. @returns {Promise<Object>} Transacción Mongo real. */
        transaction(callback) {
          return mongoose.connection.transaction(callback);
        },
        /** @param {string} action Evento de dominio. @param {Object} data Contenido. @returns {Promise<void>} Captura la publicación sin red externa. */
        async publishEvent(action, data) {
          emitted.push({
            action,
            data,
          });
        },
        /** @returns {Promise<void>} Omite sólo notificaciones de UI y correo de esta prueba aislada. */
        async sendCommand() {},
        /** @param {string} target Servicio destino. @param {string} action Contrato público. @param {Object} data DTO. @param {Object} options Contexto opcional. @returns {Promise<Object>} Controlador real con validación de entrada y salida. */
        async request(target, action, data, options = {}) {
          const handler = handlers[target]?.[action];
          assert(handler, `Ruta canónica ausente: ${target}/${action}`);
          const dto = manifests[target]?.actionDtos[action];
          return context.run(
            options.context === undefined ? context.getStore() || {} : options.context,
            /** @returns {Promise<Object>} Invoca el dominio y convierte únicamente errores públicos al sobre. */
            async () => {
              try {
                const result = await handler({
                  data          : dto ? dto.input(data) : data,
                  originService : source,
                });
                if (!dto) return result;
                try {
                  return dto.output(result);
                } catch (error) {
                  assert.fail(
                    `Respuesta inválida de ${target}/${action}: ${error.descriptionCode}; campos=${Object.keys(result.data || {}).join(',')}`,
                  );
                }
              } catch (error) {
                if (!error.statusCode) throw error;
                return {
                  statusCode      : error.statusCode,
                  descriptionCode : error.descriptionCode,
                };
              }
            },
          );
        },
      };
    }
    try {
      const security  = transport('service-security'),
        directory     = transport('service-directory'),
        communication = transport('service-communication'),
        intelligence  = transport('service-intelligence'),
        gateway       = transport('service-apigateway'),
        documents     = transport('service-documents');
      manifests['service-security'] = require('../../service-security/server/contracts');
      manifests['service-directory'] = require('../../service-directory/server/contracts');
      manifests['service-communication'] = require('../../service-communication/server/contracts');
      manifests['service-intelligence'] = require('../../service-intelligence/server/contracts');
      manifests['service-apigateway'] = require('../server/contracts');
      manifests['service-documents'] = require('../../service-documents/server/contracts');
      const userModel      = mongoose.model(
        'SECURITY_USER',
        require('../../service-security/server/modules/user/models/user.model').schema.clone(),
        'SECURITY_USER',
      );
      const sessionModel   = mongoose.model(
        'SECURITY_SESSION',
        require('../../service-security/server/modules/session/models/session.model').schema.clone(),
        'SECURITY_SESSION',
      );
      const groupModel     = mongoose.model(
        'SECURITY_GROUP',
        require('../../service-security/server/modules/group/models/group.model').schema.clone(),
        'SECURITY_GROUP',
      );
      const policyModel    = mongoose.model(
        'SECURITY_POLICY',
        require('../../service-security/server/modules/policy/models/policy.model').schema.clone(),
        'SECURITY_POLICY',
      );
      const workspaceModel = mongoose.model(
        'SECURITY_WORKSPACES',
        require('../../service-security/server/modules/workspaces/models/workspaces.model').schema.clone(),
        'SECURITY_WORKSPACES',
      );
      const contactModel   = mongoose.model(
        'DIRECTORY_CONTACT',
        require('../../service-directory/server/modules/contact/models/contact.model').schema.clone(),
        'DIRECTORY_CONTACT',
      );
      const filesModel     = require('../../service-documents/server/modules/files/models/files.model')(
        { mongoose },
      );
      const roleModel      = mongoose.model(
        'DIRECTORY_ROLE',
        require('../../service-directory/server/modules/role/models/role.model').schema.clone(),
        'DIRECTORY_ROLE',
      );
      const chatModels     = {
        conversations :
          require('../../service-communication/server/modules/chat/models/chat-conversation.model')(
            { mongoose },
          ),
        messages      :
          require('../../service-communication/server/modules/chat/models/chat-message.model')({
            mongoose,
          }),
        attachments   :
          require('../../service-communication/server/modules/chat/models/chat-attachment.model')({
            mongoose,
          }),
      };
      const runModel       = require('../../service-intelligence/server/modules/run/models/run.model')({
        mongoose,
      });
      const agentModel     =
        require('../../service-intelligence/server/modules/agent/models/agent.model')({ mongoose });
      const admissionModel = mongoose.model(
        'APIGATEWAY_META_RUN',
        require('../server/modules/meta-bridge/models/meta-run.model').schema.clone(),
        'APIGATEWAY_META_RUN',
      );
      for (const model of [
        userModel,
        sessionModel,
        groupModel,
        policyModel,
        workspaceModel,
        contactModel,
        filesModel,
        roleModel,
        ...Object.values(chatModels),
        runModel,
        agentModel,
        admissionModel,
      ]) {
        await model.createCollection();
        await model.createIndexes();
      }
      const repositories = {
        user       : require('../../service-security/server/modules/user/repositories/user.repository')({
          model     : userModel,
          messaging : security,
        }),
        session    :
          require('../../service-security/server/modules/session/repositories/session.repository')({
            model     : sessionModel,
            messaging : security,
          }),
        group      : require('../../service-security/server/modules/group/repositories/group.repository')(
          {
            model     : groupModel,
            userModel,
            messaging : security,
          },
        ),
        policy     :
          require('../../service-security/server/modules/policy/repositories/policy.repository')({
            model     : policyModel,
            groupModel,
            messaging : security,
          }),
        workspaces :
          require('../../service-security/server/modules/workspaces/repositories/workspaces.repository')(
            {
              model     : workspaceModel,
              userModel,
              sessionModel,
              groupModel,
              policyModel,
              messaging : security,
            },
          ),
      };
      const metadata     = {
        workspace    : 'w',
        userCreate   : 'owner',
        userAssigned : '',
        erased       : false,
      };
      const permissions  = [
        'connect.meta.update.global',
        'directory.contact.create.workspace',
        'directory.contact.view.workspace',
        'communication.chat.create.workspace',
        'communication.chat.view.workspace',
        'security.user.update.global',
        'intelligence.agent.view.workspace',
      ];
      for (let i = 0; i < permissions.length; i++)
        await policyModel.create({
          ...metadata,
          policyCode  : `p${i}`,
          identifier  : permissions[i],
          description : permissions[i],
          active      : true,
        });
      await groupModel.create({
        ...metadata,
        groupCode : 'admin',
        name      : 'Admin',
        policies  : permissions.map(
          /** @param {string} value Identificador. @param {number} index Índice del fixture. @returns {string} Código de política. */
          (value, index) => `p${index}`,
        ),
      });
      await groupModel.create({
        ...metadata,
        groupCode : 'external-profile',
        name      : 'External',
        policies  : ['p5'],
      });
      await groupModel.create({
        ...metadata,
        groupCode : 'agent-profile',
        name      : 'Agent',
        policies  : ['p3', 'p4'],
      });
      await workspaceModel.create({
        ...metadata,
        workspaceCode : 'w',
        name          : 'Workspace',
      });
      await roleModel.create({
        ...metadata,
        roleCode : 'customer',
        name     : 'Cliente',
      });
      await userModel.create({
        ...metadata,
        userCode    : 'owner',
        user        : 'owner@example.test',
        contactCode : 'owner',
        groups      : ['admin'],
        workspaces  : ['w'],
        state       : 'active',
        validity    : Date.now() + 86400000,
      });
      await contactModel.create({
        ...metadata,
        contactCode : 'owner',
        userCode    : 'owner',
        code        : 'owner',
        workspaces  : ['w'],
        roleCode    : 'customer',
        name        : {
          firstName        : 'Operador',
          lastNamePaternal : '',
          lastNameMaternal : '',
        },
      });
      const directoryChanges =
        require('../../service-directory/server/modules/directory/services/record-changes.service').recordChanges(
          {
            transaction : directory.transaction,
            publish     : directory.publishEvent,
          },
        );
      const contacts         =
        require('../../service-directory/server/modules/contact/repositories/contact.repository')({
          model     : contactModel,
          messaging : directory,
          change    : directoryChanges.for('contact'),
        });
      const roles            =
        require('../../service-directory/server/modules/role/repositories/role.repository')({
          model     : roleModel,
          messaging : directory,
          change    : directoryChanges.for('role'),
        });
      const objects          = new Map();
      const storageState     = {
        failOnce          : true,
        quotaReservations : 0,
      };
      const storageService   =
        require('../../service-documents/server/modules/files/services/files-storage.service')({
          repository         :
            require('../../service-documents/server/modules/files/repositories/files-storage.repository')(
              { model: filesModel },
            ),
          messaging          : documents,
          env                : { BUCKET: 'isolated-test' },
          temporaryFiles     :
            require('../../service-documents/server/adapters/filesystem/temporary-files').createTemporaryFiles(
              { root: tempRoot },
            ),
          imageProcessor     :
            require('../../service-documents/server/adapters/media/image-processor').imageProcessor(
              require('../../service-documents/node_modules/sharp'),
            ),
          settingsRepository : {
            /** @returns {Promise<void>} Cuenta reservas de cuota sin modificar ajustes reales. */
            async adjustUsedSpace() {
              storageState.quotaReservations++;
            },
          },
          storage            : {
            /** @param {Object} input Objeto simulado de S3. @returns {Promise<void>} Escribe bytes reales e inyecta una respuesta perdida tras el primer efecto. */
            async put(input) {
              const parts = [];
              if (Buffer.isBuffer(input.content)) parts.push(input.content);
              else for await (const part of input.content) parts.push(part);
              objects.set(input.key, Buffer.concat(parts));
              if (storageState.failOnce) {
                storageState.failOnce = false;
                throw new Error('SIMULATED_RESPONSE_LOST');
              }
            },
            /** @param {Object} input Objeto registrado. @returns {Promise<Object>} Stream del contenido persistido en memoria. */
            async read(input) {
              return { content: Readable.from([objects.get(input.key)]) };
            },
            /** @param {Object} input Objeto propio. @returns {Promise<void>} Retira sólo la clave de esta prueba. */
            async delete(input) {
              objects.delete(input.key);
            },
          },
        });
      handlers['service-documents'] = {
        /** @param {Object} message Solicitud Directory con DTO real. @returns {Promise<Object>} Respuesta del almacenamiento canónico. */
        async 'files-storage-upload'(message) {
          return documents.successResponse(
            200,
            await storageService.upload(message.data, message.originService),
          );
        },
        /** @param {Object} message Recurso acreditado. @returns {Promise<Object>} Lectura canónica de una variante. */
        async 'files-storage-read'(message) {
          return documents.successResponse(
            200,
            await storageService.read(message.data, message.originService),
          );
        },
        /** @param {Object} message Recurso propio. @returns {Promise<Object>} Limpieza canónica. */
        async 'files-storage-delete'(message) {
          return documents.successResponse(
            200,
            await storageService.remove(message.data, message.originService),
          );
        },
      };
      const contactPictures       =
        require('../../service-directory/server/adapters/documents/contact-pictures')({
          messaging : directory,
          logger    : { /** @returns {void} Omite sólo salida del fixture. */ error() {} },
        });
      const directoryDependencies = {
        messaging    : directory,
        repositories : { contact: contacts },
        readers      : { role: roles },
        services     : {
          contact : require('../../service-directory/server/modules/contact/services/contact.service'),
        },
        pictures     : contactPictures,
        counter      :
          require('../../service-directory/server/modules/counters/repositories/counters.repository')(
            {
              model : mongoose.model(
                'DIRECTORY_COUNTER',
                require('../../service-directory/server/modules/counters/models/counters.model').schema.clone(),
                'DIRECTORY_COUNTER',
              ),
            },
          ),
      };
      const contactController     =
        require('../../service-directory/server/modules/contact/controllers/contact.controller')(
          directoryDependencies,
        );
      const profileController     =
        require('../../service-directory/server/modules/contact/controllers/contact-profile.controller').contactProfileController(
          {
            contacts,
            messaging : directory,
          },
        );
      handlers['service-directory'] = {
        'contact-create'           : contactController.create,
        'contact-get-one'          : contactController.getOne,
        'contact-profile-get-list' : profileController.list,
      };
      const agentIdentity        =
        require('../../service-security/server/modules/agent-principal/services/agent-principal.service')(
          {
            repositories,
            messaging         : security,
            jwt               : require('../../service-security/node_modules/jsonwebtoken'),
            tokenSecret       : 'test-secret-only-not-production',
            tokenContexts     : {
              agent_execution : {
                issuer   : 'fixture-security',
                audience : 'fixture-agent',
              },
            },
            tokenCryptography : require('../../service-security/server/adapters/security/token-cryptography'),
          },
        );
      const identityDependencies = {
        authorization     :
          require('../../service-security/server/modules/identity/repositories/identity-authorization.repository').identityAuthorizationRepository(
            {
              session   : sessionModel,
              user      : userModel,
              workspace : workspaceModel,
              messaging : security,
            },
          ),
        messaging         : security,
        users             : repositories.user,
        sessions          : repositories.session,
        groups            : repositories.group,
        policies          : repositories.policy,
        workspaces        : repositories.workspaces,
        authenticateAgent : agentIdentity.authenticate,
      };
      const identityController   =
        require('../../service-security/server/modules/identity/controllers/identity.controller').identityController(
          identityDependencies,
        );
      const externalController   =
        require('../../service-security/server/modules/external-principal/compositions/external-principal.composition').externalPrincipalComposition(
          {
            repositories,
            messaging         : security,
            tokenCryptography : require('../../service-security/server/adapters/security/token-cryptography'),
          },
        );
      const agentController      =
        require('../../service-security/server/modules/agent-principal/controllers/agent-principal.controller')(
          {
            messaging      : security,
            agentPrincipal : agentIdentity,
          },
        );
      handlers['service-security'] = {
        'workspace-principals-get-list' : identityController.principals,
        'identity-get-current'          : identityController.current,
        'user-references-get-list'      : identityController.references,
        'user-profiles-get-list'        : identityController.profiles,
        'user-directory-get-list'       : identityController.directory,
        'external-principal-provision'  : externalController.provision,
        'external-principal-resolve'    : externalController.resolve,
        'agent-principal-resolve'       : agentController.resolve,
        'agent-principal-authenticate'  : agentController.authenticate,
        'agent-principal-audience'      : agentController.audience,
      };
      const chatService    =
        require('../../service-communication/server/modules/chat/services/chat.service')({
          repository :
            require('../../service-communication/server/modules/chat/repositories/chat.repository')(
              {
                models     : chatModels,
                connection : mongoose.connection,
              },
            ),
          clock      : Date.now,
          messaging  : communication,
          realtime   : {
            /** @returns {Promise<void>} No publica sockets fuera de la prueba. */ async publish() {},
          },
          /** @returns {Promise<void>} La prueba no usa imágenes. */ async discardPicture() {},
        });
      const chatController =
        require('../../service-communication/server/modules/chat/controllers/chat.controller')({
          service   : chatService,
          messaging : communication,
        });
      handlers['service-communication'] = {};
      for (const [action, operation] of [
        ['chat-create', 'create'],
        ['chat-get-one', 'get'],
        ['chat-send', 'send'],
        ['chat-download', 'download'],
        ['chat-access-check', 'access'],
        ['chat-message-retract', 'retract'],
        ['chat-messages-get-list', 'history'],
        ['chat-update', 'update'],
        ['chat-participants-get-list', 'users'],
      ]) {
        /** @param {Object} message Sobre autenticado. @returns {Promise<Object>} Chat canónico. */
        function executeChat(message) {
          return chatController.execute(operation, message);
        }
        handlers['service-communication'][action] = executeChat;
      }
      for (const operation of ['membership', 'message', 'send']) {
        /** @param {Object} message Sobre de Intelligence con credencial canónica. @returns {Promise<Object>} Lectura real del agente y límite de ingreso. */
        function executeAgentChat(message) {
          return chatController.executeAgent(operation, message);
        }
        handlers['service-communication'][`agent-chat-${operation}`] = executeAgentChat;
      }
      await userModel.create({
        ...metadata,
        userCode           : 'agent-user',
        user               : 'agent:agent',
        contactCode        : 'agent-user',
        agentCode          : 'agent',
        agentRevision      : 1,
        agentIdentityState : 'ready',
        userType           : 'agent',
        state              : 'active',
        workspaces         : ['w'],
        groups             : ['agent-profile'],
        validity           : Date.now() + 86400000,
      });
      await agentModel.create({
        ...metadata,
        agentCode     : 'agent',
        userCode      : 'agent-user',
        revision      : 1,
        name          : 'Asistente de prueba',
        state         : 'active',
        workspaces    : ['w'],
        identityState : 'ready',
        limits        : {
          maxSteps       : 1,
          maxDelegations : 0,
          maxDurationMs  : 1000,
          maxConcurrency : 1,
          maxTokens      : 100,
          maxInputBytes  : 1024,
        },
        toolCodes     : [],
      });
      const agents        =
        require('../../service-intelligence/server/modules/agent/repositories/agent.repository')({
          model        : agentModel,
          publishEvent : intelligence.publishEvent,
        });
      const settings      = {
        /** @returns {Promise<Object>} Configuración IA local sin credenciales ni proveedor externo. */ async runtime() {
          return { enabled: true };
        },
        /** @returns {Promise<Object>} Metadatos de configuración requeridos para encolar, sin inferencia. */ async inferenceConfiguration() {
          return {
            models          : {},
            speech          : {},
            revision        : 1,
            maxOutputTokens : 128,
            temperature     : 0,
          };
        },
      };
      const contracts     =
        require('../../service-intelligence/server/adapters/contracts/platform').createContracts({
          messaging : intelligence,
          settings,
          agents,
        });
      // El transporte es explícito: la ejecución canónica nunca hereda el del caller accidentalmente.
      const runs          =
        require('../../service-intelligence/server/modules/run/services/run.service').runService({
          repository :
            require('../../service-intelligence/server/modules/run/repositories/run.repository')({
              model        : runModel,
              publishEvent : intelligence.publishEvent,
            }),
          agents,
          settings,
          contracts,
          messaging  : intelligence,
        });
      const runController =
        require('../../service-intelligence/server/modules/run/controllers/run.controller').runController(
          {
            service   : runs,
            messaging : intelligence,
          },
        );
      handlers['service-intelligence'] = {
        /** @param {Object} message DTO de admisión. @returns {Promise<Object>}202 canónico. */ 'run-create'    :
          (message) => runController.execute('create', message),
        /** @param {Object} message Código propio. @returns {Promise<Object>} Estado canónico. */ 'run-get-one' :
          (message) => runController.execute('getOne', message),
      };
      const agentService            =
        require('../../service-intelligence/server/modules/agent/services/agent.service').agentService(
          {
            repository : agents,
            messaging  : intelligence,
            settings,
            contracts,
          },
        );
      const agentResourceController =
        require('../../service-intelligence/server/modules/agent/controllers/agent.controller').agentController(
          {
            service   : agentService,
            messaging : intelligence,
          },
        );
      /** @param {Object} message Consulta del administrador de la instalación. @returns {Promise<Object>} Registro canónico autorizado. */
      function readAgent(message) {
        return agentResourceController.execute('getOne', message);
      }
      handlers['service-intelligence']['agent-get-one'] = readAgent;
      const connectFiles  =
        require('../../service-connect/server/adapters/filesystem/meta-files').metaFiles(tempRoot);
      const avatar        = await require('../../service-documents/node_modules/sharp')({
        create : {
          width      : 8,
          height     : 8,
          channels   : 3,
          background : '#d00030',
        },
      })
        .png()
        .toBuffer();
      const preparedPhoto = {
        ...(await connectFiles.write(avatar, 'perfil.png', 'image/png')),
        fileId : randomUUID(),
      };
      const binding       = {
        workspaceCode        : 'w',
        ownerUserCode        : 'owner',
        contactCode          : 'META-contact',
        externalUserCode     : 'META-contact',
        chatConversationCode : '',
        externalGroupCodes   : ['external-profile'],
        contactRoleCode      : 'customer',
        displayName          : 'Juan Pablo Lemus García',
        contactPicture       : preparedPhoto,
        contactName          : {
          firstName        : 'Juan Pablo',
          lastNamePaternal : 'Lemus',
          lastNameMaternal : 'García',
        },
        externalId           : 'remote-person',
        controlMode          : 'automatic',
        agentCode            : 'agent',
        hasActiveRun         : false,
      };
      handlers['service-connect'] = {
        /** @returns {Promise<Object>} Vínculo de fixture; el dominio Connect se prueba en su repositorio. */ async 'meta-conversation-binding-get'() {
          return {
            statusCode : 200,
            data       : binding,
          };
        },
        /** @returns {Promise<Object>} Reserva fixture de Connect; la carrera CAS tiene prueba propia. */ async 'meta-run-authorize'() {
          return {
            statusCode : 200,
            data       : {
              authorized : true,
              agentCode  : 'agent',
              teamCode   : '',
            },
          };
        },
      };
      const handler =
        require('../server/modules/meta-bridge/compositions/meta-bridge.composition').metaBridgeComposition(
          {
            messaging      : gateway,
            temporaryFiles :
              require('../server/adapters/files/temporary-files').createTemporaryFiles({
                root : tempRoot,
              }),
            metaRuns       :
              require('../server/modules/meta-bridge/repositories/meta-run.repository').metaRunRepository(
                admissionModel,
              ),
          },
        );
      handlers['service-apigateway'] = { 'meta-platform-execute': handler };
      const connect = transport('service-connect');
      /** @param {string} operation Capacidad del puente. @param {Object} data Datos propios. @returns {Promise<Object>} Respuesta acreditada por todos los DTO. */
      async function execute(operation, data = {}) {
        const result = await connect.request(
          'service-apigateway',
          'meta-platform-execute',
          {
            operation,
            conversationCode : 'linked',
            data,
          },
          { context: {} },
        );
        assert.equal(result.statusCode, 200, `${operation}: ${result.descriptionCode}`);
        return result.data;
      }
      const uncertain = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'provision',
          conversationCode : 'linked',
          data             : {},
        },
        { context: {} },
      );
      assert.equal(uncertain.statusCode, 503);
      assert.equal(uncertain.descriptionCode, 'STORAGE_WRITE_UNCERTAIN');
      assert.equal(await contactModel.countDocuments({ contactCode: binding.contactCode }), 0);
      assert.equal(
        (await filesModel.findOne({ storageId: preparedPhoto.fileId }).lean()).storageState,
        'uploading',
      );
      assert.deepEqual(await fs.readFile(preparedPhoto.tempFilePath), avatar);
      const provision = await execute('provision');
      const withPhoto = await contactModel.findOne({ contactCode: provision.contactCode }).lean();
      assert.match(withPhoto.code, /^CON[0-9]{7}$/);
      assert.equal(withPhoto.stage, 'registered');
      assert.equal(withPhoto.pictureFile.id, preparedPhoto.fileId);
      assert.equal(withPhoto.pictureFile.visibility, 'private');
      assert.equal(withPhoto.picture, '/directory/contact/META-contact/picture');
      assert.equal(await filesModel.countDocuments({}), 1);
      assert.equal(storageState.quotaReservations, 1);
      assert.equal(objects.size, 7);
      const thumbnail = await contactPictures.read(withPhoto, '100');
      assert.equal(
        (
          await require('../../service-documents/node_modules/sharp')(
            thumbnail.tempFilePath,
          ).metadata()
        ).format,
        'png',
      );
      await fs.unlink(thumbnail.tempFilePath);
      assert.equal(provision.userCode, 'META-contact');
      assert.deepEqual(
        (await contactModel.findOne({ contactCode: provision.contactCode }).lean()).name,
        {
          ...binding.contactName,
          preferredName : '',
        },
      );
      const manualName = {
        firstName        : 'Nombre editado',
        lastNamePaternal : 'Apellido editado',
        lastNameMaternal : '',
      };
      await contactModel.updateOne(
        { contactCode: provision.contactCode },
        { $set: { name: manualName } },
      );
      assert.deepEqual(await execute('provision'), provision);
      assert.equal(
        (await contactModel.findOne({ contactCode: provision.contactCode }).lean()).pictureFile.id,
        preparedPhoto.fileId,
      );
      assert.equal(await filesModel.countDocuments({}), 1);
      assert.equal((await fs.readdir(tempRoot)).length, 1);
      await connectFiles.remove(preparedPhoto);
      assert.deepEqual(
        (await contactModel.findOne({ contactCode: provision.contactCode }).lean()).name,
        manualName,
      );
      const chat = await execute('chat-create', {
        requestId : 'request',
        name      : 'Chat Meta',
      });
      binding.chatConversationCode = chat.conversationCode;
      assert.equal(chat.members.length, 2);
      assert(
        chat.members.some(
          /** @param {Object} member Participante canónico. @returns {boolean} Sujeto externo con membresía normal. */
          (member) => member.userCode === provision.userCode,
        ),
      );
      const old      = await execute('chat-send', {
        requestId       : 'before-agent',
        text            : 'Entrada anterior a la incorporación',
        attachmentCodes : [],
      });
      const identity = await contracts.resolve({
        runCode    : 'fixture-membership',
        agentCode  : 'agent',
        workspace  : 'w',
        userCreate : provision.userCode,
      });
      await assert.rejects(
        contracts.chat('membership', { code: chat.conversationCode }, identity),
        {
          descriptionCode : 'CHAT_NOT_FOUND',
        },
      );
      assert.deepEqual(await execute('chat-prepare-automation'), { ready: true });
      assert.deepEqual(await execute('chat-prepare-automation'), { ready: true });
      const prepared = await execute('chat-get');
      assert.equal(prepared.members.length, 3);
      assert.equal(
        prepared.members.find(
          /** @param {Object} member Participante canónico. @returns {boolean} Agente esperado. */
          (member) => member.userCode === 'agent-user',
        ).joinedSequence,
        old.sequence,
      );
      await assert.rejects(
        contracts.chat(
          'message',
          {
            code        : chat.conversationCode,
            messageCode : old.messageCode,
          },
          identity,
        ),
        { descriptionCode: 'CHAT_MESSAGE_NOT_FOUND' },
      );
      const denied = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'run-create',
          conversationCode : 'linked',
          data             : {
            requestId   : 'old-event',
            messageCode : old.messageCode,
          },
        },
        { context: {} },
      );
      assert.equal(denied.descriptionCode, 'META_AUTOMATION_TRIGGER_UNAVAILABLE');
      assert.equal(await runModel.countDocuments(), 0);
      const sent = await execute('chat-send', {
        requestId       : 'inbound',
        text            : 'Consulta de cliente',
        attachmentCodes : [],
      });
      assert.equal(sent.userCode, provision.userCode);
      assert(
        (await execute('chat-history')).items.some(
          /** @param {Object} message Mensaje del historial autorizado. @returns {boolean} Entrada nueva persistida. */
          /** @param {Object} message Mensaje. @returns {boolean} Mismo ID original. */ (message) =>
            message.messageCode === sent.messageCode,
        ),
      );
      const run = await execute('run-create', {
        requestId   : 'event',
        messageCode : sent.messageCode,
      });
      assert.equal(run.status, 'queued');
      assert.equal(
        (
          await execute('run-create', {
            requestId   : 'event',
            messageCode : sent.messageCode,
          })
        ).runCode,
        run.runCode,
      );
      assert.equal((await execute('run-get', { runCode: run.runCode })).status, 'queued');
      const stored = await runModel.findOne({ runCode: run.runCode }).lean();
      assert.equal(stored.userCreate, provision.userCode);
      assert.equal(stored.input.conversationCode, chat.conversationCode);
      assert.equal(await runModel.countDocuments(), 1);
      const execution = await contracts.resolve(stored);
      const members   = await contracts.chat(
        'membership',
        { code: chat.conversationCode },
        execution,
      );
      assert(
        members.members.some(
          /** @param {Object} member Participante autorizado. @returns {boolean} Agente ya visible durante ejecución. */
          (member) => member.userCode === 'agent-user' && member.actorType === 'agent',
        ),
      );
      const trigger = await contracts.chat(
        'message',
        {
          code        : chat.conversationCode,
          messageCode : sent.messageCode,
        },
        execution,
      );
      assert.equal(trigger.messageCode, sent.messageCode);
      assert.equal(trigger.userCode, provision.userCode);
      const retracted = await execute('chat-retract', {
        requestId   : 'inbound',
        messageCode : sent.messageCode,
      });
      assert.equal(retracted.messageCode, sent.messageCode);
      assert.equal(retracted.conversationCode, chat.conversationCode);
      assert.equal(retracted.retracted, true);
      assert.deepEqual(await execute('chat-retract', { requestId: 'inbound' }), retracted);
      const tombstone = (await execute('chat-history')).items.find(
        /** @param {Object} message Mensaje. @returns {boolean} Mismo ID original. */ (message) =>
          message.messageCode === sent.messageCode,
      );
      assert.equal(tombstone.retracted, true);
      assert.equal(tombstone.text, 'Mensaje anulado');
      assert.deepEqual(tombstone.attachments, []);
      const hidden = await contracts.chat(
        'message',
        {
          code        : chat.conversationCode,
          messageCode : sent.messageCode,
        },
        execution,
      );
      assert.equal(hidden.contentUnavailable, true);
      assert.equal(hidden.text, 'Mensaje anulado');
      assert.equal((await execute('run-get', { runCode: run.runCode })).status, 'queued');
      assert.equal(await runModel.countDocuments(), 1);
      const mismatch = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'chat-retract',
          conversationCode : 'linked',
          data             : {
            requestId   : 'inbound',
            messageCode : old.messageCode,
          },
        },
        { context: {} },
      );
      assert.equal(mismatch.descriptionCode, 'META_RETRACTION_IDENTITY_MISMATCH');
      const unavailable = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'chat-retract',
          conversationCode : 'linked',
          data             : { requestId: 'never-published' },
        },
        { context: {} },
      );
      assert.equal(unavailable.descriptionCode, 'META_RETRACTION_UNCONFIRMED');
      await chatModels.attachments.create({
        workspace        : 'allWorkspaces',
        userCreate       : provision.userCode,
        attachmentCode   : 'orphan-ready',
        conversationCode : chat.conversationCode,
        requestId        : 'meta:withdrawn:0',
        name             : 'fixture.txt',
        size             : 1,
        mime             : 'text/plain',
        state            : 'ready',
        creationDate     : Date.now(),
        lastAttemptDate  : Date.now(),
      });
      const orphanDownload = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'chat-download',
          conversationCode : 'linked',
          data             : { attachmentCode: 'orphan-ready' },
        },
        { context: {} },
      );
      assert.equal(orphanDownload.descriptionCode, 'CHAT_ATTACHMENT_UNAVAILABLE');
      await assert.rejects(
        chatService.executeAgent(
          'download',
          {
            code           : chat.conversationCode,
            attachmentCode : 'orphan-ready',
          },
          execution.token,
          execution.principal.agentRevision,
        ),
        { descriptionCode: 'CHAT_ATTACHMENT_UNAVAILABLE' },
      );
      const access = await intelligence.request(
        'service-communication',
        'chat-access-check',
        {
          workspace       : 'w',
          viewerUserCodes : ['agent-user'],
          references      : [
            {
              conversationCode : chat.conversationCode,
              messageCode      : sent.messageCode,
              attachmentCode   : 'orphan-ready',
            },
          ],
        },
        { context: {} },
      );
      assert.equal(access.data.allowed, false);
      const currentMembers = await contracts.chat(
        'membership',
        { code: chat.conversationCode },
        execution,
      );
      await assert.rejects(
        contracts.chat(
          'send',
          {
            code                    : chat.conversationCode,
            requestId               : 'cannot-republish-orphan',
            text                    : '',
            attachmentCodes         : ['orphan-ready'],
            mentionedUserCodes      : [],
            sourceBindings          : [],
            expectedRevision        : currentMembers.revision,
            expectedAudienceVersion : currentMembers.audienceVersion,
            expectedMemberCodes     : currentMembers.members.map(
              /** @param {Object} member Participante. @returns {string} Audiencia actual. */ (
                member,
              ) => member.userCode,
            ),
          },
          execution,
        ),
        { descriptionCode: 'CHAT_ATTACHMENT_UNAVAILABLE' },
      );
      assert.equal(
        (await chatModels.attachments.findOne({ attachmentCode: 'orphan-ready' }).lean()).state,
        'ready',
      );

      const audience = await context.run(
        {},
        /** @returns {Promise<Object>} Audiencia real de Security consultada por Intelligence. */
        () => contracts.audience(stored, [provision.userCode]),
      );
      assert.equal(audience.principals[0].userCode, provision.userCode);
      assert(!audience.principals[0].policies.includes('security.user.update.global'));
      assert(
        emitted.some(
          /** @param {Object} event Evento capturado. @returns {boolean} Intelligence solicitó ejecución asíncrona canónica. */
          (event) => event.action === 'intelligence.run.requested',
        ),
      );
      // Una carga retirada por Directory no puede reutilizarse: el trabajador recibe ausencia acreditada para continuar sin foto.
      const createContact = contacts.create;
      let rejectContact   = true;
      /** @param {Object} input Contacto nuevo. @param {string} scope Ámbito validado. @returns {Promise<Object>} Inyecta fallo definitivo antes de insertar, después de subir la foto. */
      contacts.create = async (input, scope) => {
        if (rejectContact) {
          rejectContact = false;
          throw new (require('../../service-directory/server/shared/application-error').ApplicationError)(
            503,
            'DIRECTORY_WRITE_FAILED',
          );
        }
        return createContact(input, scope);
      };
      const retiredPhoto = {
        ...(await connectFiles.write(avatar, 'perfil.png', 'image/png')),
        fileId : randomUUID(),
      };
      Object.assign(binding, {
        contactCode      : 'META-retired-photo',
        externalUserCode : 'META-retired-photo',
        contactPicture   : retiredPhoto,
      });
      const failedInsert = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'provision',
          conversationCode : 'linked',
          data             : {},
        },
        { context: {} },
      );
      assert.equal(failedInsert.statusCode, 503);
      assert.equal(
        (await filesModel.findOne({ storageId: retiredPhoto.fileId }).lean()).storageState,
        'deleted',
      );
      const retired = await connect.request(
        'service-apigateway',
        'meta-platform-execute',
        {
          operation        : 'provision',
          conversationCode : 'linked',
          data             : {},
        },
        { context: {} },
      );
      assert.equal(retired.descriptionCode, 'META_CONTACT_PICTURE_REJECTED');
      binding.contactPicture = null;
      const withoutPhoto    = await execute('provision');
      const fallbackContact = await contactModel
        .findOne({ contactCode: withoutPhoto.contactCode })
        .lean();
      assert.deepEqual(fallbackContact.name, {
        ...binding.contactName,
        preferredName : '',
      });
      assert(!fallbackContact.pictureFile?.id);
      await connectFiles.remove(retiredPhoto);
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      await fs.rm(tempRoot, {
        recursive : true,
        force     : true,
      });
    }
  },
);
