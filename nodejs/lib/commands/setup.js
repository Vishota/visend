'use strict';

const config = require('../config');
const telegram = require('../telegram');
const serverapi = require('../serverapi');
const send = require('../send');
const tty = require('../tty');
const { VisendError } = require('../errors');

// How long to wait for /start before falling back to manual user id input.
// VISEND_TEST_WAIT_MS exists for the test-suite only.
const WAIT_LIMIT_MS = Number(process.env.VISEND_TEST_WAIT_MS) || 120000;

function out(line) {
  process.stdout.write(line + '\n');
}

async function chooseMode(serverUrl) {
  let status = null;
  let cfgInfo = null;
  try {
    status = await serverapi.fetchStatus(serverUrl);
    cfgInfo = await serverapi.fetchConfig(serverUrl);
  } catch (err) {
    status = null;
  }
  for (;;) {
    out('How do you want to receive your messages?');
    out('');
    out('  1) Through the shared visend server (' + serverUrl + ')' +
      (status ? '' : '  [currently unavailable]'));
    out('  2) Through my own Telegram bot (needs a token from @BotFather)');
    out('  3) Cancel');
    const answer = (await tty.prompt('Choice [1-3]: ')).trim();
    if (answer === '3') throw new VisendError('Setup cancelled.');
    if (answer === '1') {
      if (!status) {
        out('');
        out('The configured server did not respond, so this option is unavailable right now.');
        out('Check `visend server` for details, or host your own server (see README).');
        out('');
        continue;
      }
      return { mode: 'server', status: status, config: cfgInfo };
    }
    if (answer === '2') return { mode: 'bot' };
    out('Please enter 1, 2 or 3.');
    out('');
  }
}

async function setupServer(serverUrl, statusInfo, cfgInfo) {
  out('');
  out('Warning: with the shared server your text, files and pairing codes pass through');
  out('a third-party server before reaching Telegram. Treat it as a dev tool - do not use');
  out('it for sensitive data. For full control you can host your own server from the');
  out('official docker image - see `visend server` and the README.');
  out('');
  const botLink = (cfgInfo && cfgInfo.bot) || null;
  if (botLink) {
    out('1. Open ' + botLink + ' and send /start to the bot.');
  } else {
    out('1. Send /start to the visend bot of this server (see `visend server` for the link).');
  }
  out('2. The bot will reply with your user id and a one-time code (valid for 1 hour).');
  out('');
  const userId = await tty.askUserId('Your user id: ');
  const code = (await tty.askRequired('One-time code: ')).toUpperCase();
  out('Connecting to ' + serverUrl + ' ...');
  let token;
  let refreshToken;
  try {
    const result = await serverapi.connect(serverUrl, userId, code);
    token = result.token;
    refreshToken = result.refresh_token || '';
  } catch (err) {
    if (err instanceof serverapi.ServerError) {
      if (err.status === 429) throw new VisendError('The server rate-limited you. Wait a minute and try again.');
      if (err.code === 'not_allowed') throw new VisendError('This server does not accept your user id (the admin restricts who can connect).');
      if (err.code === 'code_burned') throw new VisendError('Too many wrong attempts - the code is burned. Send /start to the bot again for a new one.');
      if (err.status === 403) throw new VisendError('The code or user id is wrong (or the code expired). Send /start to the bot again and retry.');
      throw new VisendError('Server connect failed: ' + err.message);
    }
    throw err;
  }
  const cfg = config.load();
  cfg.mode = 'server';
  cfg.user_id = userId;
  cfg.server_token = token;
  if (refreshToken) cfg.server_refresh_token = refreshToken;
  else delete cfg.server_refresh_token;
  config.save(cfg);
  out('Paired with the server.');
  // Confirm end-to-end delivery.
  try {
    await serverapi.sendText(serverUrl, token, Buffer.from('visend is set up! Everything you pipe will arrive here.', 'utf8'));
    out('Test message sent to your Telegram. Setup complete.');
  } catch (err) {
    out('Warning: pairing succeeded, but the test message failed: ' + send.describeServerError(err));
  }
}

