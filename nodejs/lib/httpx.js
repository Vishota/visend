'use strict';

const http = require('http');
const https = require('https');

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Promise-based request on top of node core http/https modules.
 *
 * opts: {
 *   method    string
 *   headers   object
 *   body      Buffer | string
 *   timeoutMs number  idle socket timeout (uploads/long polls keep the
 *                     connection alive, so this must not be an overall cap)
 * }
 * Resolves { status, headers, body: Buffer }.
 */
function request(target, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    let u;
    try {
      u = new URL(target);
    } catch (err) {
      reject(new Error('Invalid URL: ' + target));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers);
    let body = opts.body;
    if (body && !Buffer.isBuffer(body)) body = Buffer.from(body);
    if (body && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = body.length;
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: headers,
      },
      function (res) {
        const chunks = [];
        let size = 0;
        let aborted = false;
        res.on('data', function (c) {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES && !aborted) {
            aborted = true;
            res.destroy(new Error('Response exceeds ' + MAX_RESPONSE_BYTES + ' bytes'));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', function () {
          if (aborted) return;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', reject);
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, function () {
        req.destroy(new Error('Request timed out after ' + opts.timeoutMs + ' ms'));
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonBody(res) {
  let text;
  try {
    text = res.body.toString('utf8');
    return JSON.parse(text);
  } catch (err) {
    const snippet = (text || '').slice(0, 200).replace(/\s+/g, ' ');
    const e = new Error(
      'Expected JSON response, got HTTP ' + res.status + (snippet ? ': ' + snippet : ' (empty body)')
    );
    e.status = res.status;
    throw e;
  }
}

module.exports = { request: request, parseJsonBody: parseJsonBody };
