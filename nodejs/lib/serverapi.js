'use strict';

const httpx = require('./httpx');

class ServerError extends Error {
  constructor(message, status, code, maxFileSize) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
    this.maxFileSize = maxFileSize;
  }
}
function checkResponse(res, what) {
  let json = null;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (err) { /* non-JSON error page */ }
  if (res.status >= 200 && res.status < 300 && json && json.ok) return json;
  const description =
    (json && (json.description || json.error)) ||
    'HTTP ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200);
  throw new ServerError(
    what + ' failed: ' + description,
    res.status,
    json && json.error,
    json && json.max_file_size
  );
}

async function fetchStatus(serverUrl) {
  const res = await httpx.request(serverUrl.replace(/\/+$/, '') + '/status', { timeoutMs: 10000 });
  return checkResponse(res, 'Server status check');
}

async function fetchConfig(serverUrl) {
  const res = await httpx.request(serverUrl.replace(/\/+$/, '') + '/config', { timeoutMs: 10000 });
  return checkResponse(res, 'Server config fetch');
}

async function connect(serverUrl, userId, code) {
  const res = await httpx.request(serverUrl.replace(/\/+$/, '') + '/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, code: code }),
    timeoutMs: 15000,
  });
  return checkResponse(res, 'Server connect');
}

// Exchange a refresh token for a new access+refresh pair.
async function refresh(serverUrl, refreshToken) {
  const res = await httpx.request(serverUrl.replace(/\/+$/, '') + '/refresh', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + refreshToken },
    timeoutMs: 20000,
  });
  return checkResponse(res, 'Token refresh');
}

async function sendText(serverUrl, token, textBuf) {
  const res = await httpx.request(serverUrl.replace(/\/+$/, '') + '/text', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: textBuf,
    timeoutMs: 60000,
  });
  return checkResponse(res, 'Sending text');
}

async function sendFile(serverUrl, token, fileBuf, name) {
  const res = await httpx.request(
    serverUrl.replace(/\/+$/, '') + '/file?name=' + encodeURIComponent(name),
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuf,
      timeoutMs: 180000,
    }
  );
  return checkResponse(res, 'Sending file');
}

module.exports = {
  ServerError: ServerError,
  fetchStatus: fetchStatus,
  fetchConfig: fetchConfig,
  connect: connect,
  refresh: refresh,
  sendText: sendText,
  sendFile: sendFile,
};
