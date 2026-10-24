'use strict';

// Mock of the Telegram Bot API for tests. Pure node core, no deps.
//
// Bot endpoints (token must equal MOCK_TOKEN):
//   getMe, getUpdates, sendMessage, sendDocument, deleteWebhook
// Admin endpoints (for the test driver):
//   GET /__push?user_id=&username=&text=   queue an update
//   GET /__push_after?n=&user_id=&username=&text=  queue once getUpdates was called n times
//   GET /__sent    snapshot of sendMessage/sendDocument calls
//   GET /__reset

const http = require('http');

const MOCK_TOKEN = '123456789:TEST_TOKEN_AAAABBBBBBCCCCDDDDDD';

function safeDecode(v) {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { return v; }
}

function createMockTg(port) {
  let nextUpdateId = 100;
  let updates = [];
  let pollCount = 0;
  let getUpdatesInFlight = 0;
  let pendingPush = null; // {after, payload}
  let conflictNext = 0; // number of getUpdates calls that answer 409
  const sent = { messages: [], documents: [], webhook_deleted: 0 };

  function maybeDelayedPush() {
    if (pendingPush && pollCount >= pendingPush.after) {
      updates.push(pendingPush.payload);
      pendingPush = null;
    }
  }

  const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    res.setHeader('Content-Type', 'application/json');

    function json(obj, status) {
      res.statusCode = status || 200;
      res.end(JSON.stringify(obj));
    }

    if (p.startsWith('/__')) {
      if (p === '/__push' || p === '/__push_after') {
        const userId = Number(u.searchParams.get('user_id') || '4242');
        const payload = {
          update_id: nextUpdateId++,
          message: {
            message_id: 1,
            from: { id: userId, username: u.searchParams.get('username') || undefined },
            chat: { id: userId, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: u.searchParams.get('text') || '/start',
          },
        };
        if (p === '/__push') updates.push(payload);
        else pendingPush = { after: Number(u.searchParams.get('n') || '2'), payload: payload };
        return json({ ok: true });
      }
      if (p === '/__sent') return json(sent);
      if (p === '/__polls') return json({ pollCount: pollCount, inFlight: getUpdatesInFlight });
      if (p === '/__reset') {
        updates = [];
        pollCount = 0;
        pendingPush = null;
        getUpdatesInFlight = 0;
        sent.messages = [];
        sent.documents = [];
        sent.webhook_deleted = 0;
        conflictNext = 0;
        return json({ ok: true });
      }
      if (p === '/__409') { conflictNext = Number(u.searchParams.get('n') || '1'); return json({ ok: true }); }
      return json({ ok: false }, 404);
    }

    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(p);
    if (!m) return json({ ok: false, description: 'Not found' }, 404);
    const token = m[1];
    const method = m[2];
    if (token !== MOCK_TOKEN) {
      return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    }
    if (method === 'getMe') {
      return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'visend test bot', username: 'visend_test_bot' } });
    }
    if (method === 'getUpdates') {
      pollCount++;
      maybeDelayedPush();
      if (conflictNext > 0) {
        conflictNext--;
        return json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 409);
      }
      // Real Telegram answers 409 when another getUpdates is still in flight.
      if (getUpdatesInFlight > 0) {
        return json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 409);
      }
      getUpdatesInFlight++;
      const offset = u.searchParams.has('offset') || req.headers['content-type'] === 'application/json';
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        let off = u.searchParams.get('offset');
        if (off === null && body) {
          try { off = JSON.parse(body).offset; } catch (e) { off = null; }
        }
        const from = off === null || off === undefined ? 0 : Number(off);
        const matched = updates.filter(function (up) { return up.update_id >= from; });
        // Emulate long polling: hold briefly when there is nothing to return.
        setTimeout(function () {
          getUpdatesInFlight--;
          json({ ok: true, result: matched });
        }, matched.length ? 0 : 150);
      });
      return;
    }
    if (method === 'sendMessage' || method === 'sendDocument') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        if (method === 'sendMessage') {
          let chatId = null;
          let text = null;
          try {
            const parsed = JSON.parse(body);
            chatId = String(parsed.chat_id);
            text = parsed.text;
          } catch (e) {
            const m2 = /chat_id=([^&]*)/.exec(body);
            if (m2) chatId = safeDecode(m2[1]);
            const m3 = /text=([^&]*)/.exec(body);
            if (m3) text = safeDecode(m3[1]);
          }
          sent.messages.push({ chat_id: chatId, text: text });
        } else {
          // curl quotes the filename, .NET HttpClient does not (and adds filename*).
          const fn = /filename="?([^";\r\n]*)"?/.exec(body);
          sent.documents.push({
            filename: fn ? fn[1] : null,
            size: body.length,
            chat_id: (/name="chat_id"\r\n\r\n(\d+)/.exec(body) || /name=chat_id\r\n\r\n(\d+)/.exec(body) || [])[1],
          });
        }
        json({ ok: true, result: { message_id: 777 } });
      });
      return;
    }
    if (method === 'deleteWebhook') {
      sent.webhook_deleted++;
      return json({ ok: true, result: true });
    }
    return json({ ok: false, error_code: 404, description: 'Method not found' }, 404);
  });

  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port, token: MOCK_TOKEN });
    });
  });
}

module.exports = { createMockTg: createMockTg, MOCK_TOKEN: MOCK_TOKEN };

if (require.main === module) {
  createMockTg(Number(process.argv[2] || 0)).then(function (mock) {
    process.stdout.write(String(mock.port));
  });
}
