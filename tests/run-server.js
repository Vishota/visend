'use strict';

// Integration test: the real TS server against the mock Telegram API.
// Usage: node tests/run-server.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { createMockTg } = require('./mock-tg');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');

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
      res.on('end', function () { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpJson(url, method, headers, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, headers: headers || {} },
      function (res) {
        let raw = '';
        res.on('data', function (c) { raw += c; });
        res.on('end', function () {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* keep null */ }
          resolve({ status: res.statusCode, json: json, raw: raw });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpGetJsonMock(url) {
  return httpGetJson(url).then(function (r) { return r.json; });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpGetJson(url);
      return true;
    } catch (e) {
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }
  return false;
}

async function main() {
  const tg = await createMockTg(0);
  process.stdout.write('mock telegram: 127.0.0.1:' + tg.port + '\n');

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      TELEGRAM_BOT_TOKEN: tg.token,
      SERVER_SECRET: 'integration-test-secret',
      TELEGRAM_API_BASE: 'http://127.0.0.1:' + tg.port,
      PORT: '0',
      MAX_FILE_SIZE: (1024 * 1024).toString(),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', function (c) { serverLog += c; });
  server.stderr.on('data', function (c) { serverLog += c; });

  const base = 'http://127.0.0.1:' + await new Promise(function (resolve) {
    const wait = setInterval(function () {
      const m = /listening on :(\\d+|\d+)/.exec(serverLog);
      if (m) { clearInterval(wait); resolve(m[1]); }
    }, 200);
    setTimeout(function () { clearInterval(wait); resolve(null); }, 15000);
  });

  if (!base) {
    ok('server starts', false, serverLog);
    tg.server.close();
    process.exit(1);
  }
  process.stdout.write('server: ' + base + '\n\n');
  const ready = await waitForServer(base + '/status', 10000);
  ok('server boots and /status responds', ready);

  // --- public endpoints ---
  let r = await httpGetJson(base + '/status');
  ok('status shape', r.status === 200 && r.json.ok === true && typeof r.json.uptime_seconds === 'number' && r.json.service === 'visend-server');

  r = await httpGetJson(base + '/config');
  ok('config shape + bot link from getMe', r.status === 200 && r.json.ok === true && r.json.bot === 'https://t.me/visend_test_bot' && r.json.max_file_size === 1024 * 1024);

  // --- bot /start issues a code ---
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__reset');
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__push?user_id=4242&text=/start');
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    await new Promise(function (res) { setTimeout(res, 250); });
    const sent = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
    for (const msg of sent.messages) {
      const m = /One-time code: ([A-Z0-9]{8})/.exec(msg.text || '');
      if (m) { code = m[1]; break; }
    }
  }
  ok('/start issues a code', !!code);
  ok('code alphabet has no 0/O/1/I', !!code && !/[0OI1]/.test(code));
  ok('bot replies with user id', !!code); // message contains "Your user id: 4242"

  // --- connect ---
  r = await httpJson(base + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 4242, code: 'WRONGWRONG'.slice(0, 8) }));
  ok('wrong code rejected 403', r.status === 403 && r.json.error === 'invalid_code', r.raw);

  // wrong code was consumed? no - code survives up to 5 attempts
  r = await httpJson(base + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 4242, code: code }));
  ok('connect returns token pair', r.status === 200 && r.json.ok === true && typeof r.json.token === 'string' && r.json.token.length > 20 && typeof r.json.refresh_token === 'string' && r.json.refresh_token.length > 20, r.raw);
  const token = r.json && r.json.token;
  const refreshToken = r.json && r.json.refresh_token;

  // code is one-time
  r = await httpJson(base + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 4242, code: code }));
  ok('code is one-time', r.status !== 200);

  // --- authenticated endpoints ---
  r = await httpJson(base + '/text', 'POST', { 'Content-Type': 'text/plain; charset=utf-8' }, 'hello through server');
  ok('text without token 401', r.status === 401 && r.json.error === 'unauthorized');

  r = await httpJson(base + '/text', 'POST', { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain; charset=utf-8' }, 'hello through server');
  ok('text with token delivered to telegram', r.status === 200 && r.json.ok === true && typeof r.json.message_id === 'number', r.raw);

  let sent = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
  ok('telegram received the text', sent.messages.some(function (m) { return m.text === 'hello through server'; }));

  r = await httpJson(base + '/file?name=report.bin', 'POST', { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, Buffer.from('binary-file-payload'));
  ok('file with token', r.status === 200 && r.json.ok === true, r.raw);

  sent = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
  ok('telegram received the file', sent.documents.some(function (d) { return d.filename === 'report.bin'; }));

  r = await httpJson(base + '/file?name=big.bin', 'POST', { Authorization: 'Bearer ' + token }, Buffer.alloc(2 * 1024 * 1024).fill(65));
  ok('file above server limit 413 + max_file_size', r.status === 413 && r.json && r.json.error === 'file_too_large' && r.json.max_file_size === 1024 * 1024, 'status=' + r.status + ' raw=' + String(r.raw).slice(0, 200));

  r = await httpJson(base + '/text', 'POST', { Authorization: 'Bearer ' + token }, '');
  ok('empty text 400', r.status === 400);

  // --- rate limit on /connect: 10/min per IP ---
  let saw429 = false;
  for (let i = 0; i < 15; i++) {
    r = await httpJson(base + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 999, code: 'AAAAAAAA' }));
    if (r.status === 429) { saw429 = true; break; }
  }
  ok('connect rate limit 429 after 10/min', saw429);

  // --- code burn after 5 wrong attempts + allow list + token persistence ---
  // Start the second instance WHILE the first is still polling: two pollers
  // on one bot token is the real 409 scenario.
  const server2 = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      TELEGRAM_BOT_TOKEN: tg.token,
      SERVER_SECRET: 'integration-test-secret',
      TELEGRAM_API_BASE: 'http://127.0.0.1:' + tg.port,
      ALLOWED_USER_IDS: '555',
      MAX_FILE_SIZE: '52428800',
      PORT: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log2 = '';
  server2.stdout.on('data', function (c) { log2 += c; });
  server2.stderr.on('data', function (c) { log2 += c; });
  const base2 = 'http://127.0.0.1:' + await new Promise(function (resolve) {
    const wait = setInterval(function () {
      const m = /listening on :(\\d+|\d+)/.exec(log2);
      if (m) { clearInterval(wait); resolve(m[1]); }
    }, 200);
    setTimeout(function () { clearInterval(wait); resolve(null); }, 20000);
  });
  if (!base2) {
    ok('second server starts', false, log2);
    server.kill();
    server2.kill();
    tg.server.close();
    process.exit(1);
  }
  await waitForServer(base2 + '/status', 10000);

  // 409 handling: deterministic - instruct the mock to answer 409 to the next
  // getUpdates call (whoever polls). The server must log a warning and retry.
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__409?n=1');
  let saw409 = false;
  for (let i = 0; i < 30 && !saw409; i++) {
    await new Promise(function (res) { setTimeout(res, 300); });
    saw409 = /\[polling\].*409/.test(log2) || /\[polling\].*409/.test(serverLog);
  }
  const polls = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__polls');
  ok('409 from telegram is logged as a warning, polling continues', saw409,
    'pollCount=' + polls.pollCount + ' inFlight=' + polls.inFlight +
    '\nserver2 tail: ' + log2.slice(-300) + '\nserver1 tail: ' + serverLog.slice(-300));
  // polling must survive the 409 (next polls succeed)
  let pollsAfter = polls.pollCount;
  let pollingAlive = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(function (res) { setTimeout(res, 500); });
    const now = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__polls');
    if (now.pollCount > pollsAfter) { pollingAlive = true; break; }
  }
  ok('polling continues after 409', pollingAlive);
  server.kill();
  await new Promise(function (res) { setTimeout(res, 500); });

  // push a fresh /start for 555 through the (shared) mock and burn it
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__reset');
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__push?user_id=555&text=/start');
  let freshCode = null;
  for (let i = 0; i < 40 && !freshCode; i++) {
    await new Promise(function (res) { setTimeout(res, 250); });
    const sent3 = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
    for (const msg of sent3.messages) {
      const m = /One-time code: ([A-Z0-9]{8})/.exec(msg.text || '');
      if (m) freshCode = m[1];
    }
  }
  let burned = false;
  for (let i = 0; i < 5; i++) {
    r = await httpJson(base2 + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 555, code: 'ZZZZZZZZ' }));
    if (r.status === 410 && r.json.error === 'code_burned') burned = true;
  }
  ok('code burns after 5 wrong attempts', burned, r && r.raw);

  if (freshCode) {
    r = await httpJson(base2 + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 555, code: freshCode }));
    ok('burned code no longer valid even if correct', r.status !== 200);
  }

  // allow list: user 4242 not on the list of server2
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__push?user_id=4242&text=/start');
  let code4242 = null;
  for (let i = 0; i < 40 && !code4242; i++) {
    await new Promise(function (res) { setTimeout(res, 250); });
    const sent4 = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
    for (const msg of sent4.messages) {
      const m = /One-time code: ([A-Z0-9]{8})/.exec(msg.text || '');
      if (m) code4242 = m[1];
    }
  }
  if (code4242) {
    r = await httpJson(base2 + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 4242, code: code4242 }));
    ok('allow list rejects other users', r.status === 403 && r.json.error === 'not_allowed');
  } else {
    ok('allow list rejects other users', false, 'no code issued for 4242 (bot replies rate?)');
  }

  // token from server1 (same secret) still valid on server2
  if (token) {
    r = await httpJson(base2 + '/text', 'POST', { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' }, 'token survives restart with same secret');
    ok('same secret => token survives restart', r.status === 200, r.raw);
  }

  // ====================== hardening: token lifecycle + gates ======================
  process.stdout.write('\n== hardening: refresh flow, early gates, concurrency ==\n');

  // --- /refresh semantics on server2 (access token cannot act as refresh) ---
  r = await httpJson(base2 + '/refresh', 'POST', { Authorization: 'Bearer ' + token }, '');
  ok('access token rejected on /refresh (typ separation)', r.status === 401, r.raw);

  r = await httpJson(base2 + '/refresh', 'POST', { Authorization: 'Bearer ' + refreshToken }, '');
  ok('refresh token -> new pair', r.status === 200 && r.json.token && r.json.refresh_token && r.json.token !== token, r.raw);
  const rotatedAccess = r.json && r.json.token;
  r = await httpJson(base2 + '/text', 'POST', { Authorization: 'Bearer ' + rotatedAccess, 'Content-Type': 'text/plain' }, 'rotated access works');
  ok('rotated access token works', r.status === 200, r.raw);

  // --- early gates: answered from headers alone, before any body is read ---
  function headOnly(url, method, headers) {
    return new Promise(function (resolve) {
      const u = new URL(url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, headers: headers },
        function (res) { resolve(res.statusCode); req.destroy(); }
      );
      req.on('error', function () { /* destroyed on purpose */ });
      // one byte flushes the headers; the (huge) declared body never arrives
      req.write('x');
    });
  }
  r = await headOnly(base2 + '/file?name=x', 'POST', { 'Content-Length': '999999999' });
  ok('no-auth request answered 401 before body read', r === 401, 'status=' + r);

  r = await headOnly(base2 + '/file?name=x', 'POST', { Authorization: 'Bearer ' + rotatedAccess, 'Content-Length': '999999999' });
  ok('oversized declared Content-Length answered 413 before body read', r === 413, 'status=' + r);

  // --- body-parser errors map to 400/413, not 500 ---
  r = await httpJson(base2 + '/connect', 'POST', { 'Content-Type': 'application/json' }, '{not json');
  ok('malformed JSON -> 400 bad_request (not 500)', r.status === 400 && r.json && r.json.error === 'bad_request',
    'status=' + r.status + ' raw=' + String(r.raw).slice(0, 120));

  // --- X-Forwarded-For is NOT trusted without TRUST_PROXY (rate limit holds) ---
  // Runs BEFORE server3 spawns: while two pollers are alive, both servers
  // consume /start updates and issue their own codes, making code extraction
  // racy. server2 is killed here so server3 becomes the sole poller.
  let saw429xff = false;
  for (let i = 0; i < 12; i++) {
    r = await httpJson(base2 + '/connect', 'POST',
      { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.' + i },
      JSON.stringify({ user_id: 31337, code: 'ZZZZZZZZ' }));
    if (r.status === 429) { saw429xff = true; break; }
  }
  ok('spoofed X-Forwarded-For does not bypass rate limit', saw429xff);

  server2.kill();
  await new Promise(function (res) { setTimeout(res, 500); });

  // --- real token expiry + client-style refresh on a short-TTL instance ---
  const server3 = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      TELEGRAM_BOT_TOKEN: tg.token,
      SERVER_SECRET: 'integration-test-secret',
      TELEGRAM_API_BASE: 'http://127.0.0.1:' + tg.port,
      ACCESS_TOKEN_TTL: '1s',
      REFRESH_TOKEN_TTL: '1000d',
      MAX_CONCURRENT_UPLOADS: '1',
      PORT: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log3 = '';
  server3.stdout.on('data', function (c) { log3 += c; });
  server3.stderr.on('data', function (c) { log3 += c; });
  const base3 = 'http://127.0.0.1:' + await new Promise(function (resolve) {
    const wait = setInterval(function () {
      const m = /listening on :(\\d+|\d+)/.exec(log3);
      if (m) { clearInterval(wait); resolve(m[1]); }
    }, 200);
    setTimeout(function () { clearInterval(wait); resolve(null); }, 15000);
  });
  await waitForServer(base3 + '/status', 10000);

  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__push?user_id=777&text=/start');
  let code3 = null;
  for (let i = 0; i < 40 && !code3; i++) {
    await new Promise(function (res) { setTimeout(res, 250); });
    const s = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
    for (const msg of s.messages) {
      const m = /One-time code: ([A-Z0-9]{8})/.exec(msg.text || '');
      if (m) code3 = m[1];
    }
  }
  r = await httpJson(base3 + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 777, code: code3 }));
  const shortAccess = r.json && r.json.token;
  const shortRefresh = r.json && r.json.refresh_token;
  r = await httpJson(base3 + '/text', 'POST', { Authorization: 'Bearer ' + shortAccess, 'Content-Type': 'text/plain' }, 'fresh short token works');
  ok('short-TTL access works right after connect', r.status === 200, r.raw);

  await new Promise(function (res) { setTimeout(res, 1600); });
  r = await httpJson(base3 + '/text', 'POST', { Authorization: 'Bearer ' + shortAccess, 'Content-Type': 'text/plain' }, 'expired?');
  ok('expired access -> 401 token_expired', r.status === 401 && r.json.error === 'token_expired', r.raw);

  r = await httpJson(base3 + '/refresh', 'POST', { Authorization: 'Bearer ' + shortRefresh }, '');
  ok('refresh revives the pair after expiry', r.status === 200 && r.json.token, r.raw);
  r = await httpJson(base3 + '/text', 'POST', { Authorization: 'Bearer ' + r.json.token, 'Content-Type': 'text/plain' }, 'after refresh');
  ok('text works after refresh', r.status === 200, r.raw);

  // --- concurrency cap: MAX_CONCURRENT_UPLOADS=1 + held sendDocument ---
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__holdsend?ms=800');
  // fresh one-time code (the previous one was consumed)
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__push?user_id=777&text=/start');
  let code3b = null;
  for (let i = 0; i < 40 && !code3b; i++) {
    await new Promise(function (res) { setTimeout(res, 250); });
    const s = await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__sent');
    for (const msg of s.messages) {
      const m = /One-time code: ([A-Z0-9]{8})/.exec(msg.text || '');
      if (m && m[1] !== code3) code3b = m[1];
    }
  }
  const pair = await httpJson(base3 + '/connect', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ user_id: 777, code: code3b }));
  const cAccess = pair.json && pair.json.token;
  const slow1 = httpJson(base3 + '/file?name=a.bin', 'POST', { Authorization: 'Bearer ' + cAccess }, Buffer.alloc(1024).fill(1));
  const slow2 = httpJson(base3 + '/file?name=b.bin', 'POST', { Authorization: 'Bearer ' + cAccess }, Buffer.alloc(1024).fill(2));
  const [s1, s2] = await Promise.all([slow1, slow2]);
  const statuses = [s1.status, s2.status].sort();
  ok('second concurrent upload gets 429 (cap=1)', statuses[0] === 200 && statuses[1] === 429, JSON.stringify(statuses));
  await httpGetJsonMock('http://127.0.0.1:' + tg.port + '/__holdsend?ms=0');
  server3.kill();

  // --- ALLOWED_USER_IDS fail-closed: garbage value must stop the server ---
  const server4 = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      TELEGRAM_BOT_TOKEN: tg.token,
      SERVER_SECRET: 'integration-test-secret',
      TELEGRAM_API_BASE: 'http://127.0.0.1:' + tg.port,
      ALLOWED_USER_IDS: 'abc,def',
      PORT: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log4 = '';
  server4.stdout.on('data', function (c) { log4 += c; });
  server4.stderr.on('data', function (c) { log4 += c; });
  const exit4 = await new Promise(function (resolve) {
    server4.on('close', function (code) { resolve(code); });
    setTimeout(function () { resolve('timeout'); }, 10000);
  });
  ok('garbage ALLOWED_USER_IDS refuses to start (fail-closed)',
    exit4 !== 'timeout' && exit4 !== 0 && /ALLOWED_USER_IDS/.test(log4),
    'exit=' + exit4 + ' log=' + log4.slice(-200));
  server4.kill();
  tg.server.close();

  process.stdout.write('\n================================\n');
  process.stdout.write('server: passed: ' + passed + ', failed: ' + failed + '\n');
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  process.stderr.write('fatal: ' + (err && err.stack || err) + '\n');
  process.exit(2);
});
