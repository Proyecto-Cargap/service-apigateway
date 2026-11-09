/** @file Compila cada validador JSON sólo al utilizarlo; publicar el catálogo no compila herramientas ajenas a la solicitud. */
'use strict';
/** @param {Object} validator Proveedor JSON Schema original del SDK, sin cambios en reglas o formatos.
 * @returns {Object} Mismo contrato del SDK con compilación diferida y reutilización por esquema.
 */
function lazySchemaValidator(validator) {
  return {
    /** @param {Object} schema Contrato canónico inmutable, sin identidad ni callbacks de negocio.
     * @returns {Function} Valida siempre los datos; sólo la compilación se pospone hasta el primer uso.
     */
    getValidator(schema) {
      let compiled;
      /** @param {*} data Entrada o salida real que debe validar el SDK.
       * @returns {Object} Resultado exacto del proveedor, incluidos errores de esquema o formato.
       */
      return (data) => {
        compiled ||= validator.getValidator(schema);
        return compiled(data);
      };
    },
  };
}
module.exports = { lazySchemaValidator };
