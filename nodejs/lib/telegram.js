'use strict';

const crypto = require('crypto');
const httpx = require('./httpx');

function apiBase() {
  return process.env.VISEND_TELEGRAM_API_BASE || 'https://api.telegram.org';
}

function apiUrl(token, method) {
  return apiBase() + '/bot' + token + '/' + method;
}

class TelegramError extends Error {
  constructor(description, errorCode, params) {
    super(description || 'Telegram API error');
    this.name = 'TelegramError';
    this.errorCode = errorCode;
    this.params = params;
  }
}

async function call(token, method, payload, timeoutMs) {
  const opts = {
    method: payload ? 'POST' : 'GET',
    headers: {},
    timeoutMs: timeoutMs || 30000,
  };
  if (payload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(payload);
  }
  const res = await httpx.request(apiUrl(token, method), opts);
  const json = httpx.parseJsonBody(res);
  if (!json.ok) {
    throw new TelegramError(json.description, json.error_code, json.parameters);
  }
  return json.result;
}

async function getMe(token) {
  return call(token, 'getMe');
}

async function sendMessage(token, chatId, text) {
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true,
  });
}

async function deleteWebhook(token) {
  return call(token, 'deleteWebhook', { drop_pending_updates: false });
}

async function getUpdates(token, offset, timeoutSec) {
  const payload = { timeout: timeoutSec === undefined ? 0 : timeoutSec, limit: 100 };
  if (offset !== undefined && offset !== null) payload.offset = offset;
  // long poll of 25s + network overhead
  return call(token, 'getUpdates', payload, (timeoutSec || 0) * 1000 + 15000);
}

// Zero-dependency multipart/form-data builder for sendDocument.
async function sendDocument(token, chatId, fileBuf, filename) {
  const boundary = 'visend' + crypto.randomBytes(16).toString('hex');
  const safeName = String(filename).replace(/[\r\n"]/g, '_');
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="chat_id"\r\n\r\n' +
    chatId + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="document"; filename="' + safeName + '"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([head, fileBuf, tail]);
  const res = await httpx.request(apiUrl(token, 'sendDocument'), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: body,
    timeoutMs: 180000,
  });
  const json = httpx.parseJsonBody(res);
  if (!json.ok) {
    throw new TelegramError(json.description, json.error_code, json.parameters);
  }
  return json.result;
}

module.exports = {
  TelegramError: TelegramError,
  getMe: getMe,
  sendMessage: sendMessage,
  getUpdates: getUpdates,
  deleteWebhook: deleteWebhook,
  sendDocument: sendDocument,
};
