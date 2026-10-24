import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { CodeStore } from './codes';
import { createToken, verifyToken } from './auth';
import { TelegramError, getMe, sendMessage, sendDocument } from './telegram';

export function buildApp(deps: {
  codes: CodeStore;
  startedAt: number;
  botUsername: string | null;
}) {
  const app = express();
  app.disable('x-powered-by');

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

  const clientIp = (req: Request): string =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  function fail(res: Response, status: number, error: string, description?: string, extra?: object) {
    res.status(status).json({ ok: false, error, ...(description ? { description } : {}), ...extra });
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
        if (rateLimited(clientIp(req))) {
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
        const token = await createToken(userId);
        res.json({ ok: true, token });
      } catch (err) {
        next(err);
      }
    }
  );

  // ------------------------------ authenticated ------------------------------

  // Raw-bytes endpoints: accept any Content-Type (the body is the payload).
  // Clients may omit Content-Type entirely, hence type: () => true.
  const rawLimitMb = Math.ceil(config.maxFileSize / 1024 / 1024) + 1;
  const rawBody = express.raw({ type: () => true, limit: `${rawLimitMb}mb` });

  app.post(
    '/text',
    rawBody,
    async (req: Request, res: Response) => {
      const userId = await authAsync(req, res);
      if (userId === null) return;
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
    rawBody,
    async (req: Request, res: Response) => {
      const userId = await authAsync(req, res);
      if (userId === null) return;
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

  async function authAsync(req: Request, res: Response): Promise<number | null> {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      fail(res, 401, 'unauthorized', 'Missing Authorization: Bearer <token> header.');
      return null;
    }
    const userId = await verifyToken(match[1]);
    if (userId === null) {
      fail(res, 401, 'unauthorized', 'Invalid or revoked token. Run `visend setup` again.');
      return null;
    }
    return userId;
  }

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
    res.status(500).json({ ok: false, error: 'internal', description: String(err) });
  }

  app.use((_req: Request, res: Response) => {
    fail(res, 404, 'not_found', 'Unknown endpoint. See https://github.com/Vishota/visend');
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error:', err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'internal', description: err.message });
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
