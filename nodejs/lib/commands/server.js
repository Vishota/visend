'use strict';

const config = require('../config');
const serverapi = require('../serverapi');
const tty = require('../tty');
const { VisendError } = require('../errors');

function out(line) {
  process.stdout.write(line + '\n');
}

function humanizeUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

async function showStatus() {
  const cfg = config.load();
  const url = config.effectiveServerUrl(cfg);
  out('Server: ' + url);
  try {
    const status = await serverapi.fetchStatus(url);
    out('Status: online (uptime ' + humanizeUptime(status.uptime_seconds || 0) + ')');
  } catch (err) {
    out('Status: unreachable - the server did not respond.');
    out('');
    out('You can host your own visend server from the official docker image and point');
    out('visend at it with `visend server set <url>` - see the README (Self-hosting).');
    return;
  }
  try {
    const cfgInfo = await serverapi.fetchConfig(url);
    if (cfgInfo.bot) {
      out('Bot: ' + cfgInfo.bot + ' (send /start to it to get your user id and a code)');
    }
  } catch (err) {
    out('Bot: unknown (could not fetch server config).');
  }
}

function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new VisendError('Invalid URL "' + raw + '": it must start with http:// or https://');
  }
  return url.replace(/\/+$/, '');
}

// Persist the new URL; wipe the server token in server mode (the new server
// will not accept it) and tell the user to re-run setup.
async function applyServerUrl(newUrl, yes) {
  const cfg = config.load();
  const current = config.effectiveServerUrl(cfg);
  const unchanged = newUrl === current;
  cfg.server_url = newUrl === config.DEFAULT_SERVER_URL ? '' : newUrl;
  if (unchanged) {
    config.save(cfg);
    out('Server URL is already ' + newUrl + ' - nothing to change.');
    return;
  }
  if (cfg.mode === 'server' && (cfg.server_token || cfg.server_refresh_token)) {
    delete cfg.server_token;
    delete cfg.server_refresh_token;
    config.save(cfg);
    out('Server URL saved.');
    out('');
    out('Note: for security the old token pair has been removed - the new server will');
    out('not accept it. Run `visend setup` again and enter a new one-time code.');
    return;
  }
  config.save(cfg);
  out('Server URL saved.');
}

async function setUrl(rawUrl, yes) {
  const url = normalizeUrl(rawUrl);
  if (/^http:\/\//i.test(url)) {
    out('Warning: this URL uses plain http:// - your pairing code, token and data will');
    out('travel over the network unencrypted.');
    const ok = await tty.confirm('Continue anyway?', yes);
    if (!ok) throw new VisendError('Aborted.');
  }
  out('Checking ' + url + ' ...');
  let online = false;
  try {
    await serverapi.fetchStatus(url);
    online = true;
  } catch (err) {
    online = false;
  }
  if (online) {
    out('Server is up.');
  } else {
    out('Warning: the server did not respond.');
    const ok = await tty.confirm('Save this URL anyway?', yes);
    if (!ok) throw new VisendError('Aborted.');
  }
  await applyServerUrl(url, yes);
}

async function reset(yes) {
  out('Reset the server URL to ' + config.DEFAULT_SERVER_URL + '?');
  const ok = await tty.confirm('Continue?', yes);
  if (!ok) throw new VisendError('Aborted.');
  out('Checking ' + config.DEFAULT_SERVER_URL + ' ...');
  let online = false;
  try {
    await serverapi.fetchStatus(config.DEFAULT_SERVER_URL);
    online = true;
  } catch (err) {
    online = false;
  }
  if (!online) {
    out('Warning: the default server did not respond.');
    const ok2 = await tty.confirm('Reset anyway?', yes);
    if (!ok2) throw new VisendError('Aborted.');
  }
  const cfg = config.load();
  const current = config.effectiveServerUrl(cfg);
  if (current === config.DEFAULT_SERVER_URL && !cfg.server_url) {
    out('The server URL is already the default.');
    return;
  }
  await applyServerUrl(config.DEFAULT_SERVER_URL, yes);
}

async function run(args, flags) {
  const sub = args[0];
  if (sub === 'set') {
    if (!args[1]) {
      throw new VisendError('Usage: visend server set <url>   e.g. visend server set http://example.com:6767/test/misc/visend');
    }
    await setUrl(args[1], flags.yes);
    return;
  }
  if (sub === 'reset') {
    await reset(flags.yes);
    return;
  }
  if (sub) {
    throw new VisendError('Unknown subcommand "' + sub + '". Use `visend server`, `visend server set <url>` or `visend server reset`.');
  }
  await showStatus();
}

module.exports = { run: run };
