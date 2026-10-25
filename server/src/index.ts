import { config, validateConfig } from './config';
import { CodeStore } from './codes';
import { buildApp, fetchBotUsername } from './app';
import { startPolling, setMyCommands, sendMessage, TelegramError } from './telegram';
import http from 'http';

async function main() {
  const problems = validateConfig();
  if (problems.length) {
    for (const p of problems) console.error('Config error:', p);
    process.exit(1);
  }

  const startedAt = Date.now();
  const codes = new CodeStore();

  console.log('[startup] visend-server', config.version);
  console.log('[startup] fetching bot identity via getMe ...');
  const botUsername = await fetchBotUsername();
  if (!botUsername) {
    console.error('[startup] getMe failed - check TELEGRAM_BOT_TOKEN. Exiting.');
    process.exit(1);
  }
  console.log(`[startup] bot: @${botUsername} (${`https://t.me/${botUsername}`})`);

  if (config.allowedUserIds) {
    console.log('[startup] allow list:', [...config.allowedUserIds].join(', '));
  } else {
    console.log('[startup] allow list: disabled (any Telegram user may pair)');
  }
  console.log(
    `[startup] tokens: access ${config.accessTokenTtl}, refresh ${config.refreshTokenTtl} (rotating)`
  );

  try {
    await setMyCommands();
    console.log('[startup] bot commands registered (/start, /status)');
  } catch (err) {
    console.error('[startup] setMyCommands failed:', (err as Error).message);
  }

  function humanTtl(ms: number): string {
    const minutes = Math.round(ms / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
  }

  const polling = startPolling({
    onStart: (userId) => {
      const { code, expiresAt } = codes.issue(userId);
      const ttlLeft = Math.max(0, expiresAt - Date.now());
      console.log(`[bot] /start from ${userId}: issued code (valid ${humanTtl(ttlLeft)})`);
      sendSafe(
        userId,
        `Your user id: ${userId}\n` +
          `One-time code: ${code}\n` +
          `Valid for ~${humanTtl(config.codeTtlMs)}.\n\n` +
          `Run \`visend setup\` on your machine, choose "shared server" and enter these two values.`
      );
    },
    onAnyMessage: (userId) => {
      sendSafe(userId, `Your user id: ${userId}\nSend /start to get a one-time pairing code for visend.`);
    },
    onStatus: (userId) => {
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      sendSafe(userId, `visend-server is up.\nUptime: ${h}h ${m}m`);
    },
  });

  function sendSafe(userId: number, text: string) {
    sendMessage(userId, text).catch((err: Error) => {
      console.error(`[bot] reply to ${userId} failed: ${(err as TelegramError).message}`);
    });
  }

  const app = buildApp({ codes, startedAt, botUsername });
  const server = http.createServer(app);
  server.listen(config.port, () => {
    const addr = server.address();
    const shown = addr && typeof addr === 'object' ? addr.port : config.port;
    console.log(`[http] listening on :${shown} (status, config, connect, text, file)`);
  });

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, stopping ...`);
    polling.stop();
    server.close(() => {
      console.log('[shutdown] done');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 30000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
