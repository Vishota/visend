'use strict';

const config = require('./config');
const telegram = require('./telegram');
const serverapi = require('./serverapi');
const { VisendError } = require('./errors');

const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;

function requireConfig() {
  const cfg = config.load();
  if (cfg.mode === 'bot' && cfg.bot_token && cfg.user_id) return cfg;
  if (cfg.mode === 'server' && cfg.user_id) {
    if (!cfg.server_token && !cfg.server_refresh_token) {
      throw new VisendError(
        'The server token is missing (the server URL was changed after setup). ' +
        'Run `visend setup` again to get a new one-time code.'
      );
    }
    return cfg;
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
    if (err.code === 'token_expired') {
      return 'The access token expired and the refresh token did not work. Run `visend setup` again.';
    }
    return 'The server rejected the token. Run `visend setup` again to get a new one-time code.';
  }
  return err.message;
}

// Run a server request; on 401 (expired access) refresh the token pair,
// persist it and retry the request once.
async function withRefresh(cfg, fn) {
  const url = config.effectiveServerUrl(cfg);
  if (!cfg.server_token && cfg.server_refresh_token) {
    // Nothing to retry with yet - go straight to refresh.
    await rotateTokens(cfg);
  }
  try {
    return await fn(url, cfg.server_token);
  } catch (err) {
    if (!(err instanceof serverapi.ServerError) || err.status !== 401) throw err;
    if (!cfg.server_refresh_token) throw err;
    await rotateTokens(cfg);
    return await fn(url, cfg.server_token);
  }
}

async function rotateTokens(cfg) {
  const url = config.effectiveServerUrl(cfg);
  let pair;
  try {
    pair = await serverapi.refresh(url, cfg.server_refresh_token);
  } catch (err) {
    if (err instanceof serverapi.ServerError && err.status === 401) {
      throw new VisendError(
        'The refresh token is invalid or expired. Run `visend setup` again to get a new one-time code.'
      );
    }
    throw err;
  }
  cfg.server_token = pair.token;
  cfg.server_refresh_token = pair.refresh_token;
  config.save(cfg);
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
  try {
    const result = await withRefresh(cfg, function (url, token) {
      return serverapi.sendText(url, token, textBuf);
    });
    return 'Text sent to Telegram via ' + config.effectiveServerUrl(cfg) +
      ' (message_id ' + (result.message_id || '?') + ').';
  } catch (err) {
    throw new VisendError(describeServerError(err));
  }
}

async function deliverFile(cfg, buf, name) {
  const sizeMb = Math.round(buf.length / (1024 * 1024) * 10) / 10;
  // Telegram bot API hard limit - applies to every delivery path, including
  // the text->file fallback for >4096-char input.
  if (buf.length > TELEGRAM_FILE_LIMIT) {
    throw new VisendError(
      'The file is ' + sizeMb + ' MB, but Telegram bots can only send files up to 50 MB.'
    );
  }
  if (cfg.mode === 'bot') {
    try {
      await telegram.sendDocument(cfg.bot_token, cfg.user_id, buf, name);
      return 'File "' + name + '" (' + sizeMb + ' MB) sent to Telegram.';
    } catch (err) {
      throw new VisendError(describeTelegramError(err));
    }
  }
  try {
    const result = await withRefresh(cfg, function (url, token) {
      return serverapi.sendFile(url, token, buf, name);
    });
    return 'File "' + name + '" (' + sizeMb + ' MB) sent to Telegram via ' +
      config.effectiveServerUrl(cfg) + '.';
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
