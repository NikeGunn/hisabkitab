/**
 * Tenant session tokens: HMAC-SHA256-signed metadata minted by the orchestrator.
 * The MCP servers derive BOTH the tenant_id AND the caller's role ONLY from a
 * verified token (header), never from tool arguments or the model (PRD v1.1 §14,
 * v2.0 §3). One session = one tenant + one role.
 *
 * Back-compat: a token minted before P8 carries no role; it verifies as `owner`
 * (today's implicit "the paired phone is the owner" behaviour), so existing
 * sessions and verify scripts keep working unchanged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isRole, type Role } from '@hisab/shared';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The verified session: tenant + role (+ optional acting user). */
export interface TenantSession {
  tenantId: string;
  role: Role;
  userId?: string;
}

/** Options when minting a token. A bare number is accepted as the legacy ttl. */
export interface TokenOptions {
  role?: Role;
  userId?: string;
  ttlSeconds?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL = 300;

const b64url = (buf: Buffer): string => buf.toString('base64url');
const hmac = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload).digest();

/**
 * Mint a signed session token. `opts` may be `{ role, userId, ttlSeconds }`, or a
 * bare number for the legacy `ttlSeconds` positional form. `role`/`userId` are
 * omitted from the payload when not given (smaller token; verifies as `owner`).
 */
export function createTenantToken(tenantId: string, secret: string, opts: TokenOptions | number = {}): string {
  if (!UUID_RE.test(tenantId)) throw new AuthError('tenantId must be a UUID');
  const { role, userId, ttlSeconds = DEFAULT_TTL } = typeof opts === 'number' ? { ttlSeconds: opts } : opts;
  if (role !== undefined && !isRole(role)) throw new AuthError('invalid role');
  if (userId !== undefined && !UUID_RE.test(userId)) throw new AuthError('userId must be a UUID');

  const claims: Record<string, unknown> = { tenantId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  if (role !== undefined) claims['role'] = role;
  if (userId !== undefined) claims['userId'] = userId;

  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${b64url(hmac(payload, secret))}`;
}

/** Verify a token → `{ tenantId, role, userId? }`, or throw AuthError. Constant-time. */
export function verifyTenantToken(token: string, secret: string): TenantSession {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new AuthError('malformed tenant token');
  const expected = hmac(payload, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new AuthError('invalid tenant token signature');
  }
  let parsed: { tenantId?: unknown; role?: unknown; userId?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new AuthError('malformed tenant token payload');
  }
  if (typeof parsed.tenantId !== 'string' || !UUID_RE.test(parsed.tenantId)) {
    throw new AuthError('tenant token missing tenantId');
  }
  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('tenant token expired');
  }
  // Role defaults to owner for pre-P8 tokens; a present-but-bogus role is rejected
  // (never silently downgraded) so a tampered claim can't become a real role.
  let role: Role = 'owner';
  if (parsed.role !== undefined) {
    if (typeof parsed.role !== 'string' || !isRole(parsed.role)) throw new AuthError('tenant token has invalid role');
    role = parsed.role;
  }
  const session: TenantSession = { tenantId: parsed.tenantId, role };
  if (parsed.userId !== undefined) {
    if (typeof parsed.userId !== 'string' || !UUID_RE.test(parsed.userId)) {
      throw new AuthError('tenant token has invalid userId');
    }
    session.userId = parsed.userId;
  }
  return session;
}
