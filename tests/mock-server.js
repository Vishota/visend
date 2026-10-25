'use strict';

// Mock of the visend proxy server for CLI tests. Pure node core.
//
// Endpoints mirror the real server contract:
//   GET  /status   {ok, uptime_seconds}
//   GET  /config   {ok, max_file_size, bot}
//   POST /connect  {user_id, code} -> {ok, token, refresh_token}; code must be TESTCODE
//   POST /refresh  Bearer <refresh token> -> {ok, token, refresh_token} (rotating access)
//   POST /text     Bearer <access token>, raw utf-8 body
//   POST /file?name=...  Bearer <access token>, raw bytes
// Admin: /__sent, /__reset, /__setlimit?bytes=, /__offline=1|0, /__expire?token=

const http = require('http');
const crypto = require('crypto');

function createMockServer(port) {
  const VALID_CODE = 'TESTCODE';
  const VALID_REFRESH = 'srv-test-refresh';
  const VALID_TOKEN = 'srv-test-token';
  let limitBytes = 50 * 1024 * 1024;
  let offline = false;
  let failedAttempts = {};
  let freshCounter = 0;
  const issued = new Set([VALID_TOKEN]);
  const expired = new Set();
  const sent = { texts: [], files: [], connects: 0, refreshes: 0 };

  function authCheck(req) {
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return 'unauthorized';
    const token = m[1];
    if (expired.has(token)) return 'token_expired';
    if (token === VALID_REFRESH) return 'unauthorized'; // refresh in place of access
    if (!issued.has(token)) return 'unauthorized';
    return 'ok';
  }

  const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    let body = [];
    req.on('data', function (c) { body.push(c); });
    req.on('end', function () {
      body = Buffer.concat(body);
      res.setHeader('Content-Type', 'application/json');
      function json(obj, status) {
        res.statusCode = status || 200;
        res.end(JSON.stringify(obj));
      }
      if (p.startsWith('/__')) {
        if (p === '/__sent') return json(sent);
        if (p === '/__reset') {
          limitBytes = 50 * 1024 * 1024;
          offline = false;
          failedAttempts = {};
          issued.clear();
          issued.add(VALID_TOKEN);
          expired.clear();
          freshCounter = 0;
          sent.texts = [];
          sent.files = [];
          sent.connects = 0;
          sent.refreshes = 0;
          return json({ ok: true });
        }
        if (p === '/__setlimit') { limitBytes = Number(u.searchParams.get('bytes')); return json({ ok: true }); }
        if (p === '/__offline') { offline = u.searchParams.get('v') === '1'; return json({ ok: true }); }
        if (p === '/__expire') { expired.add(u.searchParams.get('token')); return json({ ok: true }); }
        return json({ ok: false }, 404);
      }
      if (offline) return json({ ok: false, description: 'offline' }, 503);
      if (p === '/status' && req.method === 'GET') {
        return json({ ok: true, service: 'visend-server', version: 'test', uptime_seconds: 42 });
      }
      if (p === '/config' && req.method === 'GET') {
        return json({ ok: true, max_file_size: limitBytes, bot: 'https://t.me/visend_test_bot' });
      }
      if (p === '/connect' && req.method === 'POST') {
        sent.connects++;
        let parsed = {};
        try { parsed = JSON.parse(body.toString('utf8')); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
        if (String(parsed.code || '').toUpperCase() !== VALID_CODE) {
          failedAttempts[parsed.user_id] = (failedAttempts[parsed.user_id] || 0) + 1;
          if (failedAttempts[parsed.user_id] >= 5) {
            return json({ ok: false, error: 'code_burned', description: 'code burned' }, 410);
          }
          return json({ ok: false, error: 'invalid_code', description: 'wrong code' }, 403);
        }
        return json({ ok: true, token: VALID_TOKEN, refresh_token: VALID_REFRESH });
      }
      if (p === '/refresh' && req.method === 'POST') {
        sent.refreshes++;
        const auth = req.headers['authorization'] || '';
        if (auth !== 'Bearer ' + VALID_REFRESH) {
          return json({ ok: false, error: 'unauthorized', description: 'bad refresh token' }, 401);
        }
        freshCounter++;
        const fresh = 'srv-test-token-fresh-' + freshCounter;
        issued.add(fresh);
        return json({ ok: true, token: fresh, refresh_token: VALID_REFRESH });
      }
      const verdict = authCheck(req);
      if (verdict !== 'ok') {
        return json({ ok: false, error: verdict, description: verdict === 'token_expired' ? 'access token expired' : 'bad token' }, 401);
      }
      if (p === '/text' && req.method === 'POST') {
        if (!body.length) return json({ ok: false, error: 'empty_text' }, 400);
        sent.texts.push(body.toString('utf8'));
        return json({ ok: true, message_id: 11 });
      }
      if (p === '/file' && req.method === 'POST') {
        if (body.length > limitBytes) {
          return json({ ok: false, error: 'file_too_large', description: 'too big', max_file_size: limitBytes }, 413);
        }
        sent.files.push({
          name: u.searchParams.get('name'),
          size: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
        });
        return json({ ok: true, message_id: 12 });
      }
      return json({ ok: false, description: 'Not found' }, 404);
    });
  });

  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () {
      resolve({
        server: server,
        port: server.address().port,
        url: 'http://127.0.0.1:' + server.address().port,
        code: VALID_CODE,
        token: VALID_TOKEN,
        refresh: VALID_REFRESH,
      });
    });
  });
}

module.exports = { createMockServer: createMockServer };

if (require.main === module) {
  createMockServer(Number(process.argv[2] || 0)).then(function (s) {
    process.stdout.write(String(s.port));
  });
}
