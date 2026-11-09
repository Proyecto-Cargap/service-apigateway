/** @file Admisión durable de una ejecución activa por conversación enlazada a Meta. */
'use strict';
const mongoose = require('mongoose');
const schema   = new mongoose.Schema(
  {
    chatConversationCode : {
      type     : String,
      required : true,
    },
    requestId            : {
      type     : String,
      required : true,
    },
    input                : {
      type     : Object,
      required : true,
    },
    runCode              : {
      type    : String,
      default : '',
    },
    rejectionStatus      : {
      type    : Number,
      default : 0,
    },
    rejectionCode        : {
      type    : String,
      default : '',
    },
    terminal             : {
      type    : Boolean,
      default : false,
    },
    revision             : {
      type    : Number,
      default : 1,
    },
  },
  {
    versionKey : false,
    autoIndex  : false,
  },
);
schema.index({ chatConversationCode: 1 }, { unique: true });
module.exports = mongoose.model('APIGATEWAY_META_RUN', schema, 'APIGATEWAY_META_RUN');
