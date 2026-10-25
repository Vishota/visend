'use strict';

// E2E tests for the bash implementation, driven from node for mock reuse.
// Usage: node tests/run-bash.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { createMockTg } = require('./mock-tg');
const { createMockServer } = require('./mock-server');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bash', 'visend');
const SANDBOX = path.join(__dirname, '.tmp', 'bash-home-' + process.pid);

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    process.stdout.write('  ok    ' + name + '\n');
  } else {
    failed++;
    process.stdout.write('  FAIL  ' + name + (extra ? '\n        ' + String(extra).split('\n').join('\n        ') : '') + '\n');
  }
}

function httpGetJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function runBash(args, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const env = Object.assign({}, process.env, {
      HOME: SANDBOX,
      USERPROFILE: SANDBOX,
      VISEND_TELEGRAM_API_BASE: 'http://127.0.0.1:' + TG.port,
      MSYS_NO_PATHCONV: '1',
      // native Windows curl cannot read MSYS /tmp files
      TMPDIR: path.join(__dirname, '.tmp'),
    }, opts.env || {});
    const child = spawn('bash', [SCRIPT].concat(args), { env: env });
    let out = '';
    let err = '';
    child.stdout.on('data', function (c) { out += c; });
    child.stderr.on('data', function (c) { err += c; });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
    child.on('close', function (code) { resolve({ code: code, out: out, err: err }); });
  });
}

