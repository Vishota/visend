'use strict';

// E2E tests for the powershell implementation (Windows PowerShell 5.1).
// Usage: node tests/run-ps.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { createMockTg } = require('./mock-tg');
const { createMockServer } = require('./mock-server');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'powershell', 'visend.ps1');
const SANDBOX = path.join(__dirname, '.tmp', 'ps-home-' + process.pid);

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

function runPs(args, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const env = Object.assign({}, process.env, {
      USERPROFILE: SANDBOX,
      HOME: SANDBOX,
      VISEND_TELEGRAM_API_BASE: 'http://127.0.0.1:' + TG.port,
    }, opts.env || {});
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT].concat(args), { env: env });
    let out = '';
    let err = '';
    child.stdout.on('data', function (c) { out += c; });
    child.stderr.on('data', function (c) { err += c; });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
    child.on('close', function (code) { resolve({ code: code, out: out, err: err }); });
    child.on('error', function (e) { resolve({ code: -1, out: out, err: String(e) }); });
  });
}

function writeConfig(cfg) {
  const dir = path.join(SANDBOX, '.config', 'visend');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

let TG, SRV;

async function main() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  TG = await createMockTg(0);
  SRV = await createMockServer(0);
  process.stdout.write('ps e2e: tg=127.0.0.1:' + TG.port + ' srv=' + SRV.url + '\n');

  process.stdout.write('\n== basics ==\n');
  let r = await runPs(['help']);
  ok('help', r.code === 0 && /Usage:/.test(r.out), r.out + r.err);

  r = await runPs(['frobnicate']);
  ok('unknown command', r.code === 1 && /Unknown command/.test(r.out + r.err), r.out + r.err);

  r = await runPs(['text'], { stdin: '' });
  ok('text empty stdin -> hint', r.code === 1 && /Nothing to send/.test(r.out + r.err), r.out + r.err);

  r = await runPs([], { stdin: 'x' });
  ok('not configured -> setup hint', r.code === 1 && /visend setup/.test(r.out + r.err), r.out + r.err);

  process.stdout.write('\n== bot mode ==\n');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242 });

  r = await runPs([], { stdin: 'hello ps\r\n' });
  let sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped text', r.code === 0 && sent.messages.length === 1 && /hello ps/.test(sent.messages[0].text), r.out + r.err);

  r = await runPs(['text', 'hello', 'world']);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('args joined', r.code === 0 && sent.messages[1] && sent.messages[1].text === 'hello world', r.out + r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['text', 'arg wins'], { stdin: 'stdin data' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('arg wins + warning', r.code === 0 && /stdin ignored/.test(r.out) && sent.messages[0].text === 'arg wins', r.out + r.err);

  const longText = new Array(4200).fill('a').join('');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('long -> visend.txt', r.code === 0 && sent.documents.length === 1 && sent.documents[0].filename === 'visend.txt' && /4096/.test(r.out), r.out + r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['text', '--force-as-text'], { stdin: longText });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('force-as-text truncates to 4096', r.code === 0 && sent.messages.length === 1 && sent.messages[0].text.length === 4096, r.out + r.err);

  const binaryBuf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.from('garbage')]);
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['text', '-y'], { stdin: binaryBuf });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('binary -y sends after warning', r.code === 0 && sent.messages.length === 1 && /binary/.test(r.out), r.out + r.err);

  const tmpFile = path.join(__dirname, '.tmp', 'ps-sample.bin');
  fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
  fs.writeFileSync(tmpFile, 'file-content-ps');
  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['file', tmpFile]);
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('file path + original name', r.code === 0 && sent.documents.length === 1 && sent.documents[0].filename === 'ps-sample.bin', r.out + r.err);

  await httpGetJson('http://127.0.0.1:' + TG.port + '/__reset');
  r = await runPs(['file', '--name', 'custom.txt'], { stdin: 'piped data' });
  sent = await httpGetJson('http://127.0.0.1:' + TG.port + '/__sent');
  ok('piped file custom name', r.code === 0 && sent.documents[0].filename === 'custom.txt', r.out + r.err);

  r = await runPs(['settings']);
  ok('settings masks token', r.code === 0 && /own bot/.test(r.out) && !/TEST_TOKEN/.test(r.out), r.out + r.err);

  writeConfig({ mode: 'bot', bot_token: TG.token, user_id: 4242, server_url: 'http://example.org' });
  r = await runPs(['forget', '-y']);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8')); } catch (e) { /* deleted */ }
  ok('forget -y keeps only server_url', r.code === 0 && raw && raw.server_url === 'http://example.org' && !raw.mode, r.out + r.err);

  process.stdout.write('\n== server mode ==\n');
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });

  r = await runPs([], { stdin: 'via server ps\r\n' });
  let srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('server text', r.code === 0 && srvSent.texts.length === 1 && /via server ps/.test(srvSent.texts[0]), r.out + r.err);

  await httpGetJson(SRV.url + '/__reset');
  r = await runPs(['file', '--name', 'x.bin'], { stdin: 'filebytes!!' });
  srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('server file', r.code === 0 && srvSent.files.length === 1 && srvSent.files[0].name === 'x.bin' && srvSent.files[0].size === 11, r.out + r.err);

  await httpGetJson(SRV.url + '/__setlimit?bytes=4');
  r = await runPs(['file'], { stdin: 'way more than four bytes' });
  ok('server limit message', r.code === 1 && /server-side limit/.test(r.out + r.err), r.out + r.err);
  await httpGetJson(SRV.url + '/__setlimit?bytes=' + (50 * 1024 * 1024));

  r = await runPs(['server']);
  ok('server show online + bot', r.code === 0 && /online/.test(r.out) && /t\.me\/visend_test_bot/.test(r.out), r.out + r.err);

  const mock2 = await createMockServer(0);
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });
  r = await runPs(['server', 'set', mock2.url, '-y']);
  let cfg2 = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8'));
  ok('server set wipes token + note', r.code === 0 && !cfg2.server_token && /one-time code/.test(r.out), r.out + r.err);
  mock2.server.close();

  r = await runPs(['server', 'set', SRV.url, '-y']);
  ok('http warning', r.code === 0 && /unencrypted/.test(r.out), r.out + r.err);

  r = await runPs(['server', 'reset', '-y']);
  cfg2 = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8'));
  ok('server reset', r.code === 0 && !cfg2.server_url, r.out + r.err);

  // --- binary stdin must survive byte-exact (raw copy, no line decoding) ---
  process.stdout.write('\n== raw stdin ==\n');
  const crypto = require('crypto');
  const bin = Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a, 0xff, 0xfe, 0x41]);
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({ mode: 'server', user_id: 4242, server_token: SRV.token, server_url: SRV.url });
  r = await runPs(['file', '--name', 'raw.bin', '-y'], { stdin: bin });
  srvSent = await httpGetJson(SRV.url + '/__sent');
  const binSha = crypto.createHash('sha256').update(bin).digest('hex');
  ok('binary stdin preserved byte-exact (CRLF and 0xFF intact)',
    r.code === 0 && srvSent.files.length === 1 && srvSent.files[0].sha256 === binSha,
    r.out + r.err + JSON.stringify(srvSent.files));

  // text via native stdin keeps its CRLF as-is
  await httpGetJson(SRV.url + '/__reset');
  r = await runPs([], { stdin: 'line1\r\nline2\r\n' });
  srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('CRLF in native stdin is not mangled',
    r.code === 0 && srvSent.texts.length === 1 && srvSent.texts[0] === 'line1\r\nline2\r\n',
    JSON.stringify(srvSent.texts) + r.out + r.err);

  // --- refresh flow ---
  process.stdout.write('\n== refresh flow ==\n');
  await httpGetJson(SRV.url + '/__reset');
  writeConfig({
    mode: 'server', user_id: 4242,
    server_token: 'expired-access-token', server_refresh_token: SRV.refresh,
    server_url: SRV.url,
  });
  await httpGetJson(SRV.url + '/__expire?token=expired-access-token');
  r = await runPs([], { stdin: 'after refresh ps\r\n' });
  let psCfg = null;
  try { psCfg = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.config', 'visend', 'config.json'), 'utf8')); } catch (e) { /* - */ }
  srvSent = await httpGetJson(SRV.url + '/__sent');
  ok('401 -> auto-refresh -> retry -> persist',
    r.code === 0 && srvSent.texts.length === 1 &&
    psCfg && psCfg.server_token && psCfg.server_token !== 'expired-access-token' &&
    psCfg.server_refresh_token === SRV.refresh,
    r.out + r.err);

  process.stdout.write('\n================================\n');
  process.stdout.write('powershell: passed: ' + passed + ', failed: ' + failed + '\n');
  TG.server.close();
  SRV.server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  process.stderr.write('fatal: ' + (err && err.stack || err) + '\n');
  process.exit(2);
});
