import fs from 'fs';

/** Read a docker secret (/run/secrets/<name>) with an env fallback. */
function readSecret(secretName: string, envName: string): string | undefined {
  try {
    const value = fs.readFileSync(`/run/secrets/${secretName}`, 'utf8').trim();
    if (value) return value;
  } catch {
    /* no secret file */
  }
  const env = process.env[envName];
  return env && env.trim() ? env.trim() : undefined;
}

function parseAllowedUserIds(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
}

const maxFileSize = Number(process.env.MAX_FILE_SIZE || 50 * 1024 * 1024);

export const config = {
  port: Number(process.env.PORT || 8080),
  telegramToken: readSecret('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
  serverSecret: readSecret('server_secret', 'SERVER_SECRET'),
  allowedUserIds: parseAllowedUserIds(process.env.ALLOWED_USER_IDS),
  maxFileSize: Number.isFinite(maxFileSize) && maxFileSize > 0 ? maxFileSize : 50 * 1024 * 1024,
  telegramBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  codeTtlMs: 60 * 60 * 1000, // 1 hour
  maxCodeAttempts: 5,
  connectRateLimit: 10, // requests per minute per IP
  version: '1.0.0',
};

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.telegramToken) {
    problems.push(
      'TELEGRAM_BOT_TOKEN is not set. Provide it via docker secret "telegram_bot_token" or env TELEGRAM_BOT_TOKEN.'
    );
  }
  if (!config.serverSecret) {
    problems.push(
      'SERVER_SECRET is not set. Provide it via docker secret "server_secret" or env SERVER_SECRET. ' +
        'It signs pairing tokens: keep it stable across restarts (tokens stay valid), change it to revoke all tokens.'
    );
  }
  return problems;
}
