/** @file DTO cerrado del puente de plataforma: cada operación admite sólo sus campos documentados. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
module.exports = createActionDtos(['meta-platform-execute']);
