/** @file Puente restringido a vínculos Meta: reutiliza contratos canónicos sin suplantar actores del payload. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { metaParticipants } = require('./meta-participants.service');
/** Compone capacidades mínimas de mensajería, archivos y admisión persistente.
 * @param {Object} dependencies Adaptadores explícitos sin acceso HTTP público.
 * @returns {Object} Operación interna acreditada por origen y vínculo autoritativo.
 */
function metaPlatformService({ messaging, files, admission }) {
  /** Ejecuta RPC conservando estado y descripción pública sin convertir fallos en ausencia.
   * @param {string} service Servicio canónico.
   * @param {string} action Acción canónica.
   * @param {Object} data DTO cerrado.
   * @param {Object} context Contexto construido por Security.
   * @returns {Promise<Object>} Datos del servicio remoto.
   */
  async function rpc(service, action, data, context = {}) {
    const result = await messaging.request(service, action, data, {
      context,
      timeoutMs : data.pictureUpload ? 310000 : 120000,
    });
    if (!result || result.statusCode < 200 || result.statusCode >= 300)
      throw new ApplicationError(
        result?.statusCode || 503,
        result?.descriptionCode || 'META_PLATFORM_UNAVAILABLE',
      );
    return result.data;
  }
  /** Consulta permisos del operador reservado por Connect; ningún campo del webhook elige actor.
   * @param {Object} binding Vínculo autoritativo.
   * @param {string} userCode Operador elegido por configuración o control autenticado.
   * @returns {Promise<Object>} Principal vigente con permiso administrativo Meta.
   */
  async function operator(binding, userCode) {
    const result    = await rpc('service-security', 'workspace-principals-get-list', {
      workspace : binding.workspaceCode,
      userCodes : [userCode],
    });
    const principal = result.items.find(
      /** @param {Object} item Principal vigente. @returns {boolean} Coincidencia exacta. */
      (item) => item.userCode === userCode,
    );
    if (!principal?.policies.includes('connect.meta.update.global'))
      throw new ApplicationError(403, 'META_OPERATOR_UNAVAILABLE');
    return {
      user      : { userCode },
      workspace : binding.workspaceCode,
      policies  : principal.policies,
    };
  }
  const participants = metaParticipants({ rpc });
  return {
    /** Opera exclusivamente recursos que Connect ha vinculado durablemente.
     * @param {Object} input Operación, conversación Meta y DTO específico sin contexto.
     * @param {string} source Origen autenticado del sobre.
     * @returns {Promise<Object>} Resultado canónico; no amplía permisos de publicación ni fuentes.
     */
    async execute(input, source) {
      if (source !== 'service-connect') throw new ApplicationError(403, 'FORBIDDEN');
      const binding = await rpc('service-connect', 'meta-conversation-binding-get', {
        conversationCode : input.conversationCode,
      });
      if (
        !binding ||
        !binding.workspaceCode ||
        binding.workspaceCode === 'allWorkspaces' ||
        !binding.contactCode ||
        binding.externalUserCode !== binding.contactCode
      )
        throw new ApplicationError(403, 'META_BINDING_UNAVAILABLE');
      const ownerContext = await operator(binding, binding.ownerUserCode);
      const identity     = {
        contactCode      : binding.contactCode,
        workspaceCode    : binding.workspaceCode,
        conversationCode : input.conversationCode,
        ownerUserCode    : binding.ownerUserCode,
        groups           : binding.externalGroupCodes || [],
      };
      const data         = input.data || {};
      if (input.operation === 'provision') {
        let contact;
        try {
          contact = await rpc(
            'service-directory',
            'contact-get-one',
            { contactCode: binding.contactCode },
            ownerContext,
          );
        } catch (error) {
          if (error.statusCode !== 404) throw error;
          if (!binding.contactName) throw new ApplicationError(503, 'META_CONTACT_NAME_PENDING');
          let pictureUpload;
          let pictureConsumed = false;
          try {
            if (binding.contactPicture) pictureUpload = await files.picture(binding.contactPicture);
            contact = await rpc(
              'service-directory',
              'contact-create',
              {
                contactCode : binding.contactCode,
                workspace   : binding.workspaceCode,
                workspaces  : [binding.workspaceCode],
                roleCode    : binding.contactRoleCode,
                userType    : 'external',
                name        : {
                  firstName        : binding.contactName.firstName,
                  lastNamePaternal : binding.contactName.lastNamePaternal,
                  lastNameMaternal : binding.contactName.lastNameMaternal,
                },
                ...(pictureUpload ? { pictureUpload } : {}),
              },
              ownerContext,
            );
            pictureConsumed = true;
          } catch (creationError) {
            pictureConsumed = creationError.statusCode < 500;
            const pictureRejected =
              pictureUpload &&
              ((creationError.statusCode === 409 &&
                creationError.descriptionCode === 'FILE_NOT_READY') ||
                (creationError.statusCode === 400 &&
                  creationError.descriptionCode === 'INVALID_IMAGE') ||
                (creationError.statusCode === 413 &&
                  creationError.descriptionCode === 'IMAGE_TOO_LARGE'));
            if (creationError.statusCode !== 409 && !pictureRejected) throw creationError;
            try {
              contact = await rpc(
                'service-directory',
                'contact-get-one',
                { contactCode: binding.contactCode },
                ownerContext,
              );
            } catch (readError) {
              if (pictureRejected && readError.statusCode === 404)
                throw new ApplicationError(422, 'META_CONTACT_PICTURE_REJECTED');
              throw readError;
            }
          } finally {
            if (pictureUpload && pictureConsumed) await files.remove(pictureUpload.tempFilePath);
          }
        }
        if (
          contact.contactCode !== binding.contactCode ||
          contact.userCode !== binding.contactCode ||
          contact.workspace !== binding.workspaceCode
        )
          throw new ApplicationError(409, 'META_CONTACT_CONFLICT');
        return rpc('service-security', 'external-principal-provision', {
          ...identity,
          groups : binding.externalGroupCodes || [],
        });
      }
      const { context } = await rpc('service-security', 'external-principal-resolve', identity);
      /** @param {string} action Acción Chat canónica. @param {Object} payload DTO interno. @returns {Promise<Object>} Resultado con identidad externa. */
      const chat        = (action, payload) => rpc('service-communication', action, payload, context);
      if (input.operation === 'chat-create') {
        if (binding.chatConversationCode)
          return chat('chat-get-one', { code: binding.chatConversationCode });
        return chat('chat-create', {
          requestId : `meta:${input.conversationCode}`,
          kind      : 'group',
          userCodes : [binding.ownerUserCode],
          name      : (data.name || binding.displayName || 'Meta').slice(0, 100),
        });
      }
      const code = binding.chatConversationCode;
      if (!code) throw new ApplicationError(409, 'META_CHAT_NOT_LINKED');
      if (input.operation === 'chat-prepare-automation')
        return participants.prepare(binding, ownerContext, chat);
      if (input.operation === 'chat-get') return chat('chat-get-one', { code });
      if (input.operation === 'chat-history')
        return chat('chat-messages-get-list', {
          code,
          ...(data.before === undefined ? {} : { before: data.before }),
        });
      if (input.operation === 'chat-send')
        return chat('chat-send', {
          code,
          requestId          : data.requestId,
          text               : data.text,
          attachmentCodes    : data.attachmentCodes || [],
          mentionedUserCodes : [],
        });
      if (input.operation === 'chat-retract') {
        let before;
        for (let page = 0; page < 200; page++) {
          const history  = await chat('chat-messages-get-list', {
            code,
            ...(before === undefined ? {} : { before }),
          });
          const original = history.items?.find(
            /** @param {Object} message Mensaje canónico. @returns {boolean} Solicitud original del contacto externo, no otra publicación. */
            (message) =>
              message.userCode === binding.externalUserCode && message.requestId === data.requestId,
          );
          if (original) {
            if (data.messageCode && original.messageCode !== data.messageCode)
              throw new ApplicationError(409, 'META_RETRACTION_IDENTITY_MISMATCH');
            return chat('chat-message-retract', {
              code,
              messageCode : original.messageCode,
            });
          }
          if (!history.hasMore || !history.items?.length) break;
          before = Math.min(
            ...history.items.map(
              /** @param {Object} message Mensaje canónico. @returns {number} Cursor autorizado. */
              (message) => message.sequence,
            ),
          );
        }
        throw new ApplicationError(503, 'META_RETRACTION_UNCONFIRMED');
      }
      if (input.operation === 'chat-upload') {
        await chat('chat-get-one', { code });
        const file = await files.upload(data);
        return chat('chat-upload', {
          code,
          requestId    : data.requestId,
          name         : file.name,
          size         : file.size,
          tempFilePath : file.tempFilePath,
          digest       : file.digest,
        });
      }
      if (input.operation === 'chat-download') {
        return files.download(
          await chat('chat-download', {
            code,
            attachmentCode : data.attachmentCode,
          }),
        );
      }
      if (input.operation === 'chat-add-operator') {
        await operator(binding, data.userCode);
        return chat('chat-update', {
          code,
          operation : 'add',
          userCodes : [data.userCode],
        });
      }
      /** @param {string} action Acción de ejecución. @param {Object} payload DTO canónico derivado del vínculo. @returns {Promise<Object>} Estado y resultado con audiencia intacta. */
      const intelligence = (action, payload) =>
        rpc('service-intelligence', action, payload, context);
      if (input.operation === 'run-get') return admission.get(code, data.runCode, intelligence);
      if (input.operation === 'run-create') {
        if (data.conversationCode && data.conversationCode !== code)
          throw new ApplicationError(403, 'META_CHAT_FORBIDDEN');

        const previous = await admission.resume(
          code,
          data.requestId,
          data.messageCode,
          intelligence,
        );
        if (previous) return previous;
        await chat('chat-get-one', { code });
        const authorized = await rpc('service-connect', 'meta-run-authorize', {
          conversationCode : input.conversationCode,
          requestId        : data.requestId,
          messageCode      : data.messageCode,
        });
        if (authorized?.authorized !== true || !!authorized.agentCode === !!authorized.teamCode)
          throw new ApplicationError(403, 'META_RUN_AUTHORIZATION_UNAVAILABLE');
        await participants.verifyTrigger(
          {
            ...binding,
            agentCode : authorized.agentCode,
            teamCode  : authorized.teamCode,
          },
          data.messageCode,
          ownerContext,
          chat,
        );
        const request = {
          requestId : data.requestId,
          workspace : binding.workspaceCode,
          scope     : 'owner',
          ...(authorized.teamCode
            ? { teamCode: authorized.teamCode }
            : { agentCode: authorized.agentCode }),
          input     : {
            conversationCode : code,
            messageCode      : data.messageCode,
          },
        };
        return admission.create(code, request, intelligence);
      }
      throw new ApplicationError(400, 'META_INVALID_OPERATION');
    },
  };
}
module.exports = { metaPlatformService };
