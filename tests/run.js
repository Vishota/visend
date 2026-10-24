'use strict';

// Test driver for the nodejs CLI. Node 10 compatible syntax.
// Usage: node tests/run.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { createMockTg } = require('./mock-tg');
const { createMockServer } = require('./mock-server');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'nodejs', 'bin', 'visend.js');
const SANDBOX = path.join(__dirname, '.tmp', 'home-' + process.pid);

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    process.stdout.write('  ok    ' + name + '\n');
  } else {
    failed++;
    failures.push(name + (extra ? '\n        ' + String(extra).split('\n').join('\n        ') : ''));
    process.stdout.write('  FAIL  ' + name + '\n');
    if (extra) process.stdout.write('        ' + String(extra).split('\n').join('\n        ') + '\n');
  }
}

function httpGetJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function runCli(args, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const env = Object.assign({}, process.env, {
      HOME: SANDBOX,
      USERPROFILE: SANDBOX,
      VISEND_TELEGRAM_API_BASE: 'http://127.0.0.1:' + TG.port,
    }, opts.env || {});
    const child = spawn(process.execPath, [BIN].concat(args), { env: env });
    let out = '';
    let err = '';
    child.stdout.on('data', function (c) { out += c; });
    child.stderr.on('data', function (c) { err += c; });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
    child.on('close', function (code) {
      resolve({ code: code, out: out, err: err });
    });
  });
}

