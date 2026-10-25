import { SignJWT, jwtVerify } from 'jose';
import { config } from './config';

// Pairing tokens: two JWTs (HS256) carrying only user_id ("sub") and a
// "typ" claim (access | refresh) so one cannot be used in place of the
// other. The server keeps no token state; signature + typ + exp checks are
// the whole auth. "Logout everywhere" = rotate SERVER_SECRET.

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function key(): Uint8Array {
  return new TextEncoder().encode(config.serverSecret as string);
}

async function sign(userId: number, typ: 'access' | 'refresh', ttl: string): Promise<string> {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key());
}

export async function createTokenPair(userId: number): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    sign(userId, 'access', config.accessTokenTtl),
    sign(userId, 'refresh', config.refreshTokenTtl),
  ]);
  return { accessToken, refreshToken };
}

export type VerifyResult =
  | { ok: true; userId: number }
  | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyToken(
  token: string,
  expectedTyp: 'access' | 'refresh'
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    if (payload.typ !== expectedTyp) return { ok: false, reason: 'invalid' };
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reason: 'invalid' };
    return { ok: true, userId };
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: 'invalid' };
  }
}
