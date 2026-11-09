/** @file Adaptación del SDK MCP a herramientas explícitas y servicios de aplicación. */
'use strict';
const { McpServer, fromJsonSchema, createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler }                               = require('@modelcontextprotocol/node');
const { AjvJsonSchemaValidator }                      = require('@modelcontextprotocol/server/validators/ajv');
const { lazySchemaValidator }                         = require('./lazy-schema-validator');
const schemaValidator                                 = lazySchemaValidator(new AjvJsonSchemaValidator());
/** @param {Object} value Contrato JSON público. @returns {Object} Esquema SDK con validación íntegra bajo demanda. */
function schema(value) {
  return fromJsonSchema(value, schemaValidator);
}
const {
  toolOutput,
  publicValue,
  toolInput,
} = require('../../modules/mcp/presenters/mcp-schema.presenter');
const tools               = require('../../modules/mcp/contracts/mcp-tools.json');
const compiledToolSchemas = new WeakMap();
const contextSchemas      = {
  inputSchema  : schema({
    type                 : 'object',
    properties           : {},
    additionalProperties : false,
  }),
  outputSchema : schema({
    type                 : 'object',
    additionalProperties : false,
    required             : ['statusCode', 'descriptionCode', 'data'],
    properties           : {
      statusCode      : { type: 'integer' },
      descriptionCode : { type: 'string' },
      data            : {
        type                 : 'object',
        additionalProperties : false,
        required             : ['userCode', 'workspaces', 'workspaceDetails', 'scopes'],
        properties           : {
          userCode         : { type: 'string' },
          workspaces       : {
            type  : 'array',
            items : { type: 'string' },
          },
          workspaceDetails : {
            type        : 'array',
            description :
              'Espacios autorizados con nombre y código. Presentar el nombre al usuario y conservar workspaceCode para operar.',
            items       : {
              type                 : 'object',
              properties           : {
                workspaceCode : { type: 'string' },
                name          : { type: 'string' },
              },
              required             : ['workspaceCode', 'name'],
              additionalProperties : false,
            },
          },
          scopes           : {
            type  : 'array',
            items : { type: 'string' },
          },
        },
      },
    },
  }),
};
/** @param {Object} endpoint Contrato canónico estable durante el proceso. @param {Object} tool Metadatos públicos de la operación. @returns {Object} Validadores reutilizables sin usuario, consentimiento ni callbacks. */
function toolSchemas(endpoint, tool) {
  let schemas = compiledToolSchemas.get(endpoint);
  if (!schemas) {
    schemas = {
      inputSchema  : schema(toolInput(endpoint, tool)),
      outputSchema : schema({
        type                 : 'object',
        properties           : {
          statusCode      : { type: 'integer' },
          descriptionCode : { type: 'string' },
          data            : toolOutput(endpoint, tool),
        },
        required             : ['statusCode', 'descriptionCode'],
        additionalProperties : false,
      }),
    };
    compiledToolSchemas.set(endpoint, schemas);
  }
  return schemas;
}
/** @param {Object} value Sobre de negocio. @returns {Object} Resultado MCP estructurado sin datos privados. */
function toolResult(value) {
  const output = publicValue(value),
    text       = JSON.stringify(output);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    return {
      isError : true,
      content : [
        {
          type : 'text',
          text : 'MCP_RESULT_TOO_LARGE: reduzca la página o los filtros.',
        },
      ],
    };
  return {
    isError           : value.statusCode >= 400,
    structuredContent : output,
    content           : [
      {
        type : 'text',
        text,
      },
    ],
  };
}
/** @param {Object} options Contratos canónicos, ejecución y conexión acreditada. @returns {Function} Handler Node sin sesión global ni efectos implícitos. */
function createMcpRequest({ contracts, execution, connection, writesEnabled }) {
  const handler = createMcpHandler(
    /** @returns {Object} Servidor aislado de una petición autenticada. */
    () => {
      const server = new McpServer({
        name    : 'xidden-commercial',
        version : '1.0.0',
      });
      server.registerTool(
        'xidden-context-get',
        {
          description :
            'Identidad pública, nombres y códigos de los espacios autorizados y capacidades. Muestre los espacios por workspaceDetails.name; use workspaceCode para operar.',
          ...contextSchemas,
          annotations : {
            readOnlyHint    : true,
            destructiveHint : false,
            openWorldHint   : false,
          },
        },
        /** @returns {Object} Contexto sin credenciales ni identificadores privados de la concesión. */
        () =>
          toolResult({
            statusCode      : 200,
            descriptionCode : 'OK',
            data            : {
              userCode         : connection.userCode,
              workspaces       : connection.workspaces,
              workspaceDetails : connection.workspaceDetails || [],
              scopes           : connection.scopes,
            },
          }),
      );
      for (const tool of tools) {
        if (
          (tool.write && !writesEnabled) ||
          !tool.scopes.every(
            /** @param {string} scope Capacidad. @returns {boolean} Incluida en la conexión. */
            (scope) => connection.scopes.includes(scope),
          )
        )
          continue;
        const canonical = contracts[tool.service]?.endpoints.find(
          /** @param {Object} entry Contrato. @returns {boolean} Nombre canónico permitido. */
          (entry) => entry.name === (tool.action || tool.name),
        );
        const endpoint  = canonical;
        if (!endpoint?.successData) throw new Error(`MCP_CONTRACT_UNAVAILABLE:${tool.name}`);
        server.registerTool(
          tool.name,
          {
            description : endpoint.description || tool.name,
            ...toolSchemas(endpoint, tool),
            annotations : {
              readOnlyHint    : !tool.write,
              destructiveHint : tool.write,
              idempotentHint  :
                !tool.write ||
                tool.canonicalIdempotency ||
                ['service-customer', 'service-product'].includes(tool.service) ||
                tool.durable === true,
              openWorldHint   :
                tool.name.endsWith('-deliver') ||
                tool.name.endsWith('-share') ||
                ['chat-send', 'chat-product-send'].includes(tool.name),
            },
          },
          /** @param {Object} args Argumentos validados por JSON Schema. @returns {Promise<Object>} Resultado acreditado o error público explícito. */
          async (args) => {
            try {
              return toolResult(
                await execution.execute(
                  {
                    ...tool,
                    workspaceField :
                      endpoint.request.required?.includes('workspace') ||
                      tool.name === 'user-directory-get-list',
                  },
                  args,
                  connection,
                ),
              );
            } catch (error) {
              return toolResult({
                statusCode      : error.statusCode || 503,
                descriptionCode : error.descriptionCode || 'MCP_SERVICE_UNAVAILABLE',
              });
            }
          },
        );
      }
      return server;
    },
    { maxRequestBodySize: 1024 * 1024 },
  );
  const handle  = toNodeHandler(handler, { maxRequestBodySize: 1024 * 1024 });
  /** @param {Object} req Solicitud Express. @param {Object} res Respuesta Express. @returns {Promise<void>} Libera los recursos del SDK al finalizar. */
  return async (req, res) => {
    try {
      await handle(req, res, req.body);
    } finally {
      await handler.close();
    }
  };
}
module.exports = {
  createMcpRequest,
  toolResult,
};
