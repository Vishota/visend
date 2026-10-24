'use strict';

const config = require('./config');
const telegram = require('./telegram');
const serverapi = require('./serverapi');
const { VisendError } = require('./errors');

function requireConfig() {
  const cfg = config.load();
  if (cfg.mode === 'bot' && cfg.bot_token && cfg.user_id) return cfg;
  if (cfg.mode === 'server' && cfg.server_token && cfg.user_id) return cfg;
  if (cfg.mode === 'server' && !cfg.server_token) {
    throw new VisendError(
      'The server token is missing (the server URL was changed after setup). ' +
      'Run `visend setup` again to get a new one-time code.'
    );
  }
  throw new VisendError('visend is not configured yet. Run `visend setup` first.');
}

function describeTelegramError(err) {
  let msg = 'Telegram API error: ' + err.message;
  if (err.errorCode) msg += ' (code ' + err.errorCode + ')';
  if (err.errorCode === 401) msg += ' - the bot token is invalid or was revoked. Run `visend setup`.';
  if (err.errorCode === 403 && /chat not found|bot was blocked/i.test(err.message)) {
    msg += ' - run `visend setup` to re-pair with your chat.';
  }
  return msg;
}

function describeServerError(err) {
  if (err instanceof serverapi.ServerError && err.code === 'file_too_large') {
    const limit = err.maxFileSize
      ? Math.round(err.maxFileSize / (1024 * 1024) * 10) / 10 + ' MB'
      : 'unknown';
    return 'The server rejected the file: its own size limit is ' + limit +
      ' (this is a server-side limit, not the Telegram one).';
  }
  if (err instanceof serverapi.ServerError && err.status === 401) {
    return 'The server rejected the token. Run `visend setup` again to get a new one-time code.';
  }
  return err.message;
}

async function deliverText(cfg, textBuf) {
  const text = textBuf.toString('utf8');
  if (!text.trim()) throw new VisendError('Refusing to send an empty message.');
  if (cfg.mode === 'bot') {
    try {
      const result = await telegram.sendMessage(cfg.bot_token, cfg.user_id, text);
      return 'Text sent to Telegram (message_id ' + result.message_id + ').';
    } catch (err) {
      throw new VisendError(describeTelegramError(err));
    }
  }
  const url = config.effectiveServerUrl(cfg);
  try {
    const result = await serverapi.sendText(url, cfg.server_token, textBuf);
    return 'Text sent to Telegram via ' + url + ' (message_id ' + (result.message_id || '?') + ').';
  } catch (err) {
    throw new VisendError(describeServerError(err));
  }
}

async function deliverFile(cfg, buf, name) {
  const sizeMb = Math.round(buf.length / (1024 * 1024) * 10) / 10;
  if (cfg.mode === 'bot') {
    try {
      await telegram.sendDocument(cfg.bot_token, cfg.user_id, buf, name);
      return 'File "' + name + '" (' + sizeMb + ' MB) sent to Telegram.';
    } catch (err) {
      throw new VisendError(describeTelegramError(err));
    }
  }
  const url = config.effectiveServerUrl(cfg);
  try {
    await serverapi.sendFile(url, cfg.server_token, buf, name);
    return 'File "' + name + '" (' + sizeMb + ' MB) sent to Telegram via ' + url + '.';
  } catch (err) {
    throw new VisendError(describeServerError(err));
  }
}

module.exports = {
  requireConfig: requireConfig,
  deliverText: deliverText,
  deliverFile: deliverFile,
  describeTelegramError: describeTelegramError,
  describeServerError: describeServerError,
};
