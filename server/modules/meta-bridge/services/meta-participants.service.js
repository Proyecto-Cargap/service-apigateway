/** @file Prepara participantes IA mediante contratos canónicos antes del disparador externo. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies RPC autorizado de la composición. @returns {Object} Preparación y acreditación de audiencia sin credenciales de agentes. */
function metaParticipants({ rpc }) {
  /** @param {Object} context Administrador vigente. @param {string} resource Recurso Intelligence. @returns {string} Alcance administrativo concedido. */
  function scope(context, resource) {
    const selected = ['global', 'workspace'].find(
      /** @param {string} value Alcance. @returns {boolean} Permiso explícito. */
      (value) => context.policies?.includes(`intelligence.${resource}.view.${value}`),
    );
    if (!selected) throw new ApplicationError(403, 'META_AUTOMATION_CONFIGURATION_FORBIDDEN');
    return selected;
  }
  /** @param {Object} binding Destino reservado por Connect. @param {Object} context Responsable vigente. @param {Function} chat Chat con identidad externa. @returns {Promise<Object[]>} Principales activos del destino exacto y workspace. */
  async function targets(binding, context, chat) {
    if (Boolean(binding.agentCode) === Boolean(binding.teamCode))
      throw new ApplicationError(409, 'META_AUTOMATION_TARGET_REQUIRED');
    let codes = [binding.agentCode];
    if (binding.teamCode) {
      const team = await rpc(
        'service-intelligence',
        'team-get-one',
        {
          teamCode : binding.teamCode,
          scope    : scope(context, 'team'),
        },
        context,
      );
      if (
        team.teamCode !== binding.teamCode ||
        team.state !== 'active' ||
        team.workspace !== binding.workspaceCode ||
        !team.coordinatorCode ||
        !Array.isArray(team.memberCodes) ||
        !team.memberCodes.length
      )
        throw new ApplicationError(409, 'META_AUTOMATION_TEAM_UNAVAILABLE');
      codes = [...new Set([team.coordinatorCode, ...team.memberCodes])];
    }
    if (codes.length > 98) throw new ApplicationError(409, 'META_AUTOMATION_GROUP_LIMIT');
    const agents = [];
    for (const agentCode of codes) {
      const agent = await rpc(
        'service-intelligence',
        'agent-get-one',
        {
          agentCode,
          scope : scope(context, 'agent'),
        },
        context,
      );
      if (
        agent.agentCode !== agentCode ||
        agent.state !== 'active' ||
        agent.identityState !== 'ready' ||
        !agent.userCode ||
        !agent.workspaces?.includes(binding.workspaceCode)
      )
        throw new ApplicationError(409, 'META_AUTOMATION_AGENT_UNAVAILABLE');
      agents.push({
        agentCode,
        userCode : agent.userCode,
      });
    }
    if (
      new Set(
        agents.map(
          /** @param {Object} agent Identidad resuelta. @returns {string} Principal canónico. */
          (agent) => agent.userCode,
        ),
      ).size !== agents.length
    )
      throw new ApplicationError(409, 'META_AUTOMATION_AGENT_UNAVAILABLE');
    const directory = await chat('chat-participants-get-list', {
      codes : agents.map(
        /** @param {Object} agent Identidad resuelta. @returns {string} Principal canónico. */
        (agent) => agent.userCode,
      ),
    });
    for (const agent of agents)
      if (
        !directory.items?.some(
          /** @param {Object} principal Security acredita estado y workspace vigentes. @returns {boolean} La identidad pertenece al agente configurado. */
          (principal) =>
            principal.userCode === agent.userCode &&
            principal.actorType === 'agent' &&
            principal.agentCode === agent.agentCode,
        )
      )
        throw new ApplicationError(409, 'META_AUTOMATION_AGENT_UNAVAILABLE');
    return agents;
  }
  /** @param {Object} conversation Chat canónico. @param {Object} agent Principal esperado. @returns {Object|undefined} Membresía acreditada sin sustituir un humano. */
  function member(conversation, agent) {
    return conversation.members?.find(
      /** @param {Object} item Participante. @returns {boolean} Coincidencia de las dos identidades. */
      (item) =>
        item.userCode === agent.userCode &&
        item.actorType === 'agent' &&
        item.agentCode === agent.agentCode &&
        Number.isSafeInteger(item.joinedSequence),
    );
  }
  return {
    /** @param {Object} binding Vínculo actual. @param {Object} context Responsable. @param {Function} chat Cliente canónico. @returns {Promise<Object>} ready=false conserva entrada hasta finalizar el run cuya audiencia no puede cambiar. */
    async prepare(binding, context, chat) {
      if (binding.controlMode !== 'automatic') return { ready: true };
      const agents       = await targets(binding, context, chat);
      const conversation = await chat('chat-get-one', { code: binding.chatConversationCode });
      const missing      = agents.filter(
        /** @param {Object} agent Principal autorizado. @returns {boolean} Falta pertenencia efectiva. */
        (agent) => !member(conversation, agent),
      );
      if (!missing.length) return { ready: true };
      if (binding.hasActiveRun) return { ready: false };
      if ((conversation.members?.length || 0) + missing.length > 100)
        throw new ApplicationError(409, 'META_AUTOMATION_GROUP_LIMIT');
      await chat('chat-update', {
        code      : binding.chatConversationCode,
        operation : 'add',
        userCodes : missing.map(
          /** @param {Object} agent Principal autorizado. @returns {string} Usuario acreditado por Security. */
          (agent) => agent.userCode,
        ),
      });
      const current = await chat('chat-get-one', { code: binding.chatConversationCode });
      if (
        agents.some(
          /** @param {Object} agent Principal autorizado. @returns {boolean} La operación canónica no acreditó pertenencia. */
          (agent) => !member(current, agent),
        )
      )
        throw new ApplicationError(409, 'META_AUTOMATION_MEMBERSHIP_UNAVAILABLE');
      return { ready: true };
    },
    /** @param {Object} binding Vínculo con destino autorizado. @param {string} messageCode Disparador canónico. @param {Object} context Responsable. @param {Function} chat Cliente canónico. @returns {Promise<void>} Impide admitir runs sin acceso al disparador; nunca agrega participantes después del mensaje. */
    async verifyTrigger(binding, messageCode, context, chat) {
      const agents       = await targets(binding, context, chat);
      const conversation = await chat('chat-get-one', { code: binding.chatConversationCode });
      let before;
      for (let page = 0; page < 200; page++) {
        const history = await chat('chat-messages-get-list', {
          code : binding.chatConversationCode,
          ...(before === undefined ? {} : { before }),
        });
        const trigger = history.items?.find(
          /** @param {Object} item Mensaje autorizado. @returns {boolean} Disparador solicitado. */
          (item) => item.messageCode === messageCode,
        );
        if (trigger) {
          if (
            trigger.retracted === true ||
            trigger.userCode !== binding.externalUserCode ||
            !Number.isSafeInteger(trigger.sequence) ||
            agents.some(
              /** @param {Object} agent Destino vigente. @returns {boolean} No puede leer un mensaje anterior a su ingreso. */
              (agent) =>
                !member(conversation, agent) ||
                member(conversation, agent).joinedSequence >= trigger.sequence,
            )
          )
            throw new ApplicationError(409, 'META_AUTOMATION_TRIGGER_UNAVAILABLE');
          return;
        }
        if (!history.hasMore || !history.items?.length) break;
        before = Math.min(
          ...history.items.map(
            /** @param {Object} item Mensaje canónico. @returns {number} Cursor autorizado. */
            (item) => item.sequence,
          ),
        );
      }
      throw new ApplicationError(409, 'META_AUTOMATION_TRIGGER_UNAVAILABLE');
    },
  };
}
module.exports = { metaParticipants };
