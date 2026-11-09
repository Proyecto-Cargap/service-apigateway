/** @file OAuth y MCP HTTP reales con proveedor y SDK oficiales, sin cuentas ni servicios remotos. */
'use strict';
const test          = require('node:test');
const assert        = require('node:assert/strict');
const crypto        = require('node:crypto');
const express       = require('express');
const { mcpRoutes } = require('../server/modules/mcp/routes/mcp.routes');
const tools         = require('../server/modules/mcp/contracts/mcp-tools.json');
/** @returns {Promise<Object>} Servidor efímero con almacenamiento privado sintético y captura de RPC comercial. */
async function fixture() {
  const records = new Map(),
    grants      = new Map(),
    calls       = [],
    cookies     = new Map();
  const app    = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(
    /** @param {Function} resolve Notificación de escucha. @returns {void} Espera sólo el listener propio. */ (
      resolve,
    ) => server.once('listening', resolve),
  );
  const local  = 'http://127.0.0.1:' + server.address().port;
  const origin = local.replace('http:', 'https:');
  const key    = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'jwk' });
  const scopes = [
    ...new Set(
      tools.flatMap(
        /** @param {Object} entry Herramienta. @returns {string[]} Capacidades. */ (entry) =>
          entry.scopes,
      ),
    ),
  ];
  const config = {
    resource       : origin + '/mcp',
    issuer         : origin + '/oauth',
    webOrigin      : 'https://web.example.test',
    allowedOrigins : ['https://web.example.test'],
    cookieKeys     : ['synthetic-cookie-secret-with-at-least-32-characters'],
    jwks           : {
      keys : [
        {
          ...key,
          kid : 'test',
          use : 'sig',
          alg : 'RS256',
        },
      ],
    },
    clients        : [],
    writesEnabled  : true,
    scopes,
  };
  /** @param {string} name Acción privada. @param {Object} data DTO. @param {Object} context Principal. @returns {Object} Estado simulado con consumo exclusivo y vencimiento. */
  function security(name, data, context) {
    const id = data.model + ':' + data.id;
    if (name === 'oauth-storage-put') {
      records.set(id, {
        ...data,
        consumed  : records.get(id)?.consumed,
        expiresAt : Date.now() + data.ttl * 1000,
      });
      return { ok: true };
    }
    if (name === 'oauth-storage-get') {
      const row = data.id
        ? records.get(id)
        : [...records.values()].find(
            /** @param {Object} entry Artefacto. @returns {boolean} UID y modelo exactos. */ (
              entry,
            ) => entry.uid === data.uid && entry.model === data.model,
          );
      return {
        record :
          row && row.expiresAt > Date.now()
            ? {
                payload  : row.payload,
                consumed : row.consumed || 0,
              }
            : null,
      };
    }
    if (name === 'oauth-storage-destroy') {
      records.delete(id);
      return { ok: true };
    }
    if (name === 'oauth-storage-consume') {
      const row = records.get(id);
      if (!row || row.consumed || row.expiresAt <= Date.now()) return { consumed: false };
      row.consumed = Math.floor(Date.now() / 1000);
      return { consumed: true };
    }
    if (name === 'oauth-execution-record') return { ok: true };
    if (name === 'oauth-client-authorize') return { ok: true };
    if (name === 'oauth-account-get') return { userCode: data.userCode };
    if (name === 'oauth-grant-create') {
      grants.set(data.grantCode, {
        ...data,
        userCode : context.user.userCode,
        active   : true,
      });
      return data;
    }
    if (name === 'oauth-family-revoke' || name === 'oauth-grant-revoke') {
      const grant = grants.get(data.grantCode);
      if (grant) grant.active = false;
      for (const [key, row] of records) if (row.grantId === data.grantCode) records.delete(key);
      return { ok: true };
    }
    if (name === 'oauth-principal-resolve') {
      const grant = grants.get(data.grantCode);
      if (!grant?.active || grant.clientId !== data.clientId)
        throw Object.assign(new Error('revoked'), {
          statusCode      : 401,
          descriptionCode : 'OAUTH_CONNECTION_REVOKED',
        });
      if (data.workspace && !grant.workspaces.includes(data.workspace))
        throw Object.assign(new Error('scope'), {
          statusCode      : 403,
          descriptionCode : 'OAUTH_WORKSPACE_FORBIDDEN',
        });
      return {
        ...grant,
        workspace : data.workspace || (grant.workspaces.length === 1 ? grant.workspaces[0] : ''),
        ...(data.includeWorkspaceDetails
          ? {
              workspaceDetails : grant.workspaces.map(
                /** @param {string} workspaceCode Espacio autorizado. @returns {Object} Referencia canónica pública sintética. */
                (workspaceCode) => ({
                  workspaceCode,
                  name : workspaceCode === 'W1' ? 'Corporativo' : 'Ventas',
                }),
              ),
            }
          : {}),
        policies  : ['customer.customer.view.global'],
        expiresAt : Date.now() + 86400000,
      };
    }
    throw new Error('Unexpected action ' + name);
  }
  app.use(
    mcpRoutes({
      config,
      logger    : { /** @returns {void} No publica datos de prueba. */ info() {} },
      sessions  : {
        /** @param {string} token Sesión sintética. @returns {Object} Principal humano. */ async authenticate(
          token,
        ) {
          assert.equal(token, 'human-session');
          return {
            userCode        : 'U1',
            sessionCode     : 'S1',
            activeWorkspace : 'W1',
            workspaces      : ['W1', 'W2'],
            policies        : [],
          };
        },
      },
      messaging : {
        /** @param {string} service Destino. @param {string} name Acción. @param {Object} data DTO. @param {Object} options Contexto. @returns {Promise<Object>} Doble de frontera RPC, nunca sustituye el SDK OAuth/MCP. */ async request(
          service,
          name,
          data,
          options,
        ) {
          if (name === 'service-contracts-get')
            return {
              statusCode : 200,
              data       : {
                endpoints : tools
                  .filter(
                    /** @param {Object} entry Herramienta. @returns {boolean} Productor. */ (
                      entry,
                    ) => entry.service === service,
                  )
                  .map(
                    /** @param {Object} entry Herramienta. @returns {Object} Contrato cerrado mínimo para el protocolo. */ (
                      entry,
                    ) => ({
                      name        : entry.name,
                      request     : {
                        type                 : 'object',
                        properties           : {},
                        additionalProperties : false,
                      },
                      successData : {
                        type                 : 'object',
                        properties           : { ok: { type: 'boolean' } },
                        additionalProperties : false,
                      },
                    }),
                  ),
              },
            };
          try {
            if (service === 'service-security' && name.startsWith('oauth-'))
              return {
                statusCode : 200,
                data       : security(name, data, options.context),
              };
          } catch (error) {
            return {
              statusCode      : error.statusCode || 500,
              descriptionCode : error.descriptionCode,
            };
          }
          calls.push({
            service,
            name,
            data,
            context : options.context,
          });
          return {
            statusCode      : 200,
            descriptionCode : 'OK',
            data            : { ok: true },
          };
        },
      },
    }),
  );
  /** @param {string} path Ruta pública. @param {Object} options Opciones fetch. @returns {Promise<Response>} HTTP local, cookies del proveedor y host HTTPS acreditado por proxy. */
  async function request(path, options = {}) {
    const response = await fetch(path.replace(origin, local).replace(/^\//, local + '/'), {
      redirect : 'manual',
      ...options,
      headers  : {
        'X-Forwarded-Proto' : 'https',
        Cookie              : [...cookies]
          .map(
            /** @param {Array} pair Cookie. @returns {string} Par. */ ([name, value]) =>
              name + '=' + value,
          )
          .join('; '),
        ...options.headers,
      },
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0],
        index    = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  /** @param {string} path Ruta. @param {Object} body DTO. @returns {Promise<Response>} Consentimiento autenticado. */
  function human(path, body) {
    return request(path, {
      method  : body ? 'POST' : 'GET',
      headers : {
        Authorization  : 'Bearer human-session',
        'Content-Type' : 'application/json',
        Origin         : config.webOrigin,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  /** @param {Object} fields Formulario OAuth. @returns {Promise<Response>} Endpoint real de tokens. */
  function token(fields) {
    return request('/oauth/token', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body    : new URLSearchParams({
        client_id : 'assistant',
        ...fields,
      }),
    });
  }
  /** @param {string} scope Capacidades OAuth, con OIDC opcional. @param {string} prompt Indicación opcional del cliente. @param {string} redirectUri Retorno exacto registrado. @param {string[]} consentScopes Capacidades elegidas por la persona. @returns {Promise<Object>} Código aprobado mediante pantalla y cookie real del proveedor. */
  async function authorize(
    scope = 'openid offline_access customer:read customer:write',
    prompt = 'consent',
    redirectUri = 'https://assistant.example.test/callback',
    consentScopes = ['customer:read'],
  ) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params   = new URLSearchParams({
      client_id             : 'assistant',
      redirect_uri          : redirectUri,
      response_type         : 'code',
      scope,
      resource              : config.resource,
      code_challenge_method : 'S256',
      code_challenge        : crypto.createHash('sha256').update(verifier).digest('base64url'),
      state                 : 'test-state',
    });
    if (prompt) params.set('prompt', prompt);
    const begin = await request('/oauth/auth?' + params);
    assert.equal(begin.status, 303, await begin.text());
    const uid = new URL(begin.headers.get('location')).searchParams.get('interaction');
    assert.ok(uid);
    const details = await human('/mcp-access/interactions/' + uid);
    assert.equal(details.status, 200, await details.clone().text());
    assert.deepEqual((await details.json()).workspaces, ['W1', 'W2']);
    const decision = await human('/mcp-access/interactions/' + uid, {
      scopes     : consentScopes,
      workspaces : ['W1', 'W2'],
    });
    assert.equal(decision.status, 200, await decision.clone().text());
    const resume = await request((await decision.json()).redirect);
    assert.equal(resume.status, 303, await resume.text());
    const callback = new URL(resume.headers.get('location'));
    assert.equal(callback.origin, new URL(redirectUri).origin);
    assert.equal(callback.searchParams.get('error'), null, callback.href);
    assert.equal(callback.searchParams.get('iss'), config.issuer);
    const code = callback.searchParams.get('code');
    assert.ok(code);
    return {
      code,
      verifier,
    };
  }
  return {
    request,
    human,
    token,
    authorize,
    config,
    records,
    grants,
    calls,
    /** @returns {Promise<void>} Cierre de listener exclusivo. */ async close() {
      server.closeAllConnections();
      await new Promise(
        /** @param {Function} resolve Cierre. @returns {void} Libera recursos. */ (resolve) =>
          server.close(resolve),
      );
    },
  };
}
test('OAuth PKCE, consentimiento reducido, MCP HTTP, rotación y revocación de familia', /** @param {Object} t Ciclo de prueba. @returns {Promise<void>} Interoperabilidad local con proveedores reales. */ async (t) => {
  const f = await fixture();
  t.after(f.close);
  const resource = await f.request('/.well-known/oauth-protected-resource/mcp');
  assert.equal((await resource.json()).resource, f.config.resource);
  const registered = await f.human('/mcp-access/clients', {
    clientId     : 'assistant',
    name         : 'Asistente de prueba',
    redirectUris : ['https://assistant.example.test/callback'],
  });
  assert.equal(registered.status, 201, await registered.text());
  const native = await f.human('/mcp-access/clients', {
    clientId     : 'codex-native',
    name         : 'Codex de prueba',
    redirectUris : ['http://127.0.0.1:43127/callback'],
  });
  assert.equal(native.status, 201, await native.text());
  const nativeParams = new URLSearchParams({
    client_id             : 'codex-native',
    redirect_uri          : 'http://127.0.0.1:43127/callback',
    response_type         : 'code',
    scope                 : 'customer:read',
    resource              : f.config.resource,
    code_challenge_method : 'S256',
    code_challenge        : crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'),
  });
  nativeParams.append('resource', f.config.resource);
  const nativeBegin = await f.request('/oauth/auth?' + nativeParams);
  assert.equal(nativeBegin.status, 303, await nativeBegin.text());
  nativeParams.set('redirect_uri', 'http://127.0.0.1:43128/callback');
  assert.equal((await f.request('/oauth/auth?' + nativeParams)).status, 303);
  for (const redirect of [
    'http://127.0.0.1:43128/another',
    'http://localhost:43128/callback',
    'http://127.0.0.1:43128/callback?unexpected=1',
  ]) {
    nativeParams.set('redirect_uri', redirect);
    assert.equal((await f.request('/oauth/auth?' + nativeParams)).status, 400);
  }
  const denied = await f.request('/mcp', { headers: { Authorization: 'Bearer human-session' } });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata/);
  const badOrigin = await f.request('/mcp', {
    headers : { Origin: 'https://untrusted.example.test' },
  });
  assert.equal(badOrigin.status, 403);
  const wrongRedirect = await f.request(
    '/oauth/auth?' +
      new URLSearchParams({
        client_id     : 'assistant',
        redirect_uri  : 'https://assistant.example.test/callback/extra',
        response_type : 'code',
      }),
  );
  assert.equal(wrongRedirect.status, 400);
  const unknownPath = await f.request('/mcp/unknown');
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.headers.get('access-control-allow-origin'), null);
  const first = await f.authorize();
  assert.ok(
    [...f.records.values()].some(
      /** @param {Object} record Artefacto del proveedor. @returns {boolean} Vigencia exigida para un código. */
      (record) => record.model === 'AuthorizationCode' && record.ttl === 60,
    ),
  );
  const wrong = await f.token({
    grant_type    : 'authorization_code',
    code          : first.code,
    code_verifier : 'wrong'.repeat(12),
    redirect_uri  : 'https://assistant.example.test/callback',
  });
  assert.equal(wrong.status, 400);
  const second   = await f.authorize();
  const exchange = await f.token({
    grant_type    : 'authorization_code',
    code          : second.code,
    code_verifier : second.verifier,
    redirect_uri  : 'https://assistant.example.test/callback',
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const access      = await exchange.json();
  const refreshRows = [...f.records.values()].filter(
    /** @param {Object} record Artefacto. @returns {boolean} Token de renovación. */
    (record) => record.model === 'RefreshToken',
  );
  assert.ok(
    refreshRows.every(
      /** @param {Object} record Artefacto. @returns {boolean} Nunca supera treinta días. */
      (record) => record.ttl > 0 && record.ttl <= 2592000,
    ),
  );
  assert.ok(access.refresh_token);
  assert.equal(access.expires_in, 600);
  assert.equal(access.scope, 'customer:read');
  /** @param {string} method Método MCP. @param {Object} params Entrada. @param {string} revision Protocolo negociado. @returns {Promise<Object>} Mensaje JSON desde SSE o JSON. */
  async function mcp(method, params, revision = '2025-11-25') {
    const modern   = revision === '2026-07-28';
    const response = await f.request('/mcp', {
      method  : 'POST',
      headers : {
        Authorization          : 'Bearer ' + access.access_token,
        'Content-Type'         : 'application/json',
        Accept                 : 'application/json, text/event-stream',
        'MCP-Protocol-Version' : revision,
        ...(modern ? { 'Mcp-Method': method } : {}),
        ...(modern && method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
      },
      body    : JSON.stringify({
        jsonrpc : '2.0',
        id      : 1,
        method,
        params  : {
          ...params,
          ...(modern
            ? {
                _meta : {
                  'io.modelcontextprotocol/protocolVersion'    : revision,
                  'io.modelcontextprotocol/clientCapabilities' : {},
                  'io.modelcontextprotocol/clientInfo'         : {
                    name    : 'test',
                    version : '1',
                  },
                },
              }
            : {}),
        },
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text();
    return JSON.parse(
      response.headers.get('content-type')?.includes('text/event-stream')
        ? raw
            .split('\n')
            .find(
              /** @param {string} line Línea SSE. @returns {boolean} Datos. */ (line) =>
                line.startsWith('data:'),
            )
            .slice(5)
        : raw,
    );
  }
  const init = await mcp('initialize', {
    protocolVersion : '2025-11-25',
    capabilities    : {},
    clientInfo      : {
      name    : 'test',
      version : '1',
    },
  });
  assert.equal(init.result.serverInfo.name, 'xidden-commercial');
  const list = await mcp('tools/list', {});
  assert.ok(
    list.result.tools.some(
      /** @param {Object} tool Herramienta. @returns {boolean} Referencia esperada. */ (tool) =>
        tool.name === 'customer-get-list',
    ),
  );
  assert.ok(
    list.result.tools.every(
      /** @param {Object} tool Herramienta. @returns {boolean} Consentimiento reducido. */ (tool) =>
        !tool.name.endsWith('-create'),
    ),
  );
  const missing = await mcp('tools/call', {
    name      : 'customer-get-list',
    arguments : {},
  });
  const context = await mcp('tools/call', {
    name      : 'xidden-context-get',
    arguments : {},
  });
  assert.deepEqual(context.result.structuredContent.data.workspaceDetails, [
    {
      workspaceCode : 'W1',
      name          : 'Corporativo',
    },
    {
      workspaceCode : 'W2',
      name          : 'Ventas',
    },
  ]);
  assert.deepEqual(context.result.structuredContent.data.workspaces, ['W1', 'W2']);
  assert.equal(missing.result.structuredContent.descriptionCode, 'MCP_WORKSPACE_REQUIRED');
  const called = await mcp('tools/call', {
    name      : 'customer-get-list',
    arguments : { workspaceCode: 'W2' },
  });
  assert.equal(called.result.isError, false);
  assert.equal(f.calls.at(-1).context.workspace, 'W2');
  assert.equal(f.calls.at(-1).context.delegation.clientId, 'assistant');
  const forbidden = await mcp('tools/call', {
    name      : 'customer-get-list',
    arguments : { workspaceCode: 'W3' },
  });
  assert.equal(forbidden.result.isError, true);
  const discovered = await mcp('server/discover', {}, '2026-07-28');
  assert.deepEqual(discovered.result.supportedVersions, ['2026-07-28']);
  const modernList = await mcp('tools/list', {}, '2026-07-28');
  assert.deepEqual(modernList.result.tools, list.result.tools);
  const modernCall = await mcp(
    'tools/call',
    {
      name      : 'customer-get-list',
      arguments : { workspaceCode: 'W1' },
    },
    '2026-07-28',
  );
  assert.equal(modernCall.result.isError, false);
  assert.equal(f.calls.at(-1).context.workspace, 'W1');
  assert.equal(f.calls.at(-1).context.delegation.clientId, 'assistant');
  const modernInvalid = await f.request('/mcp', {
    method  : 'POST',
    headers : {
      Authorization          : 'Bearer ' + access.access_token,
      'Content-Type'         : 'application/json',
      Accept                 : 'application/json, text/event-stream',
      'MCP-Protocol-Version' : '2026-07-28',
      'Mcp-Method'           : 'tools/list',
    },
    body    : JSON.stringify({
      jsonrpc : '2.0',
      id      : 1,
      method  : 'tools/list',
      params  : {},
    }),
  });
  assert.equal(modernInvalid.status, 400);
  assert.match((await modernInvalid.json()).error.message, /envelope/);
  const rotate = await f.token({
    grant_type    : 'refresh_token',
    refresh_token : access.refresh_token,
  });
  assert.equal(rotate.status, 200, await rotate.clone().text());
  const rotated = await rotate.json();
  assert.notEqual(rotated.refresh_token, access.refresh_token);
  const reused = await f.token({
    grant_type    : 'refresh_token',
    refresh_token : access.refresh_token,
  });
  assert.equal(reused.status, 400);
  const revoked = await f.request('/mcp', {
    headers : { Authorization: 'Bearer ' + rotated.access_token },
  });
  assert.equal(revoked.status, 401);
  const oauthOnly = await f.authorize('customer:read');
  const connected = await f.token({
    grant_type    : 'authorization_code',
    code          : oauthOnly.code,
    code_verifier : oauthOnly.verifier,
    redirect_uri  : 'https://assistant.example.test/callback',
  });
  assert.equal(connected.status, 200, await connected.clone().text());
  const pure = await connected.json();
  assert.equal(pure.id_token, undefined);
  assert.equal(pure.refresh_token, undefined);
  assert.ok(pure.access_token);
});

test('cliente nativo sin prompt conserva renovación sólo después del consentimiento explícito', /** @param {Object} t Ciclo aislado. @returns {Promise<void>} Reproduce la solicitud OAuth de Codex. */ async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.human('/mcp-access/clients', {
    clientId     : 'assistant',
    name         : 'Cliente sin prompt',
    redirectUris : ['http://127.0.0.1:43127/callback'],
  });
  const authorization = await f.authorize(
    'openid offline_access customer:read',
    '',
    'http://127.0.0.1:43128/callback',
  );
  const response      = await f.token({
    grant_type    : 'authorization_code',
    code          : authorization.code,
    code_verifier : authorization.verifier,
    redirect_uri  : 'http://127.0.0.1:43128/callback',
    resource      : f.config.resource,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(typeof result.refresh_token, 'string');
  assert.equal(result.expires_in, 600);
});

test('OAuth acepta su formulario de cierre de sesión sin ampliar los orígenes de MCP', /** @param {Object} t Ciclo aislado. @returns {Promise<void>} Reproduce el formulario del proveedor, CSRF y la reconexión posterior. */ async (t) => {
  const f = await fixture();
  t.after(f.close);
  const issuerOrigin = new URL(f.config.issuer).origin;
  const registered   = await f.human('/mcp-access/clients', {
    clientId     : 'assistant',
    name         : 'Reconexión de prueba',
    redirectUris : ['http://127.0.0.1:43127/callback'],
  });
  assert.equal(registered.status, 201);
  for (const authenticated of [false, true]) {
    if (authenticated)
      await f.authorize(
        'openid offline_access customer:read',
        '',
        'http://127.0.0.1:43127/callback',
      );
    const page = await f.request('/oauth/session/end');
    assert.equal(page.status, 200);
    const html = await page.text();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(xsrf);
    /** @param {string} origin Origen del navegador. @param {string} secret Valor CSRF. @returns {Promise<Response>} Formulario real del proveedor. */
    function confirm(origin, secret = xsrf) {
      return f.request('/oauth/session/end/confirm', {
        method  : 'POST',
        headers : {
          Origin         : origin,
          'Content-Type' : 'application/x-www-form-urlencoded',
        },
        body    : new URLSearchParams({
          xsrf   : secret,
          logout : 'yes',
        }),
      });
    }
    for (const origin of [
      'https://untrusted.example.test',
      'null',
      issuerOrigin + '.untrusted.test',
    ]) {
      const rejected = await confirm(origin);
      assert.equal(rejected.status, 403);
      assert.deepEqual(await rejected.json(), { error: 'MCP_ORIGIN_FORBIDDEN' });
      assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    }
    const missingCsrf = await confirm(issuerOrigin, '');
    assert.equal(missingCsrf.status, 400);
    assert.equal((await missingCsrf.json()).error, 'invalid_request');
    assert.equal((await confirm(issuerOrigin, 'invalid-xsrf')).status, 400);
    const completed = await confirm(issuerOrigin);
    assert.equal(completed.status, 303, await completed.text());
    assert.equal(new URL(completed.headers.get('location')).pathname, '/oauth/session/end/success');
    assert.equal(completed.headers.get('cache-control'), 'no-store');
    assert.equal((await confirm(issuerOrigin)).status, 400);
  }
  const target = new URL('/oauth/session/end/confirm', f.config.issuer);
  target.protocol = 'http:';
  const wrongHost = await new Promise(
    /** @param {Function} resolve Recibe el estado HTTP. @param {Function} reject Propaga fallos del transporte. @returns {void} Usa HTTP directo porque fetch normaliza Host. */
    (resolve, reject) => {
      const request = require('node:http').request(
        target,
        {
          method  : 'POST',
          headers : {
            Host   : 'untrusted.example.test',
            Origin : issuerOrigin,
          },
        },
        /** @param {Object} response Respuesta HTTP real. @returns {void} Drena y captura el rechazo por Host. */
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    },
  );
  assert.equal(wrongHost, 403);
  for (const path of [
    '/mcp',
    '/mcp-access/connections',
    '/.well-known/oauth-protected-resource/mcp',
  ])
    assert.equal((await f.request(path, { headers: { Origin: issuerOrigin } })).status, 403);
  const next     = await f.authorize(
    'openid offline_access customer:read',
    '',
    'http://127.0.0.1:43127/callback',
  );
  const exchange = await f.token({
    grant_type    : 'authorization_code',
    code          : next.code,
    code_verifier : next.verifier,
    redirect_uri  : 'http://127.0.0.1:43127/callback',
    resource      : f.config.resource,
  });
  assert.equal(exchange.status, 200);
  assert.equal(typeof (await exchange.json()).refresh_token, 'string');
});

test('MCP documental inicializa los contratos de todos sus productores antes de exponer contexto y ventanas', /** @param {Object} t Ciclo aislado. @returns {Promise<void>} Reproduce la conexión documental con OAuth y SDK reales, sin negocio remoto. */ async (t) => {
  const f = await fixture();
  t.after(f.close);
  const registered = await f.human('/mcp-access/clients', {
    clientId     : 'assistant',
    name         : 'Cliente documental de prueba',
    redirectUris : ['https://assistant.example.test/callback'],
  });
  assert.equal(registered.status, 201);
  const approved = await f.authorize(
    'documents:read',
    'consent',
    'https://assistant.example.test/callback',
    ['documents:read'],
  );
  const exchange = await f.token({
    grant_type    : 'authorization_code',
    code          : approved.code,
    code_verifier : approved.verifier,
    redirect_uri  : 'https://assistant.example.test/callback',
  });
  assert.equal(exchange.status, 200);
  const access = await exchange.json();
  for (const [method, params] of [
    [
      'tools/call',
      {
        name      : 'xidden-context-get',
        arguments : {},
      },
    ],
    ['tools/list', {}],
  ]) {
    const response = await f.request('/mcp', {
      method  : 'POST',
      headers : {
        Authorization          : 'Bearer ' + access.access_token,
        'Content-Type'         : 'application/json',
        Accept                 : 'application/json, text/event-stream',
        'MCP-Protocol-Version' : '2025-11-25',
      },
      body    : JSON.stringify({
        jsonrpc : '2.0',
        id      : 1,
        method,
        params,
      }),
    });
    assert.equal(response.status, 200);
    const raw     = await response.text();
    const payload = JSON.parse(
      response.headers.get('content-type').includes('text/event-stream')
        ? raw
            .split('\n')
            .find(
              /** @param {string} line Línea SSE. @returns {boolean} Mensaje JSON. */ (line) =>
                line.startsWith('data:'),
            )
            .slice(5)
        : raw,
    );
    assert.equal(payload.error, undefined, JSON.stringify(payload.error));
    if (method === 'tools/call') assert.equal(payload.result.structuredContent.statusCode, 200);
    else
      for (const name of ['documents-repository-read', 'documents-repositories-read'])
        assert.ok(
          payload.result.tools.some(
            /** @param {Object} tool Herramienta expuesta. @returns {boolean} Ventana documental estándar. */ (
              tool,
            ) => tool.name === name,
          ),
        );
  }
});
