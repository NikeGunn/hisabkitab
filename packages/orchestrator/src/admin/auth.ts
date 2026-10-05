/**
 * Admin panel authentication. One operator account, password stored ONLY as a
 * scrypt hash in `ADMIN_PASSWORD_HASH` (generate with `pnpm admin:hash`).
 *
 * Session = HttpOnly + Secure + SameSite=Strict cookie carrying
 * `<payload-b64url>.<hmac>`; the HMAC key is derived from the signing secret AND a
 * fingerprint of the password hash, so changing the password logs every session
 * out. Each session carries a random nonce from which the per-form CSRF token is
 * derived (double protection on top of SameSite=Strict + Origin check).
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const SESSION_COOKIE = 'hk_admin';
export const SESSION_TTL_SECONDS = 12 * 3600;
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** `scrypt:N:r:p:salt:hash` (base64). `:` not `$` so compose .env never interpolates it. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('admin password must be at least 12 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface AdminSession {
  sub: string;
  exp: number;
  nonce: string;
}

export class AdminAuth {
  private readonly key: Buffer;

  constructor(
    signingSecret: string,
    readonly passwordHash: string,
    private readonly now: () => number = Date.now,
  ) {
    const fp = createHash('sha256').update(passwordHash).digest('hex');
    this.key = createHmac('sha256', signingSecret).update(`hisab-admin-session-v1:${fp}`).digest();
  }

  private sign(data: string): string {
    return createHmac('sha256', this.key).update(data).digest('base64url');
  }

  issue(sub = 'admin'): { cookie: string; session: AdminSession } {
    const session: AdminSession = {
      sub,
      exp: Math.floor(this.now() / 1000) + SESSION_TTL_SECONDS,
      nonce: randomBytes(16).toString('base64url'),
    };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return { cookie: `${payload}.${this.sign(payload)}`, session };
  }

  /** Verified session from a cookie value, or null (bad sig / expired / malformed). */
  verify(cookie: string | undefined): AdminSession | null {
    if (!cookie) return null;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return null;
    const payload = cookie.slice(0, dot);
    const sig = Buffer.from(cookie.slice(dot + 1));
    const want = Buffer.from(this.sign(payload));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AdminSession;
      if (typeof s.exp !== 'number' || s.exp < Math.floor(this.now() / 1000)) return null;
      if (typeof s.nonce !== 'string' || typeof s.sub !== 'string') return null;
      return s;
    } catch {
      return null;
    }
  }

  csrfToken(session: AdminSession): string {
    return this.sign(`csrf:${session.nonce}`);
  }

  checkCsrf(session: AdminSession, token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.csrfToken(session));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Parse a Cookie header into a map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(value: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
