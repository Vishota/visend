'use strict';

const { VisendError } = require('./errors');

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function isPiped() {
  return !process.stdin.isTTY;
}

function readAll() {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', function (c) {
      size += c.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new VisendError('Input exceeds ' + MAX_INPUT_BYTES / (1024 * 1024) + ' MB.'));
        process.stdin.destroy();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', function () { resolve(Buffer.concat(chunks)); });
    process.stdin.on('error', function (err) { reject(new VisendError('Failed to read stdin: ' + err.message)); });
  });
}

module.exports = { isPiped: isPiped, readAll: readAll };