function writeConfig(cfg) {
  const dir = path.join(SANDBOX, '.config', 'visend');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

function readConfigRaw() {
  try { return JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8')); } catch (e) { return null; }
}

let TG, SRV;

async function main() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  TG = await createMockTg(0);
  SRV = await createMockServer(0);
  process.stdout.write('bash e2e: tg=127.0.0.1:' + TG.port + ' srv=' + SRV.url + '\n');

  process.stdout.write('\n== basics ==\n');
  let r = await runBash(['help']);
  ok('help', r.code === 0 && /Usage:/.test(r.out));
  r = await runBash(['frobnicate']);
  ok('unknown command', r.code === 1 && /Unknown command/.test(r.err));
  r = await runBash(['text'], { stdin: '' });
  ok('text empty stdin -> hint', r.code === 1 && /Nothing to send/.test(r.err));
  r = await runBash(['file'], { stdin: '' });
  ok('file empty stdin -> hint', r.code === 1 && /Nothing to send/.test(r.err));
  r = await runBash([], { stdin: 'x' });
  ok('not configured -> setup hint', r.code === 1 && /visend setup/.test(r.err));
  r = await runBash(['--help']);
  ok('--help', r.code === 0 && /Usage:/.test(r.out));

  process.stdout.write('\n== bot mode ==\n');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242 });

  r = await runBash([], { stdin: 'hello bash\n' });
  let sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped text', r.code === 0 && sent.messages.length === 1 && sent.messages[0].text === 'hello bash\n', r.err);

  r = await runBash(['text', 'hello', 'world']);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('args joined', r.code === 0 && sent.messages[1] && sent.messages[1].text === 'hello world', r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['text', 'arg wins'], { stdin: 'stdin data' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('arg wins + warning', r.code === 0 && /stdin ignored/.test(r.out) && sent.messages[0].text === 'arg wins', r.err);

  const longText = new Array(4200).fill('a').join('');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('long -> visend.txt', r.code === 0 && sent.documents.length === 1 && sent.documents[0].filename === 'visend.txt' && /4096/.test(r.out), r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['text', '--force-as-text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('force-as-text truncates', r.code === 0 && sent.messages.length === 1 && sent.messages[0].text.length === 4096, r.err);

  const binaryBuf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.from('garbage')]);
  r = await runBash(['text'], { stdin: binaryBuf });
  ok('binary no tty -> error', r.code === 1 && /interactive terminal/.test(r.err), r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['text', '-y'], { stdin: binaryBuf });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('binary -y sends', r.code === 0 && sent.messages.length === 1 && /binary/.test(r.out), r.err);

  const tmpFile = path.join(__dirname, '.tmp', 'bash-sample.bin');
  fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
  fs.writeFileSync(tmpFile, 'file-content');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['file', tmpFile]);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('file path', r.code === 0 && sent.documents[0].filename === 'bash-sample.bin', r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runBash(['file', '--name', 'custom.txt'], { stdin: 'piped data' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped file custom name', r.code === 0 && sent.documents[0].filename === 'custom.txt', r.err);

  r = await runBash(['settings']);
  ok('settings masks token', r.code === 0 && /own bot/.test(r.out) && !/TEST_TOKEN/.test(r.out), r.out);

  r = await runBash(['forget', '-y']);
  let cfg = readConfigRaw();
  ok('forget -y', r.code === 0 && (cfg === null || (cfg.mode === undefined && cfg.bot_token === undefined)), r.err);

  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242, server_url: 'http://example.org' });
  await runBash(['forget', '-y']);
  cfg = readConfigRaw();
  ok('forget keeps server_url', cfg && cfg.server_url === 'http://example.org');

  process.stdout.write('\n== server mode ==\n');
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });

  r = await runBash([], { stdin: 'via server bash\n' });
  let srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('server text', r.code === 0 && srvSent.texts.length === 1 && srvSent.texts[0] === 'via server bash\n', r.err);

  await httpGetJson(SRV.url + '/__reset');
  r = await runBash(['file', '--name', 'x.bin'], { stdin: 'filebytes!' });
  srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('server file', r.code === 0 && srvSent.files.length === 1 && srvSent.files[0].name === 'x.bin' && srvSent.files[0].size === 10, r.err);

  await httpGetJson(SRV.url + '/__setlimit?bytes=4');
  r = await runBash(['file'], { stdin: 'way more than four bytes' });
  ok('server limit message', r.code === 1 && /server-side limit/.test(r.err), r.err);
  await httpGetJson(SRV.url + '/__setlimit?bytes=' + (50 * 1024 * 1024));

  r = await runBash(['server']);
  ok('server show', r.code === 0 && /online/.test(r.out) && /t\.me\/visend_test_bot/.test(r.out), r.out);

  const mock2 = await createMockServer(0);
  r = await runBash(['server', 'set', mock2.url, '-y']);
  cfg = readConfigRaw();
  ok('server set wipes token + note', r.code === 0 && cfg.server_token === undefined && /one-time code/.test(r.out), r.out);
  mock2.server.close();

  r = await runBash(['server', 'set', 'http://127.0.0.1:9/vi', '-y']);
  cfg = readConfigRaw();
  ok('server set offline -y', r.code === 0 && /did not respond/.test(r.out) && cfg.server_url === 'http://127.0.0.1:9/vi', r.out + r.err);

  r = await runBash(['server', 'set', SRV.url, '-y']);
  ok('http warning', r.code === 0 && /unencrypted/.test(r.out), r.out);

  r = await runBash(['server', 'reset', '-y']);
  cfg = readConfigRaw();
  ok('server reset', r.code === 0 && (cfg.server_url === undefined || cfg.server_url === ''), r.out + r.err);

  r = await runBash(['server', 'reset']);
  ok('confirm no tty -> error', r.code === 1 && /interactive terminal/.test(r.err), r.err);

  // --- refresh flow ---
  process.stdout.write('\n== refresh flow ==\n');
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({
    mode: 'server', user_id: 4242,
    server_token: 'expired-access-token', server_refresh_token: SRV.refresh,
    server_url: SRV.url,
  });
  await httpGetJson(SRV.url + '/__expire?token=expired-access-token');
  r = await runBash([], { stdin: 'after refresh bash\n' });
  let bashCfg = null;
  try { bashCfg = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8')); } catch (e) { /* - */ }
  srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('401 -> auto-refresh -> retry -> persist',
    r.code === 0 && srvSent.texts.length === 1 && srvSent.texts[0] === 'after refresh bash\n' &&
    bashCfg && bashCfg.server_token && bashCfg.server_token !== 'expired-access-token' &&
    bashCfg.server_refresh_token === SRV.refresh,
    r.out + r.err);

  writeConfig({
    mode: 'server', user_id: 4242,
    server_token: 'expired-access-2', server_refresh_token: 'bad-refresh',
    server_url: SRV.url,
  });
  await httpGetJson(SRV.url + '/__expire?token=expired-access-2');
  r = await runBash(['text'], { stdin: 'x' });
  ok('bad refresh -> re-setup hint', r.code === 1 && /visend setup/.test(r.err), r.err);

  // --- bash 3.2 compatibility (macOS ships bash 3.2) ---
  process.stdout.write('\n== bash 3.2 compatibility ==\n');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok('no negative-offset substring expansion (needs 4.2+)', !/\$\{[A-Za-z_][A-Za-z0-9_]*:[ \t]+-/.test(src));
  ok('no ${var,,}/${var^^} case expansion (needs 4.0+)', !/\$\{[A-Za-z_][A-Za-z0-9_]*[,^]{2}/.test(src));

  process.stdout.write('\n================================\n');
  process.stdout.write('bash: passed: ' + passed + ', failed: ' + failed + '\n');
  TG.server.close();
  SRV.server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  process.stderr.write('fatal: ' + (err && err.stack || err) + '\n');
  process.exit(2);
});
