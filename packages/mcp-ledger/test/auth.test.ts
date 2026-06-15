import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthError, createTenantToken, verifyTenantToken } from '../src/auth.js';

const SECRET = 'test-signing-secret';
const TENANT = '0b9fae39-4d5b-4a86-b9a4-93a99d2334b8';
const USER = '11111111-2222-3333-4444-555555555555';

describe('tenant session tokens (HMAC)', () => {
  it('round-trips a valid token (default role = owner for back-compat)', () => {
    const s = verifyTenantToken(createTenantToken(TENANT, SECRET), SECRET);
    expect(s.tenantId).toBe(TENANT);
    expect(s.role).toBe('owner');
    expect(s.userId).toBeUndefined();
  });

  it('carries an explicit role + userId', () => {
    const token = createTenantToken(TENANT, SECRET, { role: 'staff', userId: USER });
    const s = verifyTenantToken(token, SECRET);
    expect(s).toEqual({ tenantId: TENANT, role: 'staff', userId: USER });
  });

  it('still accepts the legacy positional ttl form', () => {
    expect(verifyTenantToken(createTenantToken(TENANT, SECRET, 600), SECRET).tenantId).toBe(TENANT);
  });

  it('PROBE: a tampered payload (tenant swap) is rejected', () => {
    const token = createTenantToken(TENANT, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ tenantId: '99999999-2222-3333-4444-555555555555', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url')}.${sig}`;
    expect(() => verifyTenantToken(forged, SECRET)).toThrow(AuthError);
  });

  it('PROBE: forging a role onto a token breaks the signature (no privilege escalation)', () => {
    // take a real staff token, swap the role claim to owner, keep the old signature
    const token = createTenantToken(TENANT, SECRET, { role: 'staff' });
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ tenantId: TENANT, role: 'owner', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url')}.${sig}`;
    expect(() => verifyTenantToken(forged, SECRET)).toThrow(AuthError);
  });

  it('PROBE: a token claiming an unknown role is rejected (never silently downgraded)', () => {
    // sign a payload that carries a bogus role with the REAL secret
    const exp = Math.floor(Date.now() / 1000) + 300;
    const payload = Buffer.from(JSON.stringify({ tenantId: TENANT, role: 'superadmin', exp })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(() => verifyTenantToken(`${payload}.${sig}`, SECRET)).toThrow(AuthError);
  });

  it('PROBE: minting refuses an invalid role or non-UUID ids', () => {
    expect(() => createTenantToken(TENANT, SECRET, { role: 'superadmin' as never })).toThrow(AuthError);
    expect(() => createTenantToken(TENANT, SECRET, { userId: 'not-a-uuid' })).toThrow(AuthError);
    expect(() => createTenantToken('1 OR 1=1', SECRET)).toThrow(AuthError);
  });

  it('PROBE: wrong secret, expired token, and garbage are all rejected', () => {
    expect(() => verifyTenantToken(createTenantToken(TENANT, SECRET), 'other-secret')).toThrow(AuthError);
    expect(() => verifyTenantToken(createTenantToken(TENANT, SECRET, -10), SECRET)).toThrow(AuthError);
    expect(() => verifyTenantToken('garbage', SECRET)).toThrow(AuthError);
    expect(() => verifyTenantToken('a.b', SECRET)).toThrow(AuthError);
  });
});
