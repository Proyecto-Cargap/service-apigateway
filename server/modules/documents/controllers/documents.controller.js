/**
 * @file Explorador documental por identificadores. Traduce HTTP a RPC autenticado sin aceptar
 * identidad, rutas de almacenamiento ni contexto enviados por el cliente; transmite contenido temporal.
 */
'use strict';
const path = require('node:path');

const UPLOAD_LIMIT          = 200 * 1024 * 1024;
const LIST_FIELDS           = ['search', 'type', 'sort', 'order', 'page', 'perPage'];
const PREVIEW_CONTENT_TYPES = {
  pdf  : 'application/pdf',
  txt  : 'text/plain',
  log  : 'text/plain',
  md   : 'text/plain',
  csv  : 'text/csv',
  json : 'application/json',
  xml  : 'application/xml',
  xls  : 'application/vnd.ms-excel',
  xlsx : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsm : 'application/vnd.ms-excel.sheet.macroEnabled.12',
  png  : 'image/png',
  jpg  : 'image/jpeg',
  jpeg : 'image/jpeg',
  gif  : 'image/gif',
  webp : 'image/webp',
  bmp  : 'image/bmp',
  svg  : 'image/svg+xml',
  mp4  : 'video/mp4',
  webm : 'video/webm',
  ogv  : 'video/ogg',
  ogg  : 'audio/ogg',
  mp3  : 'audio/mpeg',
  wav  : 'audio/wav',
  m4a  : 'audio/mp4',
  aac  : 'audio/aac',
};
const PREVIEW_TYPES         = new Set(Object.values(PREVIEW_CONTENT_TYPES));

/** Selecciona exclusivamente campos del contrato, sin combinar cuerpos de lectura ni contexto.
 * @param {string} source Valor de source utilizado por esta operación.
 * @param {*} fields Valor de fields utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function select(source, fields) {
  return Object.fromEntries(
    fields
      .filter(
        /**
         * Determina si el elemento cumple el criterio de selección.
         * @param {string} field Campo utilizado por la operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (field) => Object.hasOwn(source || {}, field),
      )
      .map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {string} field Campo utilizado por la operación.
         * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (field) => [field, source[field]],
      ),
  );
}

/** Convierte la revisión HTTP al entero exigido por Documents sin aceptar coerciones ambiguas.
 * @param {Object} query Campos de la URL.
 * @returns {Object} Revisión opcional tipada; los valores inválidos se rechazan antes del RPC.
 */
function revisionQuery(query) {
  if (!Object.hasOwn(query || {}, 'expectedRevision')) return {};
  const value = query.expectedRevision;
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw Object.assign(new Error('Invalid revision'), {
      statusCode      : 400,
      descriptionCode : 'INVALID_INPUT',
    });
  return { expectedRevision: Number(value) };
}

/** Recupera nombres UTF-8 recibidos como latin1 por multipart y conserva los ya decodificados.
 * @param {*} value Valor de value utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function uploadName(value) {
  if (typeof value !== 'string') return '';
  if (
    [...value].every(
      /**
       * Comprueba la condición requerida para cada elemento.
       * @param {*} character Valor de character utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (character) => character.codePointAt(0) <= 255,
    )
  ) {
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
    } catch {
      /* Un nombre Unicode ya decodificado no tiene que formar una secuencia UTF-8 en latin1. */
    }
  }
  return value.normalize('NFC');
}

/**
 * Construye los contratos de repositorios, entradas y favoritos y la transferencia autenticada.
 *
 * @param {Object} dependencies Adaptadores HTTP, RPC, temporales y autorización del gateway.
 * @param {Object} dependencies.response Adaptador del envelope público y errores HTTP.
 * @param {Object} dependencies.messaging Cliente RPC; Documents autoriza cada repositorio.
 * @param {Object} dependencies.temporaryFiles Creación, validación y limpieza confinadas a TEMP.
 * @param {Object} dependencies.authorization Middleware que acredita la sesión y req.system.
 * @param {Function} [dependencies.fileUpload] Parser multipart inyectable para pruebas.
 * @param {Object} dependencies.logger Logger técnico sin contenido ni contexto de las solicitudes.
 * @returns {import('express').Router} Rutas por identificadores; no publica contratos legacy.
 */
