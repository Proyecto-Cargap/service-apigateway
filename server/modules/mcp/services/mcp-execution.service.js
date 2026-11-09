/** @file Ejecuta herramientas comerciales con consentimiento, contexto independiente y contratos canónicos. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies RPC, resolución de principal, reloj y auditoría mínimos. @returns {Object} Ejecutor sin SDK ni persistencia de negocio. */
function mcpExecution({
  request,
  resolve,
  audit,
  clock,
  writesEnabled,
  identifier,
  transfer,
  requestIdentifier,
}) {
  return {
    /** @param {Object} tool Metadatos de una operación permitida. @param {Object} args Entrada validada. @param {Object} connection Token acreditado. @returns {Promise<Object>} Sobre de negocio confirmado; nunca reintenta efectos. */
    async execute(tool, args, connection) {
      const principal = await resolve({
        grantCode : connection.grantCode,
        clientId  : connection.clientId,
        ...(args.workspaceCode ? { workspace: args.workspaceCode } : {}),
      });
      if (tool.service === 'service-projects' && principal.projectsAuthorization !== 'team')
        throw new ApplicationError(403, 'OAUTH_PROJECTS_REAUTHORIZATION_REQUIRED');
      if (!principal.workspace) throw new ApplicationError(400, 'MCP_WORKSPACE_REQUIRED');
      if (
        !tool.scopes.every(
          /** @param {string} scope Capacidad requerida. @returns {boolean} Concedida en token y conexión. */
          (scope) => principal.scopes.includes(scope) && connection.scopes.includes(scope),
        )
      )
        throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
      if (tool.write && !writesEnabled) throw new ApplicationError(403, 'MCP_WRITES_DISABLED');
      const { workspaceCode, idempotencyKey, ...data } = args;
      const context                                    = {
        user       : { userCode: principal.userCode },
        workspace  : principal.workspace,
        workspaces : principal.workspaces,
        policies   : principal.policies,
        delegation : {
          grantCode : principal.grantCode,
          clientId  : principal.clientId,
        },
        ...(tool.write
          ? {
              operation : {
                idempotencyKey,
                name : tool.name,
              },
            }
          : {}),
      };
      if (tool.requestIdFor)
        data.requestId = requestIdentifier(tool.requestIdFor, principal, idempotencyKey);
      if (tool.workspaceField && !tool.resourceWorkspace) data.workspace = principal.workspace;
      if (tool.canonicalIdempotency) data.idempotencyKey = idempotencyKey;
      const started       = clock();
      const operationCode = identifier ? identifier() : undefined;
      try {
        const result = await request(tool.service, tool.action || tool.name, data, context);
        await audit({
          ...(operationCode ? { operationCode } : {}),
          clientId   : principal.clientId,
          userCode   : principal.userCode,
          grantCode  : principal.grantCode,
          workspace  : principal.workspace,
          tool       : tool.name,
          statusCode : result.statusCode,
          durationMs : clock() - started,
        });
        if (tool.transfer && result.statusCode < 400)
          return {
            ...result,
            data : {
              ...result.data,
              transfer : transfer(tool, data, context),
            },
          };
        return result;
      } catch (error) {
        try {
          await audit({
            ...(operationCode ? { operationCode } : {}),
            clientId   : principal.clientId,
            userCode   : principal.userCode,
            grantCode  : principal.grantCode,
            workspace  : principal.workspace,
            tool       : tool.name,
            statusCode : 503,
            durationMs : clock() - started,
          });
        } catch {
          // El fallo de auditoría nunca convierte una escritura incierta en un error reintentable sin clave.
        }
        throw new ApplicationError(
          503,
          tool.write ? 'MCP_OPERATION_RESULT_UNKNOWN' : 'MCP_SERVICE_UNAVAILABLE',
        );
      }
    },
  };
}
module.exports = { mcpExecution };