function writeConfig(cfg) {
  const dir = path.join(SANDBOX, '.config', 'visend');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

function readConfigRaw() {
  const p = path.join(SANDBOX, '.config', 'visend', 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

let TG, SRV;

async function testBasics() {
  process.stdout.write('\n== basics ==\n');
  let r = await runCli(['help']);
  ok('help exits 0', r.code === 0);
  ok('help lists commands', /visend text/.test(r.out) && /visend setup/.test(r.out));

  r = await runCli(['frobnicate']);
  ok('unknown command fails with hint', r.code === 1 && /Unknown command/.test(r.err) && /visend help/.test(r.err));

  r = await runCli(['text'], { stdin: '' });
  ok('text without stdin/args errors with hint', r.code === 1 && /Nothing to send/.test(r.err) && /pipe/i.test(r.err));

  r = await runCli(['file'], { stdin: '' });
  ok('file without stdin/args errors with hint', r.code === 1 && /Nothing to send/.test(r.err) && /file path/.test(r.err));

  r = await runCli([], { stdin: 'hello\n' });
  ok('bare visend with pipe + no config -> setup hint', r.code === 1 && /visend setup/.test(r.err));

  r = await runCli(['--help']);
  ok('--help shows help', r.code === 0 && /Usage:/.test(r.out));

  r = await runCli(['server'], { env: {} });
  ok('server shows default URL', r.code === 0 && /visend\.vishota\.com/.test(r.out) && /unreachable|online/.test(r.out));
}

async function testBotMode() {
  process.stdout.write('\n== bot mode (direct Telegram API) ==\n');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242 });

  let r = await runCli([], { stdin: 'hello piped\n' });
  let sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped text is sent', r.code === 0 && sent.messages.length === 1 && sent.messages[0].text === 'hello piped\n' && sent.messages[0].chat_id === '4242');

  r = await runCli(['text', 'hello', 'world']);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('args are joined with spaces', r.code === 0 && sent.messages.length === 2 && sent.messages[1].text === 'hello world');

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['text', 'from arg'], { stdin: 'from stdin' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('arg wins over stdin + warning', r.code === 0 && /stdin ignored/.test(r.out) && sent.messages.length === 1 && sent.messages[0].text === 'from arg');

  // long text -> file
  const longText = new Array(4200).fill('a').join('');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('>4096 chars sent as visend.txt + warning', r.code === 0 && /4096/.test(r.out) && sent.documents.length === 1 && sent.documents[0].filename === 'visend.txt');

  // long text force-as-text -> truncated to 4096
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['text', '--force-as-text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('--force-as-text truncates to 4096', r.code === 0 && /cut/.test(r.out) && sent.messages.length === 1 && sent.messages[0].text.length === 4096);

  // binary detection
  const binaryBuf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.from('garbage')]);
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['text'], { stdin: binaryBuf });
  ok('binary without -y and without tty errors', r.code === 1 && /interactive terminal/.test(r.err));

  r = await runCli(['text', '-y'], { stdin: binaryBuf });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('binary with -y is sent after warning', r.code === 0 && /binary/.test(r.out) && sent.messages.length === 1);

  // files
  const tmpFile = path.join(__dirname, '.tmp', 'sample.bin');
  fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
  fs.writeFileSync(tmpFile, Buffer.from('file-content-here'));
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['file', tmpFile]);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('file <path> sends with original name', r.code === 0 && sent.documents.length === 1 && sent.documents[0].filename === 'sample.bin');

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['file', tmpFile, '--name', 'renamed.dat']);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('file --name overrides name', r.code === 0 && sent.documents[0].filename === 'renamed.dat');

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['file', '--name', 'noext'], { stdin: 'piped file content' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped file gets --name or visend.txt', r.code === 0 && sent.documents[0].filename === 'noext');

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['file'], { stdin: 'piped default name' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped file default name visend.txt', r.code === 0 && sent.documents[0].filename === 'visend.txt');

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runCli(['file', tmpFile], { stdin: 'ignored' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('path wins over stdin + warning', r.code === 0 && /stdin ignored/.test(r.out) && sent.documents[0].filename === 'sample.bin');

  // 50MB limit
  const bigFile = path.join(__dirname, '.tmp', 'big.bin');
  fs.writeFileSync(bigFile, Buffer.alloc(50 * 1024 * 1024 + 1024, 7));
  r = await runCli(['file', bigFile]);
  ok('>50MB rejected with Telegram limit message', r.code === 1 && /50 MB/.test(r.err));
  fs.unlinkSync(bigFile);

  // empty stdin
  r = await runCli(['text'], { stdin: '' });
  ok('empty input refused', r.code === 1 && /empty/.test(r.err));

  // settings + forget
  r = await runCli(['settings']);
  ok('settings masks token', r.code === 0 && /own bot/.test(r.out) && !new RegExp(TG.token).test(r.out) && !/TEST_TOKEN/.test(r.out) && /\.\.\./.test(r.out));

  r = await runCli(['forget', '-y']);
  let cfg = readConfigRaw();
  ok('forget -y removes settings', r.code === 0 && (cfg === null || (cfg.mode === undefined && cfg.bot_token === undefined)));

  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242, server_url: 'http://example.org' });
  await runCli(['forget', '-y']);
  cfg = readConfigRaw();
  ok('forget keeps server_url', cfg && cfg.server_url === 'http://example.org');
}

async function testServerMode() {
  process.stdout.write('\n== server mode ==\n');
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });

  let r = await runCli([], { stdin: 'via server\n' });
  let sent = await httpGetJson(SRV.url + '/__sent');
  ok('server-mode text', r.code === 0 && sent.texts.length === 1 && sent.texts[0] === 'via server\n');

  await httpGetJson(SRV.url + '/__reset');
  r = await runCli(['file', '--name', 'x.bin'], { stdin: 'filebytes' });
  sent = await httpGetJson(SRV.url + '/__sent');
  ok('server-mode file with name', r.code === 0 && sent.files.length === 1 && sent.files[0].name === 'x.bin' && sent.files[0].size === 9);

  // server-side limit
  await httpGetJson(SRV.url + '/__setlimit?bytes=4');
  r = await runCli(['file'], { stdin: 'way more than four bytes' });
  ok('server limit reported as server-side', r.code === 1 && /server/i.test(r.err) && /limit/i.test(r.err));
  await httpGetJson(SRV.url + '/__setlimit?bytes=' + (50 * 1024 * 1024));

  // bad token
  writeConfig({ mode: 'server', user_id: 4242, server_token: 'wrong-token', server_url: SRV.url });
  r = await runCli(['text'], { stdin: 'x' });
  ok('server 401 -> re-setup hint', r.code === 1 && /visend setup/.test(r.err));

  // server show
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });
  r = await runCli(['server']);
  ok('server show: online + bot link', r.code === 0 && /online/.test(r.out) && /t\.me\/visend_test_bot/.test(r.out));

  // server set: online, token wipe in server mode
  r = await runCli(['server', 'set', SRV.url + '/', '-y']);
  let cfg = readConfigRaw();
  ok('server set saves URL', r.code === 0 && cfg.server_url === SRV.url);
  const mock2 = await createMockServer(0);
  r = await runCli(['server', 'set', mock2.url, '-y']);
  cfg = readConfigRaw();
  ok('server set wipes old token + re-setup note', r.code === 0 && cfg.server_token === undefined && /one-time code/.test(r.out));
  mock2.server.close();

  // server set offline + save anyway
  r = await runCli(['server', 'set', 'http://127.0.0.1:9/vi', '-y']);
  cfg = readConfigRaw();
  ok('server set offline saves anyway with -y + warning', r.code === 0 && /did not respond/.test(r.out) && cfg.server_url === 'http://127.0.0.1:9/vi');

  // http:// warning appears even when server online
  r = await runCli(['server', 'set', SRV.url, '-y']);
  ok('http URL prints unencrypted warning', r.code === 0 && /unencrypted/.test(r.out));

  // server reset to default
  r = await runCli(['server', 'reset', '-y']);
  cfg = readConfigRaw();
  ok('server reset back to default', r.code === 0 && (cfg.server_url === undefined || cfg.server_url === ''));

  // bot mode: server set does not touch bot config
  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242 });
  r = await runCli(['server', 'set', SRV.url, '-y']);
  cfg = readConfigRaw();
  ok('server set in bot mode keeps token, no re-setup note', r.code === 0 && cfg.bot_token === TG.token && !/one-time code/.test(r.out));

  // no -y, no tty -> error
  r = await runCli(['server', 'reset']);
  ok('confirm without tty and without -y errors', r.code === 1 && /interactive terminal/.test(r.err));
}

