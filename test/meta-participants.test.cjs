/** @file Acredita preparación de agente/equipo, límites de historial y audiencia de ejecuciones aceptadas. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  metaParticipants,
} = require('../server/modules/meta-bridge/services/meta-participants.service');
/** @returns {Object} Contratos simulados sin persistencia ni credenciales; Mongo canónico se prueba por separado. */
function fixture() {
  const binding      = {
    chatConversationCode : 'chat',
    workspaceCode        : 'w',
    externalUserCode     : 'external',
    controlMode          : 'automatic',
    agentCode            : 'agent',
    teamCode             : '',
    hasActiveRun         : false,
  };
  const context      = {
    policies : ['intelligence.agent.view.workspace', 'intelligence.team.view.workspace'],
  };
  const conversation = {
    sequence : 4,
    members  : [
      {
        userCode  : 'external',
        actorType : 'human',
      },
      {
        userCode  : 'owner',
        actorType : 'human',
      },
    ],
  };
  const agents       = new Map(
    ['agent', 'coordinator', 'member'].map(
      /** @param {string} agentCode Identidad. @returns {Array} Recurso canónico simulado. */
      (agentCode) => [
        agentCode,
        {
          agentCode,
          userCode      : `user-${agentCode}`,
          state         : 'active',
          identityState : 'ready',
          workspaces    : ['w'],
        },
      ],
    ),
  );
  const calls        = [];
  const history      = {
    items   : [
      {
        messageCode : 'trigger',
        userCode    : 'external',
        sequence    : 5,
      },
    ],
    hasMore : false,
  };
  const service      = metaParticipants({
    /** @param {string} target Servicio. @param {string} action Acción. @param {Object} data DTO. @param {Object} actor Responsable. @returns {Promise<Object>} Metadata administrativa autorizada. */
    async rpc(target, action, data, actor) {
      assert.equal(target, 'service-intelligence');
      assert.equal(actor, context);
      calls.push(action);
      if (action === 'agent-get-one') return agents.get(data.agentCode);
      if (action === 'team-get-one')
        return {
          teamCode        : 'team',
          state           : 'active',
          workspace       : 'w',
          coordinatorCode : 'coordinator',
          memberCodes     : ['member'],
        };
      throw Error('unexpected');
    },
  });
  /** @param {string} action Acción canónica. @param {Object} data DTO. @returns {Promise<Object>} Simula registro de ingreso sin ampliar historial. */
  async function chat(action, data) {
    calls.push(action);
    if (action === 'chat-get-one') return structuredClone(conversation);
    if (action === 'chat-participants-get-list')
      return {
        items : [...agents.values()]
          .filter(
            /** @param {Object} agent Principal vigente. @returns {boolean} Identidad solicitada. */
            (agent) => data.codes.includes(agent.userCode),
          )
          .map(
            /** @param {Object} agent Principal vigente. @returns {Object} Proyección canónica Security. */
            (agent) => ({
              userCode  : agent.userCode,
              actorType : 'agent',
              agentCode : agent.agentCode,
            }),
          ),
      };
    if (action === 'chat-update') {
      assert.equal(data.code, 'chat');
      assert.equal(data.operation, 'add');
      for (const userCode of data.userCodes) {
        const agent = [...agents.values()].find(
          /** @param {Object} candidate Principal configurado. @returns {boolean} Coincidencia. */
          (candidate) => candidate.userCode === userCode,
        );
        conversation.members.push({
          userCode,
          actorType      : 'agent',
          agentCode      : agent.agentCode,
          joinedSequence : conversation.sequence,
        });
      }
      return { conversationCode: 'chat' };
    }
    if (action === 'chat-messages-get-list') return history;
    throw Error('unexpected');
  }
  return {
    service,
    binding,
    context,
    conversation,
    agents,
    calls,
    history,
    chat,
  };
}
test('prepara coordinador y miembros exactos una sola vez sin agregar otros agentes', /** @returns {Promise<void>} Reanudar no duplica ni amplía la audiencia. */ async () => {
  const f = fixture();
  f.binding.agentCode = '';
  f.binding.teamCode = 'team';
  assert.deepEqual(await f.service.prepare(f.binding, f.context, f.chat), { ready: true });
  assert.deepEqual(await f.service.prepare(f.binding, f.context, f.chat), { ready: true });
  assert.deepEqual(
    f.conversation.members.slice(2).map(
      /** @param {Object} member Participante. @returns {string} Agente incorporado. */
      (member) => member.agentCode,
    ),
    ['coordinator', 'member'],
  );
  assert.equal(
    f.calls.filter(
      /** @param {string} action Acción. @returns {boolean} Mutación de audiencia. */
      (action) => action === 'chat-update',
    ).length,
    1,
  );
  await f.service.verifyTrigger(f.binding, 'trigger', f.context, f.chat);
});
test('un run activo impide ampliar audiencia y el modo humano no incorpora agentes', /** @returns {Promise<void>} Esperar no cancela ni toca la ejecución aceptada. */ async () => {
  const f = fixture();
  f.binding.hasActiveRun = true;
  assert.deepEqual(await f.service.prepare(f.binding, f.context, f.chat), { ready: false });
  assert(!f.calls.includes('chat-update'));
  f.binding.controlMode = 'human';
  f.calls.length = 0;
  assert.deepEqual(await f.service.prepare(f.binding, f.context, f.chat), { ready: true });
  assert.equal(f.calls.length, 0);
});
test('rechaza agente de otro workspace o identidad pendiente antes de cambiar Chat', /** @returns {Promise<void>} Las referencias administrativas no bastan para incorporar identidades inválidas. */ async () => {
  for (const invalid of [
    { workspaces: ['other'] },
    { identityState: 'pending' },
    { state: 'inactive' },
  ]) {
    const f = fixture();
    Object.assign(f.agents.get('agent'), invalid);
    await assert.rejects(f.service.prepare(f.binding, f.context, f.chat), {
      descriptionCode : 'META_AUTOMATION_AGENT_UNAVAILABLE',
    });
    assert(!f.calls.includes('chat-update'));
  }
});
test('una entrada anterior al ingreso o de otro autor no se admite y no altera membresía', /** @returns {Promise<void>} El guard no corrige una falta de acceso retrocediendo joinedSequence. */ async () => {
  const f = fixture();
  await f.service.prepare(f.binding, f.context, f.chat);
  for (const trigger of [
    {
      messageCode : 'trigger',
      sequence    : 4,
      userCode    : 'external',
    },
    {
      messageCode : 'trigger',
      sequence    : 5,
      userCode    : 'other',
    },
  ]) {
    f.history.items = [trigger];
    await assert.rejects(f.service.verifyTrigger(f.binding, 'trigger', f.context, f.chat), {
      descriptionCode : 'META_AUTOMATION_TRIGGER_UNAVAILABLE',
    });
  }
});
