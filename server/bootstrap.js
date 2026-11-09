/** @file Composición del servidor, salud y cierre; importar no inicia listeners ni conexiones. */
'use strict';
/**
 * Compone createApplication con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: messaging, telemetry, env, processRef.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createApplication({ messaging, telemetry, env = process.env, processRef = process }) {
  const host             = require('./shared/loopback-host').loopbackHost(
    env.APIGATEWAY_HOST,
    'APIGATEWAY_HOST',
  );
  const express          = require('express');
  const app              = express();
  const temporaryFiles   = require('./adapters/files/temporary-files').createTemporaryFiles({
    root   : env.TEMP,
    logger : telemetry.logger,
  });
  const mcpConfiguration = require('./adapters/mcp/mcp-config').mcpConfig(env);
  if (mcpConfiguration)
    app.use(
      require('./modules/mcp/routes/mcp.routes').mcpRoutes({
        config   : mcpConfiguration,
        messaging,
        temporaryFiles,
        logger   : telemetry.logger,
        sessions : require('./adapters/http/session-authentication').sessionAuthentication({
          messaging,
        }),
      }),
    );
  /**
   * Prepara el servidor y coordina su arranque con las dependencias del servicio.
   */

  /**
   * Configura las cabeceras de acceso HTTP y continúa con el siguiente middleware.
   *
   * @param {Object} req Solicitud Express con cuerpo, parámetros, consulta y contexto de acceso.
   * @param {Object} res Respuesta Express utilizada para completar la petición HTTP.
   * @param {Function} next Continuación de la cadena de middleware.
   * @returns {*} Resultado del envío de la respuesta HTTP.
   */
  app.use(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @param {Function} next Continuación de la cadena de middleware.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, If-Match, traceparent, tracestate',
      );
      res.header('Access-Control-Expose-Headers', 'ETag');
      res.header('Access-Control-Allow-Methods', 'POST, GET, PATCH, PUT, DELETE, OPTIONS');
      res.header('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    },
  );
  const response            = require('./adapters/http/response');
  const logger              = telemetry.logger;
  const identity            = require('../package.json');
  const sealMetaCredentials =
    require('./adapters/crypto/meta-request-credentials').metaRequestCredentials(
      env.CONNECT_META_ENCRYPTION_KEY,
    );
  const metaFiles           = require('./adapters/files/meta-files').metaFiles(temporaryFiles);
  app.use(
    require('./modules/connect/controllers/meta-public.controller').metaPublicController({
      messaging,
      response,
      sealMetaCredentials,
      metaFiles,
    }),
  );
  /**
   * Registra los controladores que exponen las rutas HTTP de la aplicación.
   */
  app.use(
    express.json({
      limit : '50mb',
    }),
  );

  app.use(
    express.urlencoded({
      limit          : '50mb',
      parameterLimit : 100000,
      extended       : true,
    }),
  );

  const sessions      = require('./adapters/http/session-authentication').sessionAuthentication({
    messaging,
    timeoutMs : Number(env.MQ_AUTH_TIMEOUT) || 8000,
  });
  const authorization = require('./adapters/http/authorization').createAuthorization({
    messaging,
    logger,
    response,
    sessions,
    identity,
    tokenSecret : env.SEED,
  });
  const pdfResponse   = require('./adapters/http/pdf.response').createPdfResponse({
    logger,
    response,
    temporaryFiles,
    rpcTimeoutMs : Number(env.MQ_PDF_TIMEOUT) || 60000,
  });
  app.use(
    require('./adapters/http/routes').createRoutes({
      messaging,
      logger,
      identity,
      response,
      authorization,
      pdfResponse,
      desktopReleaseFiles : require('./adapters/files/desktop-release.files').desktopReleaseFiles(
        env.DESKTOP_RELEASE_ROOT || '/var/lib/xidden-desktop-documents',
      ),
      temporaryFiles,
      sealMetaCredentials,
      env,
    }),
  );
  app.use(require('./adapters/http/errors').handleError);
  const lifecycle = messaging;
  let listener;
  const checkHttpHealth = require('./adapters/http/health').registerHttpHealth({
    messaging   : lifecycle,
    connection  : require('./adapters/mongodb/connection').connection,
    /**
     * Devuelve el listener HTTP actual para comprobar si el gateway acepta conexiones.
     * @returns {*} Valor de listener obtenido por esta operación.
     */
    getListener : () => listener,
    releaseFile : require('node:path').resolve(__dirname, '../release.json'),
  });
  telemetry.attachHealth(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async () => (await checkHttpHealth()).data,
    {
      components : ['database', 'messaging', 'http'],
    },
  );
  lifecycle.installShutdown(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} options Colaboradores u opciones: deadlineAt.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async ({ deadlineAt }) => {
      const cleanup = temporaryFiles.close();
      await new Promise(
        /**
         * Coordina la resolución o el rechazo de la operación asíncrona.
         * @param {Function} resolve Continuación que confirma el resultado de la promesa.
         * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (resolve) => {
          if (!listener) {
            resolve();
            return;
          }
          const timer = setTimeout(
            /**
             * Ejecuta la continuación cuando vence el intervalo configurado.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              listener.closeAllConnections();
              resolve();
            },
            Math.max(0, deadlineAt - Date.now()),
          );
          timer.unref();
          listener.close(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              clearTimeout(timer);
              resolve();
            },
          );
        },
      );
      await cleanup;
    },
  );
  /**
   * Inicia el componente y sus colaboradores.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const start = () =>
    lifecycle
      .start()
      .then(
        /**
         * Procesa el resultado de la operación asíncrona.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => temporaryFiles.start(),
      )
      .then(
        /**
         * Procesa el resultado de la operación asíncrona.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () =>
          new Promise(
            /**
             * Coordina la resolución o el rechazo de la operación asíncrona.
             * @param {Function} resolve Continuación que confirma el resultado de la promesa.
             * @param {Function} reject Continuación que rechaza la promesa con su causa.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            (resolve, reject) => {
              listener = app.listen(
                env.PORT_APIGATEWAY,
                host,

                /**
                 * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                 * @param {Error} error Fallo recibido por la continuación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (error) => {
                  if (error) return reject(error);
                  listener.removeListener('error', reject);
                  resolve();
                },
              );
              listener.once('error', reject);
            },
          ),
      )
      .catch(
        /**
         * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
         * @param {Error} error Fallo recibido por la continuación.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async (error) => {
          telemetry.logger.error({
            component : 'service',
            event     : 'startup_failed',
            code      : error.code || 'STARTUP_FAILED',
          });
          await lifecycle.close().catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
          processRef.exitCode = 1;
        },
      );

  return {
    start,

    /**
     * Cierra el componente y libera sus recursos.
     * @param {Object} options Opciones que delimitan el comportamiento de la operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    close : (options) => lifecycle.close(options),
  };
}
module.exports = { createApplication };