function extractStart(updates) {
  for (let i = 0; i < updates.length; i++) {
    const m = updates[i].message;
    if (!m || !m.chat || m.chat.type !== 'private') continue;
    if (typeof m.text !== 'string') continue;
    if (m.text.split(/\s+/)[0] === '/start') {
      const from = m.from || {};
      return { userId: from.id, username: from.username || null };
    }
  }
  return null;
}

async function waitForStart(token, yes) {
  // First call only establishes the baseline update_id; queued (stale)
  // updates are never shown to the user.
  let lastId = 0;
  let first;
  for (;;) {
    try {
      first = await telegram.getUpdates(token);
      break;
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.errorCode === 409) {
        const proceed = await handleWebhookConflict(token, yes);
        if (!proceed) return null;
        continue;
      }
      throw err;
    }
  }
  for (let i = 0; i < first.length; i++) {
    if (first[i].update_id > lastId) lastId = first[i].update_id;
  }
  const deadline = Date.now() + WAIT_LIMIT_MS;
  process.stdout.write('Waiting for your /start...');
  for (;;) {
    process.stdout.write('.');
    let updates;
    try {
      updates = await telegram.getUpdates(token, lastId + 1, 25);
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.errorCode === 409) {
        process.stdout.write('\n');
        const proceed = await handleWebhookConflict(token, yes);
        if (!proceed) return null;
        out('Continuing to wait...');
        continue;
      }
      throw err;
    }
    // Ack every batch so updates are never processed twice.
    for (let i = 0; i < updates.length; i++) {
      if (updates[i].update_id > lastId) lastId = updates[i].update_id;
    }
    const found = extractStart(updates);
    if (found) {
      process.stdout.write('\n');
      return found;
    }
    if (Date.now() >= deadline) {
      process.stdout.write('\n');
      return null;
    }
  }
}

async function handleWebhookConflict(token, yes) {
  out('Another getUpdates poller or a webhook is active on this bot (HTTP 409).');
  out('This usually means the bot is used by another integration.');
  const drop = await tty.confirm(
    'Delete the webhook? WARNING: this will break the existing integration.', yes
  );
  if (!drop) return false;
  await telegram.deleteWebhook(token);
  out('Webhook deleted.');
  return true;
}

async function setupBot(yes) {
  const token = (await tty.askRequired('Bot token (from @BotFather): ')).trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new VisendError('That does not look like a bot token. Expected format: 123456789:AA...');
  }
  let me;
  try {
    me = await telegram.getMe(token);
  } catch (err) {
    throw new VisendError('Token check (getMe) failed: ' + err.message);
  }
  out('Token is valid. Bot: @' + (me.username || me.first_name));
  out('');
  out('Now open Telegram and send /start to @' + (me.username || 'your bot') + '.');
  const found = await waitForStart(token, yes);
  let userId;
  if (found) {
    out('Got it: user_id ' + found.userId + (found.username ? ' (@' + found.username + ')' : ' (no @username)'));
    const answer = await tty.prompt(
      'Press Enter to save this user id, or type another one (yours from @userinfobot): '
    );
    const trimmed = answer.trim();
    if (!trimmed) {
      userId = found.userId;
    } else if (/^\d{1,16}$/.test(trimmed)) {
      userId = Number(trimmed);
    } else {
      out('That is not a valid id; saving the detected one (' + found.userId + ').');
      userId = found.userId;
    }
  } else {
    out('Timed out after 120 seconds waiting for /start.');
    userId = await tty.askUserId('Enter your user id manually (yours from @userinfobot): ');
  }
  const cfg = config.load();
  cfg.mode = 'bot';
  cfg.bot_token = token;
  cfg.user_id = userId;
  config.save(cfg);
  out('Saved.');
  try {
    await telegram.sendMessage(token, userId, 'visend is set up! Everything you pipe will arrive here.');
    out('Test message sent to your Telegram. Setup complete.');
  } catch (err) {
    out('Warning: settings saved, but the test message failed: ' + send.describeTelegramError(err));
  }
}

async function run(args, flags) {
  const cfg = config.load();
  const serverUrl = config.effectiveServerUrl(cfg);
  out('visend setup');
  out('');
  const choice = await chooseMode(serverUrl);
  out('');
  if (choice.mode === 'server') {
    await setupServer(serverUrl, choice.status, choice.config);
  } else {
    await setupBot(flags.yes);
  }
}

module.exports = { run: run };
