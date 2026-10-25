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

// Fail-closed: a set variable that yields no valid ids must stop the server,
// not silently disable the allow list.
function parseAllowedUserIds(raw: string | undefined): { ids: Set<number> | null; error?: string } {
  if (raw === undefined || !raw.trim()) return { ids: null }; // not set / explicitly empty -> disabled on purpose
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) {
    return {
      ids: null,
      error: `ALLOWED_USER_IDS is set but contains no valid user ids: "${raw}"`,
    };
  }
  return { ids: new Set(ids) };
}

const allowList = parseAllowedUserIds(process.env.ALLOWED_USER_IDS);

const maxFileSize = Number(process.env.MAX_FILE_SIZE || 50 * 1024 * 1024);
const maxConcurrentUploads = Number(process.env.MAX_CONCURRENT_UPLOADS || 8);

export const config = {
  port: Number(process.env.PORT || 8080),
  telegramToken: readSecret('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
  serverSecret: readSecret('server_secret', 'SERVER_SECRET'),
  allowedUserIds: allowList.ids,
  allowedUserIdsError: allowList.error,
  maxFileSize: Number.isFinite(maxFileSize) && maxFileSize > 0 ? maxFileSize : 50 * 1024 * 1024,
  // Authorization + Content-Length are checked BEFORE the body is read;
  // this is how many in-flight uploads may occupy memory at once.
  maxConcurrentUploads:
    Number.isFinite(maxConcurrentUploads) && maxConcurrentUploads > 0 ? maxConcurrentUploads : 8,
  // X-Forwarded-For is only trusted behind an explicit opt-in.
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  telegramBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '24h',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || '180d',
  codeTtlMs: 60 * 60 * 1000, // 1 hour
  maxCodeAttempts: 5,
  connectRateLimit: 10, // requests per minute per IP
  version: '1.0.0',
};

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (config.allowedUserIdsError) problems.push(config.allowedUserIdsError);
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
