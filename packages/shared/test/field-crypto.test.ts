/** Pure unit tests for field-level PII encryption (PRD v2.0 §9). */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptField,
  decryptField,
  isEncrypted,
  parseKey,
  loadFieldKey,
  requireFieldKey,
  encryptForStorage,
  decryptFromStorage,
  FieldCryptoError,
} from '../src/index.js';

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString('base64');

describe('encryptField / decryptField roundtrip', () => {
  it('roundtrips a PAN through AES-256-GCM', () => {
    const pan = '301234567';
    const ct = encryptField(pan, KEY);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain(pan); // plaintext never appears
    expect(decryptField(ct, KEY)).toBe(pan);
  });

  it('produces a different ciphertext each time (random IV) but same plaintext', () => {
    const a = encryptField('600000001', KEY);
    const b = encryptField('600000001', KEY);
    expect(a).not.toBe(b); // distinct IVs
    expect(decryptField(a, KEY)).toBe(decryptField(b, KEY));
  });

  it('handles unicode + empty string', () => {
    for (const s of ['पान ३०१', '', 'VAT-9779']) {
      expect(decryptField(encryptField(s, KEY), KEY)).toBe(s);
    }
  });

  it('legacy plaintext (no prefix) passes through decrypt unchanged', () => {
    expect(decryptField('301234567', KEY)).toBe('301234567');
    expect(isEncrypted('301234567')).toBe(false);
  });
});

describe('PROBES — fail closed', () => {
  it('PROBE: a tampered ciphertext byte fails authentication (never silent garbage)', () => {
    const ct = encryptField('301234567', KEY);
    // flip the last base64 char of the ciphertext segment
    const flipped = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
    expect(() => decryptField(flipped, KEY)).toThrow(FieldCryptoError);
  });

  it('PROBE: the WRONG key fails authentication, never decrypts to a wrong PAN', () => {
    const ct = encryptField('301234567', KEY);
    const otherKey = randomBytes(32);
    expect(() => decryptField(ct, otherKey)).toThrow(/authentication failed/);
  });

  it('PROBE: a malformed envelope is rejected', () => {
    expect(() => decryptField('enc:v1:onlytwo:parts', KEY)).toThrow(FieldCryptoError);
  });

  it('PROBE: a non-32-byte key is rejected', () => {
    expect(() => parseKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(() => encryptField('x', randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('key loading', () => {
  it('loadFieldKey returns null when unset (dev mode)', () => {
    expect(loadFieldKey({})).toBeNull();
    expect(loadFieldKey({ FIELD_ENCRYPTION_KEY: '   ' })).toBeNull();
  });

  it('loadFieldKey parses a valid base64 32-byte key', () => {
    expect(loadFieldKey({ FIELD_ENCRYPTION_KEY: KEY_B64 })!.length).toBe(32);
  });

  it('requireFieldKey throws when unset', () => {
    expect(() => requireFieldKey({})).toThrow(/required but not set/);
  });
});

describe('storage helpers (back-compat)', () => {
  it('encryptForStorage encrypts when keyed, passes through when keyless (dev)', () => {
    expect(encryptForStorage('301234567', null)).toBe('301234567'); // dev: plaintext
    const enc = encryptForStorage('301234567', KEY)!;
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptFromStorage(enc, KEY)).toBe('301234567');
  });

  it('null/empty are preserved by both helpers', () => {
    expect(encryptForStorage(null, KEY)).toBeNull();
    expect(encryptForStorage(undefined, KEY)).toBeNull();
    expect(encryptForStorage('', KEY)).toBeNull();
    expect(decryptFromStorage(null, KEY)).toBeNull();
  });

  it('does not double-wrap an already-encrypted value', () => {
    const once = encryptForStorage('301234567', KEY)!;
    const twice = encryptForStorage(once, KEY)!;
    expect(twice).toBe(once);
  });

  it('PROBE: reading encrypted data with NO key configured throws (no silent plaintext leak path)', () => {
    const enc = encryptForStorage('301234567', KEY)!;
    expect(() => decryptFromStorage(enc, null)).toThrow(/not set/);
  });

  it('decryptFromStorage passes legacy plaintext through even with a key set', () => {
    expect(decryptFromStorage('301234567', KEY)).toBe('301234567');
  });
});
