import crypto from 'crypto';
import { config } from './config';

// 8-char one-time pairing codes: [A-Z0-9] without look-alikes 0/O and 1/I.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface CodeEntry {
  code: string;
  expiresAt: number;
  failedAttempts: number;
}

export class CodeStore {
  private entries = new Map<number, CodeEntry>();

  constructor() {
    // Lazy cleanup: cheap and sufficient for a Map of this size.
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  issue(userId: number): { code: string; expiresAt: number } {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    const expiresAt = Date.now() + config.codeTtlMs;
    // One active code per user; a new /start overwrites the old one.
    this.entries.set(userId, { code, expiresAt, failedAttempts: 0 });
    return { code, expiresAt };
  }

  /** true = valid code; after 5 wrong attempts the code is burned. */
  verify(userId: number, code: string): 'ok' | 'invalid' | 'expired' | 'burned' | 'not_found' {
    const entry = this.entries.get(userId);
    if (!entry) return 'not_found';
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(userId);
      return 'expired';
    }
    if (entry.failedAttempts >= config.maxCodeAttempts) {
      this.entries.delete(userId);
      return 'burned';
    }
    if (entry.code !== code) {
      entry.failedAttempts += 1;
      if (entry.failedAttempts >= config.maxCodeAttempts) {
        this.entries.delete(userId);
        return 'burned';
      }
      return 'invalid';
    }
    this.entries.delete(userId); // one-time
    return 'ok';
  }

  private cleanup() {
    const now = Date.now();
    for (const [userId, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(userId);
    }
  }
}
