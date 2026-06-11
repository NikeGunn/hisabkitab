import { describe, expect, it } from 'vitest';
import { AuthError, createTenantToken, verifyTenantToken } from '../src/auth.js';

const SECRET = 'test-signing-secret';
const TENANT = '0b9fae39-4d5b-4a86-b9a4-93a99d2334b8';

describe('tenant session tokens (HMAC)', () => {
  it('round-trips a valid token', () => {
    expect(verifyTenantToken(createTenantToken(TENANT, SECRET), SECRET)).toBe(TENANT);
  });

  it('PROBE: a tampered payload (tenant swap) is rejected', () => {
    const token = createTenantToken(TENANT, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ tenantId: '11111111-2222-3333-4444-555555555555', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url')}.${sig}`;
    expect(() => verifyTenantToken(forged, SECRET)).toThrow(AuthError);
  });

  it('PROBE: wrong secret, expired token, and garbage are all rejected', () => {
    expect(() => verifyTenantToken(createTenantToken(TENANT, SECRET), 'other-secret')).toThrow(AuthError);
    expect(() => verifyTenantToken(createTenantToken(TENANT, SECRET, -10), SECRET)).toThrow(AuthError);
    expect(() => verifyTenantToken('garbage', SECRET)).toThrow(AuthError);
    expect(() => verifyTenantToken('a.b', SECRET)).toThrow(AuthError);
  });

  it('PROBE: refuses to mint tokens for non-UUID tenant ids', () => {
    expect(() => createTenantToken('1 OR 1=1', SECRET)).toThrow(AuthError);
  });
});
