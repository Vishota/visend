'use strict';

// Mock of the visend proxy server for CLI tests. Pure node core.
//
// Endpoints mirror the real server contract:
//   GET  /status   {ok, uptime_seconds}
//   GET  /config   {ok, max_file_size, bot}
//   POST /connect  {user_id, code} -> {ok, token}; code must be TESTCODE
//   POST /text     Bearer <token>, raw utf-8 body
//   POST /file?name=...  Bearer <token>, raw bytes
// Admin: /__sent, /__reset, /__setlimit?bytes=, /__offline=1|0

const http = require('http');

function createMockServer(port) {
  const VALID_CODE = 'TESTCODE';
  const VALID_TOKEN = 'srv-test-token';
  let limitBytes = 50 * 1024 * 1024;
  let offline = false;
  let failedAttempts = {};
  const sent = { texts: [], files: [], connects: 0 };

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
          sent.texts = [];
          sent.files = [];
          sent.connects = 0;
          return json({ ok: true });
        }
        if (p === '/__setlimit') { limitBytes = Number(u.searchParams.get('bytes')); return json({ ok: true }); }
        if (p === '/__offline') { offline = u.searchParams.get('v') === '1'; return json({ ok: true }); }
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
        return json({ ok: true, token: VALID_TOKEN });
      }
      const auth = req.headers['authorization'] || '';
      if (auth !== 'Bearer ' + VALID_TOKEN) {
        return json({ ok: false, error: 'unauthorized', description: 'bad token' }, 401);
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
        sent.files.push({ name: u.searchParams.get('name'), size: body.length });
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
