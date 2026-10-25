import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { CodeStore } from './codes';
import { createTokenPair, verifyToken } from './auth';
import { TelegramError, getMe, sendMessage, sendDocument } from './telegram';

export function buildApp(deps: {
  codes: CodeStore;
  startedAt: number;
  botUsername: string | null;
}) {
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when explicitly opted in (behind a TLS proxy).
  app.set('trust proxy', config.trustProxy ? 1 : false);

  // ---- tiny in-memory rate limiter for POST /connect: 10 req/min per IP ----
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [ip, stamps] of hits) {
      const fresh = stamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, 60000).unref();

  function rateLimited(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - 60000;
    const stamps = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (stamps.length >= config.connectRateLimit) {
      hits.set(ip, stamps);
      return true;
    }
    stamps.push(now);
    hits.set(ip, stamps);
    return false;
  }

  function fail(res: Response, status: number, error: string, description?: string, extra?: object) {
    res.status(status).json({ ok: false, error, ...(description ? { description } : {}), ...extra });
  }

  // ---- upload gate: auth + declared size BEFORE the body enters memory ----
  let inFlightUploads = 0;

  /**
   * Reject a request before its body is read. The response is flushed first
   * (with a short grace window) and only then the socket is torn down, so
   * the client reliably receives the error while megabytes never enter
   * memory: the request stream stays unconsumed and TCP backpressure stalls
   * the sender.
   */
  function rejectEarly(
    res: Response,
    req: Request,
    status: number,
    error: string,
    description: string,
    extra?: object
  ) {
    res.setHeader('Connection', 'close');
    res.status(status).json({ ok: false, error, description, ...(extra || {}) });
    const kill = () => req.destroy();
    res.on('finish', () => setTimeout(kill, 100).unref());
    setTimeout(kill, 15000).unref();
  }

  /**
   * Runs before express.raw: verifies the Bearer token and the declared
   * Content-Length from headers alone, so an anonymous or oversized request
   * is answered (and its connection dropped) without buffering megabytes.
   * Also caps how many uploads may be in flight at once.
   */
  function uploadGate(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      rejectEarly(res, req, 401, 'unauthorized', 'Missing Authorization: Bearer <token> header.');
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxFileSize) {
      rejectEarly(res, req, 413, 'file_too_large', 'The file exceeds the server size limit.', {
        max_file_size: config.maxFileSize,
      });
      return;
    }
    if (inFlightUploads >= config.maxConcurrentUploads) {
      rejectEarly(res, req, 429, 'too_many_uploads', 'Too many concurrent uploads; retry in a moment.');
      return;
    }
    verifyToken(match[1], 'access')
      .then((result) => {
        if (!result.ok) {
          const error = result.reason === 'expired' ? 'token_expired' : 'unauthorized';
          const description =
            result.reason === 'expired'
              ? 'Access token expired. Use the refresh token (POST /refresh) or run `visend setup` again.'
              : 'Invalid or revoked token. Run `visend setup` again.';
          rejectEarly(res, req, 401, error, description);
          return;
        }
        // Token is fine: read the body, then hand the user_id to the route.
        inFlightUploads++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            inFlightUploads--;
          }
        };
        res.on('finish', release);
        res.on('close', release);
        (req as Request & { userId?: number }).userId = result.userId;
        next();
      })
      .catch(() => {
        rejectEarly(res, req, 401, 'unauthorized', 'Invalid or revoked token. Run `visend setup` again.');
      });
  }

  // ------------------------------- public -------------------------------

  app.get('/status', (_req, res) => {
    res.json({
      ok: true,
      service: 'visend-server',
      version: config.version,
      uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    });
  });

  app.get('/config', (_req, res) => {
    // The bot link is fetched from Telegram (getMe), never hardcoded.
    const bot = deps.botUsername ? `https://t.me/${deps.botUsername}` : null;
    res.json({ ok: true, max_file_size: config.maxFileSize, bot });
  });

  app.post(
    '/connect',
    express.json({ limit: '4kb' }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (rateLimited(req.ip || req.socket.remoteAddress || 'unknown')) {
          fail(res, 429, 'rate_limited', 'Too many connect attempts from your IP; wait a minute.');
          return;
        }
        const userId = Number(req.body && req.body.user_id);
        const code = String((req.body && req.body.code) || '').toUpperCase();
        if (!Number.isInteger(userId) || userId <= 0 || !/^[A-Z0-9]{1,32}$/.test(code)) {
          fail(res, 400, 'bad_request', 'Body must be JSON: {"user_id": <number>, "code": "<string>"}');
          return;
        }
        if (config.allowedUserIds && !config.allowedUserIds.has(userId)) {
          fail(res, 403, 'not_allowed', 'This server is restricted; your user id is not on the allow list.');
          return;
        }
        const verdict = deps.codes.verify(userId, code);
        if (verdict === 'burned') {
          fail(res, 410, 'code_burned', 'Too many wrong attempts - the code is burned. Send /start to the bot for a new one.');
          return;
        }
        if (verdict !== 'ok') {
          fail(res, 403, 'invalid_code', 'Wrong code or user id. Send /start to the bot again.');
          return;
        }
        const pair = await createTokenPair(userId);
        res.json({ ok: true, token: pair.accessToken, refresh_token: pair.refreshToken });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/refresh',
    express.json({ limit: '1kb' }),
    async (req: Request, res: Response) => {
      const header = req.headers.authorization || '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) {
        fail(res, 401, 'unauthorized', 'Missing Authorization: Bearer <refresh token> header.');
        return;
      }
      const result = await verifyToken(match[1], 'refresh');
      if (!result.ok) {
        const error = result.reason === 'expired' ? 'token_expired' : 'unauthorized';
        fail(
          res,
          401,
          error,
          result.reason === 'expired'
            ? 'Refresh token expired. Run `visend setup` again.'
            : 'Invalid refresh token. Run `visend setup` again.'
        );
        return;
      }
      const pair = await createTokenPair(result.userId);
      res.json({ ok: true, token: pair.accessToken, refresh_token: pair.refreshToken });
    }
  );

  // ------------------------------ authenticated ------------------------------

  // Raw-bytes endpoints: accept any Content-Type (the body is the payload).
  // Clients may omit Content-Type entirely, hence type: () => true.
  const rawLimitMb = Math.ceil(config.maxFileSize / 1024 / 1024) + 1;
  const rawBody = express.raw({ type: () => true, limit: `${rawLimitMb}mb` });

  app.post(
    '/text',
    uploadGate,
    rawBody,
    async (req: Request, res: Response) => {
      const userId = (req as Request & { userId?: number }).userId as number;
      const body = req.body as Buffer;
      if (!body || !body.length || !body.toString('utf8').trim()) {
        fail(res, 400, 'empty_text', 'Request body is empty.');
        return;
      }
      try {
        const result = await sendMessage(userId, body.toString('utf8'));
        res.json({ ok: true, message_id: result.message_id });
      } catch (err) {
        telegramFailure(res, err);
      }
    }
  );

  app.post(
    '/file',
    uploadGate,
    rawBody,
    async (req: Request, res: Response) => {
      const userId = (req as Request & { userId?: number }).userId as number;
      const body = req.body as Buffer;
      if (!body || !body.length) {
        fail(res, 400, 'empty_file', 'Request body is empty.');
        return;
      }
      if (body.length > config.maxFileSize) {
        fail(res, 413, 'file_too_large', 'The file exceeds the server size limit.', {
          max_file_size: config.maxFileSize,
        });
        return;
      }
      const name = (req.query.name && String(req.query.name)) || 'visend.txt';
      try {
        const result = await sendDocument(userId, body, name);
        res.json({ ok: true, message_id: result.message_id });
      } catch (err) {
        telegramFailure(res, err);
      }
    }
  );

  function telegramFailure(res: Response, err: unknown) {
    if (err instanceof TelegramError) {
      // Telegram's own bot-side file limit.
      if (err.errorCode === 413 || /file is too big/i.test(err.message)) {
        fail(res, 413, 'file_too_large', 'Telegram rejected the file: ' + err.message);
        return;
      }
      if (err.errorCode === 403 && /bot was blocked|chat not found/i.test(err.message)) {
        fail(res, 422, 'chat_unavailable', 'The user has not started the bot or blocked it.');
        return;
      }
      res.status(502).json({ ok: false, error: 'telegram', description: err.message });
      return;
    }
    console.error('[http] internal error:', err);
    res.status(500).json({ ok: false, error: 'internal', description: 'Internal server error.' });
  }

  app.use((_req: Request, res: Response) => {
    fail(res, 404, 'not_found', 'Unknown endpoint. See https://github.com/vishota/visend');
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Full details go to the logs only; clients get a generic message.
    console.error('[http] unhandled error:', err.stack || err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'internal', description: 'Internal server error.' });
  });

  return app;
}

export async function fetchBotUsername(): Promise<string | null> {
  try {
    const me = await getMe();
    return me.username || null;
  } catch (err) {
    console.error('[startup] getMe failed:', (err as Error).message);
    return null;
  }
}
