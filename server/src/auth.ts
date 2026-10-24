import { SignJWT, jwtVerify } from 'jose';
import { config } from './config';

// Pairing tokens: JWT (HS256) carrying only user_id ("sub"). The server keeps
// no token state; signature check is the whole auth. "Logout everywhere" =
// rotate SERVER_SECRET - a deliberate tradeoff for a dev tool.

function key(): Uint8Array {
  return new TextEncoder().encode(config.serverSecret as string);
}

export async function createToken(userId: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .sign(key());
}

export async function verifyToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    return userId;
  } catch {
    return null;
  }
}
