'use strict';

const config = require('../config');
const tty = require('../tty');
const { VisendError } = require('../errors');

async function run(args, flags) {
  const path = config.configPath();
  let existing = null;
  try {
    existing = config.load();
  } catch (err) {
    existing = {};
  }
  const hasAnything = !!(existing.mode || existing.bot_token || existing.server_token || existing.user_id);
  if (!hasAnything) {
    process.stdout.write('Nothing to forget - visend is not configured.\n');
    return;
  }
  const ok = await tty.confirm(
    'Delete all visend settings (bot token, server token, user id)? The server URL is kept.',
    flags.yes
  );
  if (!ok) throw new VisendError('Aborted.');
  // Everything except the server URL.
  config.save({ server_url: existing.server_url });
  process.stdout.write('Settings removed (' + path + '). Run `visend setup` to start over.\n');
}

module.exports = { run: run };
