'use strict';

const config = require('../config');

function mask(secret) {
  if (!secret) return 'not set';
  if (secret.length <= 8) return '****';
  return secret.slice(0, 4) + '...' + secret.slice(-4);
}

async function run() {
  const cfg = config.load();
  const out = process.stdout;
  out.write('Settings file: ' + config.configPath() + '\n');
  if (cfg.mode === 'bot') out.write('Mode:          own bot (direct Telegram API)\n');
  else if (cfg.mode === 'server') out.write('Mode:          shared server\n');
  else out.write('Mode:          not configured (run `visend setup`)\n');
  out.write('User id:       ' + (cfg.user_id || 'not set') + '\n');
  out.write('Server URL:    ' + config.effectiveServerUrl(cfg) +
    (cfg.server_url ? '' : ' (default)') + '\n');
  out.write('Bot token:     ' + mask(cfg.bot_token) + '\n');
  out.write('Server token:  ' + mask(cfg.server_token) + '\n');
}

module.exports = { run: run };
