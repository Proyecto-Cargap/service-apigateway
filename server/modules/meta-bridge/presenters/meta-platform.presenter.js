/** @file Salida explícita del puente: no transmite resultados privados de runs ni campos accidentales del proveedor. */
'use strict';
/** Selecciona campos públicos presentes sin propagar propiedades adicionales.
 * @param {Object} item Registro canónico.
 * @param {string[]} fields Campos del contrato del puente.
 * @returns {Object} Copia plana con claves permitidas.
 */
function pick(item, fields) {
  const result = {};
  for (const field of fields) if (item?.[field] !== undefined) result[field] = item[field];
  return result;
}
/** @param {Object} item Adjunto del mensaje confirmado. @returns {Object} Metadatos sin identificadores de almacenamiento. */
function attachment(item) {
  return pick(item, ['attachmentCode', 'name', 'size', 'mime', 'audioOrigin']);
}
/** @param {Object} item Mensaje canónico confirmado. @returns {Object} Contenido y autor público sin fuentes internas. */
function message(item) {
  return {
    ...pick(item, [
      'messageCode',
      'conversationCode',
      'sequence',
      'userCode',
      'senderName',
      'text',
      'creationDate',
      'requestId',
      'actorType',
      'agentCode',
      'mentionedUserCodes',
      'retracted',
      'retractedAt',
    ]),
    attachments : (item.attachments || []).map(attachment),
  };
}
/** Presenta cada capacidad cerrada del puente, independiente del proveedor del canal.
 * @param {string} operation Operación validada por DTO.
 * @param {Object} result Resultado del contrato canónico.
 * @returns {Object} Respuesta limitada a información utilizada por la integración.
 */
function metaPlatformPresenter(operation, result) {
  if (operation === 'provision') return pick(result, ['userCode', 'contactCode']);
  if (operation === 'chat-prepare-automation') return pick(result, ['ready']);
  if (operation === 'chat-retract')
    return pick(result, [
      'messageCode',
      'conversationCode',
      'sequence',
      'retracted',
      'retractedAt',
    ]);
  if (operation === 'chat-create' || operation === 'chat-get')
    return {
      ...pick(result, [
        'conversationCode',
        'kind',
        'name',
        'revision',
        'sequence',
        'audienceVersion',
      ]),
      members : (result.members || []).map(
        /** @param {Object} item Miembro canónico. @returns {Object} Identidad y membresía pública. */
        (item) =>
          pick(item, [
            'userCode',
            'name',
            'email',
            'isAdmin',
            'actorType',
            'agentCode',
            'joinedSequence',
          ]),
      ),
    };
  if (operation === 'chat-history')
    return {
      items   : result.items.map(message),
      hasMore : result.hasMore,
    };
  if (operation === 'chat-send') return message(result);
  if (operation === 'chat-upload') return attachment(result);
  if (operation === 'chat-download') return pick(result, ['tempFilePath', 'name', 'mime', 'size']);
  if (operation === 'chat-add-operator') return pick(result, ['conversationCode']);
  return pick(result, ['runCode', 'status', 'errorCode', 'cancelRequested', 'resultAvailability']);
}
module.exports = { metaPlatformPresenter };
