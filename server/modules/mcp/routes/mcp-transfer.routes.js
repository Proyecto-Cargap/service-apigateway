/** @file Transferencias privadas mediante capacidad de archivo; revalida OAuth y conserva idempotencia. */
'use strict';
const kinds                = require('../contracts/transfer-kinds.json');
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Frontera HTTP, capacidades, persistencia temporal y RPC. @returns {void} Registra rutas antes del parser general. */
function mountTransfers({ router, capabilities, resolve, request, temporaryFiles, writesEnabled }) {
  /** @param {Object} ticket Transferencia acotada. @returns {Promise<Object>} Contexto vigente para una sola operación. */
  async function authorize(ticket) {
    const principal = await resolve({
      ...ticket.context.delegation,
      workspace : ticket.context.workspace,
    });
    if (
      principal.userCode !== ticket.context.user.userCode ||
      principal.workspace !== ticket.context.workspace
    )
      throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
    if (
      !ticket.scopes.every(
        /** @param {string} scope Capacidad. @returns {boolean} Consentimiento vigente. */ (
          scope,
        ) => principal.scopes.includes(scope),
      )
    )
      throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
    if (kinds[ticket.kind]?.method === 'POST' && !writesEnabled)
      throw new ApplicationError(403, 'MCP_WRITES_DISABLED');
    return {
      ...ticket.context,
      policies   : principal.policies,
      workspaces : principal.workspaces,
    };
  }
  router.all(
    '/mcp/transfers/:kind',
    /** @param {Object} req Flujo HTTP sin parser. @param {Object} res Respuesta privada. @returns {Promise<void>} Resultado de carga o bytes descargables. */
    async (req, res) => {
      const kind = req.params.kind;
      if (!Object.hasOwn(kinds, kind)) throw new ApplicationError(404, 'MCP_TRANSFER_INVALID');
      const target = kinds[kind];
      const method = target.method;
      if (req.method !== method) return res.set('Allow', method).status(405).end();
      const match  = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '');
      const ticket = capabilities.read(match?.[1], kind);
      let context  = await authorize(ticket);
      if (method === 'POST') {
        if (
          req.get('Content-Type')?.split(';')[0] !== 'application/octet-stream' ||
          req.get('Content-Encoding')
        )
          throw new ApplicationError(415, 'MCP_TRANSFER_CONTENT_TYPE');
        if (
          req.get('Content-Length') &&
          Number(req.get('Content-Length')) !== ticket.data.byteLength
        )
          throw new ApplicationError(400, 'MCP_TRANSFER_SIZE_MISMATCH');
        req.setTimeout(300000);
        const path  = await temporaryFiles.createStream(req, ticket.data);
        let started = false;
        try {
          context = await authorize(ticket);
          started = true;
          const result = await request(
            target.service,
            target.action,
            {
              ...(kind === 'chat-upload'
                ? {
                    code      : ticket.data.code,
                    requestId : ticket.data.requestId,
                    name      : ticket.data.name,
                    size      : ticket.data.byteLength,
                    digest    : ticket.data.sha256,
                  }
                : ticket.data),
              tempFilePath : path,
            },
            context,
            300000,
          );
          await temporaryFiles.remove(path);
          return res
            .status(result.statusCode)
            .json(require('../presenters/mcp-schema.presenter').publicValue(result));
        } finally {
          if (!started) await temporaryFiles.remove(path);
        }
      }
      const result = await request(target.service, target.action, ticket.data, context, 300000);
      if (result.statusCode >= 400)
        throw new ApplicationError(result.statusCode, result.descriptionCode);
      const file = await temporaryFiles.validate(result.data.tempFilePath);
      try {
        await authorize(ticket);
      } catch (error) {
        await temporaryFiles.remove(file);
        throw error;
      }
      res.once(
        'close',
        /** @returns {void} Retira el archivo al cerrar la descarga. */ () => {
          void temporaryFiles.remove(file);
        },
      );
      res.set('Content-Type', 'application/octet-stream');
      return res.download(
        file,
        result.data.fileName || result.data.name || 'archivo',
        { dotfiles: 'deny' },
        /** @param {Error} error Fallo de transmisión. @returns {void} Limpieza y cierre sin exponer rutas. */
        (error) => {
          void temporaryFiles.remove(file);
          if (error && !res.headersSent) res.status(503).json({ error: 'MCP_TRANSFER_FAILED' });
        },
      );
    },
  );
}
module.exports = { mountTransfers };
