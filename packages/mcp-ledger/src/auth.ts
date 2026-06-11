/**
 * Tenant session tokens: HMAC-SHA256-signed metadata minted by the orchestrator.
 * The Ledger MCP derives tenant_id ONLY from a verified token (header), never from
 * tool arguments (PRD v1.1 §14). One session = one tenant.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64url = (buf: Buffer): string => buf.toString('base64url');
const hmac = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload).digest();

export function createTenantToken(tenantId: string, secret: string, ttlSeconds = 300): string {
  if (!UUID_RE.test(tenantId)) throw new AuthError('tenantId must be a UUID');
  const payload = b64url(
    Buffer.from(JSON.stringify({ tenantId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })),
  );
  return `${payload}.${b64url(hmac(payload, secret))}`;
}

/** Returns the tenantId or throws AuthError. Constant-time signature comparison. */
export function verifyTenantToken(token: string, secret: string): string {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new AuthError('malformed tenant token');
  const expected = hmac(payload, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new AuthError('invalid tenant token signature');
  }
  let parsed: { tenantId?: unknown; exp?: unknown };
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
  return parsed.tenantId;
}