async function testSetupInProcess() {
  process.stdout.write('\n== setup (in-process, stubbed prompts) ==\n');
  const tty = require(path.join(ROOT, 'nodejs', 'lib', 'tty'));
  const setup = require(path.join(ROOT, 'nodejs', 'lib', 'commands', 'setup'));

  const origPrompt = tty.prompt;
  const origConfirm = tty.confirm;

  async function stub(answers, confirms) {
    const queue = answers.slice();
    let confirmQueue = (confirms || []).slice();
    tty.prompt = async function () { return queue.length ? queue.shift() : '\n'; };
    tty.confirm = async function () { return confirmQueue.length ? confirmQueue.shift() === 'y' : false; };
  }

  // --- own bot flow, /start detected via polling ---
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  await stub(['2', TG.token, '']);
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__push_after?n=2&user_id=4242&username=testuser');
  // silence dots
  const origWrite = process.stdout.write;
  process.stdout.write = function (c) { if (typeof c === 'string' && c === '.') return true; return origWrite.call(process.stdout, c); };
  try {
    await setup.run([], { yes: false });
  } finally {
    process.stdout.write = origWrite;
    tty.prompt = origPrompt;
    tty.confirm = origConfirm;
  }
  let cfg = readConfigRaw();
  let sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('setup bot: config saved', cfg && cfg.mode === 'bot' && cfg.user_id === 4242 && cfg.bot_token === TG.token);
  ok('setup bot: welcome message sent', sent.messages.some(function (m) { return /set up/.test(m.text); }));

  // --- own bot flow: 409 -> deleteWebhook -> timeout -> manual id fallback ---
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  writeConfig({});
  process.env.VISEND_TEST_WAIT_MS = '1500';
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__409?n=1');
  await stub(['2', TG.token, '777'], ['y']);
  process.stdout.write = function (c) { if (typeof c === 'string' && c === '.') return true; return origWrite.call(process.stdout, c); };
  try {
    await setup.run([], { yes: false });
  } finally {
    process.stdout.write = origWrite;
    tty.prompt = origPrompt;
    tty.confirm = origConfirm;
  }
  cfg = readConfigRaw();
  ok('setup bot: 409 -> manual id fallback', cfg && cfg.user_id === 777);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('setup bot: 409 path deleted webhook', sent.webhook_deleted === 1);
  delete process.env.VISEND_TEST_WAIT_MS;

  // --- shared server flow ---
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ server_url: SRV.url });
  await stub(['1', '4242', SRV.code]);
  try {
    await setup.run([], { yes: false });
  } finally {
    tty.prompt = origPrompt;
    tty.confirm = origConfirm;
  }
  cfg = readConfigRaw();
  const srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('setup server: config saved with token', cfg && cfg.mode === 'server' && cfg.user_id === 4242 && cfg.server_token === SRV.token);
  ok('setup server: welcome text sent through server', srvSent.texts.length === 1 && /set up/.test(srvSent.texts[0]));

  // --- wrong code ---
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ server_url: SRV.url });
  let caught = '';
  await stub(['1', '4242', 'WRONG']);
  try {
    await setup.run([], { yes: false });
  } catch (e) {
    caught = e.message;
  } finally {
    tty.prompt = origPrompt;
    tty.confirm = origConfirm;
  }
  ok('setup server: wrong code gives clear error', /wrong|code/i.test(caught));

  // --- server offline -> option disabled ---
  writeConfig({ server_url: 'http://127.0.0.1:9/x' });
  let looped = false;
  await stub(['1', '3']);
  try {
    await setup.run([], { yes: false });
  } catch (e) {
    looped = /cancelled/i.test(e.message);
  } finally {
    tty.prompt = origPrompt;
    tty.confirm = origConfirm;
  }
  ok('setup: server option disabled when offline', looped);
}

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  TG = await createMockTg(0);
  SRV = await createMockServer(0);
  // For in-process setup tests: point the CLI at the mocks and sandbox the home dir.
  process.env.VISEND_TELEGRAM_API_BASE = 'http://127.0.0.1:' + TG.port;
  process.env.HOME = SANDBOX;
  process.env.USERPROFILE = SANDBOX;
  process.stdout.write('mock telegram: 127.0.0.1:' + TG.port + '\n');
  process.stdout.write('mock server:   ' + SRV.url + '\n');

  await testBasics();
  await testBotMode();
  await testServerMode();
  await testSetupInProcess();

  process.stdout.write('\n================================\n');
  process.stdout.write('passed: ' + passed + ', failed: ' + failed + '\n');
  if (failed) {
    process.stdout.write('\nFailures:\n' + failures.join('\n') + '\n');
  }
  TG.server.close();
  SRV.server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  process.stderr.write('fatal: ' + (err && err.stack || err) + '\n');
  process.exit(2);
});
