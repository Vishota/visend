'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { VisendError } = require('./errors');

const DEFAULT_SERVER_URL = 'https://visend.vishota.com';

// Keys of config.json. Shared with the bash and powershell implementations.
const KEYS = ['mode', 'bot_token', 'user_id', 'server_url', 'server_token'];

function configDir() {
  return path.join(os.homedir(), '.config', 'visend');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new VisendError('Cannot read ' + configPath() + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new VisendError(
      'Settings file is corrupted (' + configPath() + '). ' +
      'Fix it manually or remove it, then run `visend setup` again.'
    );
  }
  const cfg = {};
  if (parsed && typeof parsed === 'object') {
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[i];
      if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== null && parsed[key] !== '') {
        cfg[key] = parsed[key];
      }
    }
  }
  if (cfg.mode && cfg.mode !== 'bot' && cfg.mode !== 'server') delete cfg.mode;
  return cfg;
}

// Restrict permissions to the current user: chmod 600 on POSIX,
// ACL inheritance removal + explicit grant on Windows. Synchronous on
// purpose - it must win the race with the atomic rename in save().
function secure(p, isDir) {
  if (process.platform === 'win32') {
    let user = process.env.USERNAME || '';
    if (process.env.USERDOMAIN) user = process.env.USERDOMAIN + '\\' + user;
    if (!user) return;
    const args = [p, '/inheritance:r', '/grant:r', user + ':' + (isDir ? '(OI)(CI)F' : 'F')];
    try {
      execFileSync('icacls.exe', args, { stdio: 'ignore' });
    } catch (err) {
      process.stderr.write('Warning: could not restrict permissions on ' + p + ' (' + err.message.split('\n')[0] + ')\n');
    }
  } else {
    try {
      fs.chmodSync(p, isDir ? 0o700 : 0o600);
    } catch (err) { /* best effort (e.g. exotic filesystems) */ }
  }
}

// Atomic write: temp file in the same directory, then rename over the target.
function save(cfg) {
  const dir = configDir();
  const target = configPath();
  const clean = {};
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];
    if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== '') clean[key] = cfg[key];
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw new VisendError('Cannot create ' + dir + ': ' + err.message);
  }
  secure(dir, true);
  if (Object.keys(clean).length === 0) {
    try {
      fs.unlinkSync(target);
    } catch (err) { /* already gone */ }
    return;
  }
  const tmp = path.join(dir, '.config-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  secure(target, false);
}

function effectiveServerUrl(cfg) {
  return (cfg && cfg.server_url) || DEFAULT_SERVER_URL;
}

module.exports = {
  DEFAULT_SERVER_URL: DEFAULT_SERVER_URL,
  configDir: configDir,
  configPath: configPath,
  load: load,
  save: save,
  effectiveServerUrl: effectiveServerUrl,
};
