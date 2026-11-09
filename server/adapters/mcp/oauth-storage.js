/** @file Adaptador de oidc-provider a la persistencia privada de Security mediante RPC. */
'use strict';
/** @param {Function} request RPC privado con errores acreditados. @returns {Function} Constructor requerido por oidc-provider. */
function oauthStorage(request) {
  return class OAuthStorage {
    /** @param {string} model Tipo de artefacto del proveedor. */
    constructor(model) {
      this.model = model;
    }
    /** @param {string} id Identidad privada. @param {Object} payload Estado opaco del proveedor. @param {number} expiresIn Vigencia en segundos. @returns {Promise<void>} Persistencia confirmada. */
    async upsert(id, payload, expiresIn) {
      await request('oauth-storage-put', {
        model   : this.model,
        id,
        payload : JSON.stringify(payload),
        ttl     : Math.max(1, Math.ceil(expiresIn || 315360000)),
        uid     : payload.uid || '',
        grantId : payload.grantId || '',
      });
    }
    /** @param {string} id Identidad privada. @returns {Promise<Object|undefined>} Estado vigente. */
    async find(id) {
      return this.read({ id });
    }
    /** @param {string} uid Sesión del proveedor. @returns {Promise<Object|undefined>} Estado vigente. */
    async findByUid(uid) {
      return this.read({ uid });
    }
    /** @param {Object} selector Identidad o UID. @returns {Promise<Object|undefined>} Deserialización privada sin exposición por HTTP. */
    async read(selector) {
      const { record } = await request('oauth-storage-get', {
        model : this.model,
        ...selector,
      });
      if (!record) return undefined;
      return {
        ...JSON.parse(record.payload),
        ...(record.consumed ? { consumed: record.consumed } : {}),
      };
    }
    /** @param {string} id Artefacto de un solo uso. @returns {Promise<void>} Rechaza consumo concurrente. */
    async consume(id) {
      const { consumed } = await request('oauth-storage-consume', {
        model : this.model,
        id,
      });
      if (!consumed) {
        const value = await this.find(id);
        if (value?.grantId) await this.revokeByGrantId(value.grantId);
        throw new Error('OAUTH_ARTIFACT_ALREADY_CONSUMED');
      }
    }
    /** @param {string} id Artefacto. @returns {Promise<void>} Eliminación confirmada. */
    async destroy(id) {
      await request('oauth-storage-destroy', {
        model : this.model,
        id,
      });
    }
    /** @param {string} grantId Concesión afectada. @returns {Promise<void>} Revoca también la autorización comercial. */
    async revokeByGrantId(grantId) {
      await request('oauth-family-revoke', { grantCode: grantId });
    }
  };
}
module.exports = { oauthStorage };