function documentsController(dependencies) {
  const app                                                        = require('express').Router();
  const { messaging, response, temporaryFiles: temporary, logger } = dependencies;
  const { authorizationValidation }                                = dependencies.authorization;
  const fileUpload                                                 = dependencies.fileUpload || require('express-fileupload');
  const multipart                                                  = fileUpload({
    limits            : {
      fileSize : UPLOAD_LIMIT,
      files    : 2,
    },
    abortOnLimit      : true,
    preserveExtension : true,
    /**
     * Ejecuta limitHandler dentro del flujo de documents.controller.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    limitHandler      : (req, res) => response.sendError(req, res, 413, 'DOCUMENT_FILE_TOO_LARGE'),
  });

  /**
   * Ejecuta reply dentro del flujo de documents.controller.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {*} result Valor de result utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function reply(req, res, result) {
    return result.statusCode >= 200 && result.statusCode < 300
      ? response.send(req, res, result.statusCode, result.data)
      : response.sendError(req, res, result.statusCode, result.descriptionCode);
  }

  /** Traduce errores locales sin exponer mensajes privados ni reintentar escrituras inciertas.
   * @param {Object} req Solicitud HTTP recibida por el middleware.
   * @param {Object} res Respuesta HTTP que completa la solicitud.
   * @param {Error} error Fallo recibido por la continuación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function fail(req, res, error) {
    if (res.destroyed || res.headersSent) return;
    logger.error({
      component : 'documents',
      event     : 'operation_failed',
    });
    return response.sendError(
      req,
      res,
      error?.statusCode || 500,
      error?.uncertain ? 'STORAGE_WRITE_UNCERTAIN' : error?.descriptionCode || 'OPERATION_FAILED',
    );
  }

  /** Delega sólo el payload seleccionado y usa siempre el contexto autenticado del servidor.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {*} payload Valor de payload utilizado por esta operación.
   * @param {*} [mutation] Valor de mutation utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function operation(action, payload, mutation = false) {
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    return async (req, res) => {
      try {
        const result = await messaging.request('service-documents', action, payload(req), {
          context : req.system,
          ...(mutation ? { timeoutMs: 300000 } : {}),
        });
        if (!res.destroyed) return reply(req, res, result);
      } catch (error) {
        return fail(req, res, error);
      }
    };
  }

  /**
   * POST /documents/repositories/:repositoryId/folders delega nombre y padre a MongoDB.
   * @param {import('express').Request} req Sesión autenticada, repositoryId y cuerpo {parentId,name}.
   * @param {import('express').Response} res Envelope de la carpeta o error del servicio.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-folder-create-v1.
   */
  app.post(
    '/documents/repositories/:repositoryId/folders',
    authorizationValidation,
    operation(
      'documents-folder-create',
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.body, ['parentId', 'name']),
        repositoryId : req.params.repositoryId,
      }),
      true,
    ),
  );

  /**
   * POST /documents/repositories/:repositoryId/files carga un archivo único en un temporal privado.
   * El servicio consume el temporal. Un fallo de transporte incierto conserva el archivo para el
   * consumidor tardío; los fallos ciertos y respuestas terminales liberan la copia del gateway.
   * @param {import('express').Request} req Sesión, identidad de ruta, multipart y opciones de query.
   * @param {import('express').Response} res Envelope de entrada creada/sustituida o error explícito.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-file-upload-v1.
   */
  app.post(
    '/documents/repositories/:repositoryId/files',
    authorizationValidation,
    multipart,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let file;
      let uncertain = false;
      try {
        const uploaded = req.files?.file;
        if (!uploaded || Array.isArray(uploaded) || Object.keys(req.files).length !== 1)
          throw Object.assign(new Error('Invalid upload'), {
            statusCode      : 400,
            descriptionCode : 'DOCUMENT_UPLOAD_INVALID',
          });
        if (uploaded.truncated || uploaded.size > UPLOAD_LIMIT)
          throw Object.assign(new Error('Upload limit exceeded'), {
            statusCode      : 413,
            descriptionCode : 'DOCUMENT_FILE_TOO_LARGE',
          });
        file = await temporary.createUpload(uploaded, { allowEmpty: true });
        if (res.destroyed) return;
        const result = await messaging.request(
          'service-documents',
          'documents-file-upload',
          {
            ...select(req.query, ['parentId', 'overwrite']),
            ...revisionQuery(req.query),
            repositoryId : req.params.repositoryId,
            fileName     : uploadName(uploaded.name),
            mimeType     : uploaded.mimetype || 'application/octet-stream',
            tempFilePath : file,
          },
          {
            context   : req.system,
            timeoutMs : 300000,
          },
        );
        if (!res.destroyed) return reply(req, res, result);
      } catch (error) {
        uncertain = Boolean(error?.uncertain);
        return fail(req, res, error);
      } finally {
        if (file && !uncertain) await temporary.remove(file);
      }
    },
  );

  /**
   * GET /documents/repositories obtiene raíces autorizadas y sus capacidades efectivas.
   * @param {import('express').Request} req Sesión acreditada; no recibe identidad del cliente.
   * @param {import('express').Response} res Envelope {listItem,totalCount} o error RPC.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-repositories-get-list.
   */
  app.post(
    '/documents/repositories/resolve',
    authorizationValidation,
    operation(
      'documents-repository-resolve',
      /** @param {Object} req Referencia pública del recurso. @returns {Object} Campos canónicos sin autoridad del cliente. */
      (req) => select(req.body, ['subject']),
    ),
  );
  app.get(
    '/documents/settings',
    authorizationValidation,
    operation(
      'documents-settings-get',
      /** @returns {Object} La configuración no acepta selectores de autoridad. */ () => ({}),
    ),
  );
  app.patch(
    '/documents/settings',
    authorizationValidation,
    operation(
      'documents-settings-update',
      /** @param {Object} req Edición canónica. @returns {Object} Datos y revisión originales, sin contexto del cliente. */
      (req) => select(req.body, ['data', 'expectedRevision']),
      true,
    ),
  );
  app.get(
    '/documents/repositories',
    authorizationValidation,
    operation(
      'documents-repositories-get-list',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => ({}),
    ),
  );

  /**
   * GET /documents/repositories/:repositoryId/entries lista MongoDB con filtros y paginación.
   * @param {import('express').Request} req Identidad de ruta y campos públicos de listado en query.
   * @param {import('express').Response} res Envelope con entradas, raíz, carpeta y breadcrumbs.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-entries-get-list.
   */
  app.get(
    '/documents/repositories/:repositoryId/entries',
    authorizationValidation,
    operation(
      'documents-entries-get-list',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.query, ['parentId', ...LIST_FIELDS]),
        repositoryId : req.params.repositoryId,
      }),
    ),
  );

  /**
   * Lista las entradas principales de la papelera autorizada.
   * @param {import('express').Request} req Raíz fijada por ruta y filtros públicos.
   * @param {import('express').Response} res Página con fechas de retención.
   * @returns {Promise<import('express').Response|void>} Resultado de documents-trash-get-list.
   */
  app.get(
    '/documents/repositories/:repositoryId/trash',
    authorizationValidation,
    operation(
      'documents-trash-get-list',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.query, LIST_FIELDS),
        repositoryId : req.params.repositoryId,
      }),
    ),
  );
  /**
   * Restaura una entrada y su subárbol con control de revisión.
   * @param {import('express').Request} req Identificador de ruta y expectedRevision del cuerpo.
   * @param {import('express').Response} res Entrada restaurada o conflicto autorizado.
   * @returns {Promise<import('express').Response|void>} Resultado de documents-entry-restore.
   */
  app.patch(
    '/documents/entries/:entryId/restore',
    authorizationValidation,
    operation(
      'documents-entry-restore',
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.body, ['expectedRevision', 'targetRepositoryId', 'targetParentId']),
        entryId : req.params.entryId,
      }),
      true,
    ),
  );

  /**
   * GET /documents/entries/:entryId obtiene metadata y ubicación autorizadas.
   * @param {import('express').Request} req entryId fijado por la ruta y sesión acreditada.
   * @param {import('express').Response} res Envelope con item, repository y breadcrumbs.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-entry-get-one.
   */
  app.get(
    '/documents/entries/:entryId',
    authorizationValidation,
    operation(
      'documents-entry-get-one',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        entryId : req.params.entryId,
        ...(req.query.trash === 'true' ? { trash: true } : {}),
      }),
    ),
  );

  /**
   * PATCH /documents/entries/:entryId renombra conservando identidad y referencia de contenido.
   * @param {import('express').Request} req entryId, nombre y expectedRevision en el cuerpo.
   * @param {import('express').Response} res Envelope de entrada o conflicto 409.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-entry-rename.
   */
  app.patch(
    '/documents/entries/:entryId',
    authorizationValidation,
    operation(
      'documents-entry-rename',
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.body, ['name', 'expectedRevision']),
        entryId : req.params.entryId,
      }),
      true,
    ),
  );

  /**
   * DELETE /documents/entries/:entryId envía una entrada y su subárbol a la papelera.
   * @param {import('express').Request} req entryId y expectedRevision de query; sesión acreditada.
   * @param {import('express').Response} res Envelope {deletedCount} o error del servicio.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-entry-delete.
   */
  app.delete(
    '/documents/entries/:entryId',
    authorizationValidation,
    operation(
      'documents-entry-delete',
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...revisionQuery(req.query),
        entryId : req.params.entryId,
      }),
      true,
    ),
  );

  /**
   * PATCH /documents/entries/:entryId/move mueve hacia un destino concreto, nunca una ruta S3.
   * @param {import('express').Request} req entryId y cuerpo {targetRepositoryId,targetParentId,expectedRevision}.
   * @param {import('express').Response} res Envelope de la entrada trasladada o error RPC.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-entry-move.
   */
  app.patch(
    '/documents/entries/:entryId/move',
    authorizationValidation,
    operation(
      'documents-entry-move',
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({
        ...select(req.body, ['targetRepositoryId', 'targetParentId', 'expectedRevision']),
        entryId : req.params.entryId,
      }),
      true,
    ),
  );

  /**
   * GET /documents/entries/:entryId/content transmite bytes autorizados con metadata del servicio.
   * Admite Range y vista previa segura; limpia el temporal al finalizar, fallar o cancelar, incluso
   * cuando el cliente desaparece durante la descarga RPC. No utiliza extensión de rutas privadas.
   * @param {import('express').Request} req entryId y preview='true'|'false'; sesión acreditada.
   * @param {import('express').Response} res Contenido inline o attachment; errores conservan envelope.
   * @returns {Promise<import('express').Response|void>} Transferencia local o error de Documents.
   */
  app.get(
    '/documents/entries/:entryId/content',
    authorizationValidation,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} req Solicitud HTTP recibida por el middleware.
     * @param {Object} res Respuesta HTTP que completa la solicitud.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async (req, res) => {
      let file;
      let cleaned   = false;
      /**
       * Ejecuta cleanup dentro del flujo de documents.controller.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      const cleanup = () => {
        if (file && !cleaned) {
          cleaned = true;
          void temporary.remove(file);
        }
      };
      try {
        if (req.query.preview !== undefined && !['true', 'false'].includes(req.query.preview))
          return response.sendError(req, res, 400, 'DOCUMENT_PREVIEW_INVALID');
        const preview = req.query.preview === 'true';
        const result  = await messaging.request(
          'service-documents',
          'documents-entry-download',
          {
            entryId : req.params.entryId,
            preview,
          },
          {
            context   : req.system,
            timeoutMs : 300000,
          },
        );
        if (result.statusCode !== 200) {
          if (!res.destroyed) return reply(req, res, result);
          return;
        }
        file = await temporary.validate(result.data?.tempFilePath);
        if (res.destroyed) {
          cleanup();
          return;
        }
        const fileName      =
          String(result.data.fileName || 'document').replace(/[\x00-\x1f\x7f"\\/]/g, '_') ||
          'document';
        const metadataType  = String(result.data.mimeType || '').toLowerCase();
        const extensionType = PREVIEW_CONTENT_TYPES[path.extname(fileName).slice(1).toLowerCase()];
        const mimeType      =
          /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(metadataType) &&
          !(preview && metadataType === 'application/octet-stream')
            ? metadataType
            : extensionType || 'application/octet-stream';
        if (preview && !PREVIEW_TYPES.has(mimeType)) {
          cleanup();
          return response.sendError(req, res, 415, 'DOCUMENT_PREVIEW_UNSUPPORTED');
        }
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.attachment(fileName);
        res.setHeader('Content-Type', mimeType);
        if (preview) {
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          res.setHeader(
            'Content-Disposition',
            String(res.getHeader('Content-Disposition')).replace(/^attachment/, 'inline'),
          );
        }
        res.once('finish', cleanup);
        res.once('close', cleanup);
        return res.sendFile(
          file,

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            cleanup();
            if (error) fail(req, res, error);
          },
        );
      } catch (error) {
        cleanup();
        return fail(req, res, error);
      }
    },
  );

  /**
   * PUT /documents/entries/:entryId/favorite marca idempotentemente el favorito del usuario actual.
   * @param {import('express').Request} req entryId y sesión acreditada; no recibe dueño del favorito.
   * @param {import('express').Response} res Envelope {isFavorite:true} o error de autorización.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-favorite-create.
   */
  app.put(
    '/documents/entries/:entryId/favorite',
    authorizationValidation,
    operation(
      'documents-favorite-create',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({ entryId: req.params.entryId }),
      true,
    ),
  );

  /**
   * GET /documents/favorites lista únicamente favoritos todavía autorizados, con su ubicación actual.
   * @param {import('express').Request} req Filtros públicos y kind opcional en query; sesión acreditada.
   * @param {import('express').Response} res Envelope {listItem,totalCount} sin información privada.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-favorites-get-list.
   */
  app.get(
    '/documents/favorites',
    authorizationValidation,
    operation(
      'documents-favorites-get-list',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => select(req.query, ['kind', ...LIST_FIELDS]),
    ),
  );

  /**
   * DELETE /documents/entries/:entryId/favorite quita el favorito propio incluso si perdió lectura.
   * @param {import('express').Request} req entryId y sesión acreditada; identidad fijada por servidor.
   * @param {import('express').Response} res Envelope {isFavorite:false} o error RPC.
   * @returns {Promise<import('express').Response|void>} Resultado HTTP de documents-favorite-delete.
   */
  app.delete(
    '/documents/entries/:entryId/favorite',
    authorizationValidation,
    operation(
      'documents-favorite-delete',

      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} req Solicitud HTTP recibida por el middleware.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (req) => ({ entryId: req.params.entryId }),
      true,
    ),
  );

  return app;
}
module.exports = { documentsController };
