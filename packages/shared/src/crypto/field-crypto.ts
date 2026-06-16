/**
 * Field-level encryption for the most sensitive PII (PAN/VAT numbers) — PRD v2.0
 * §9 "field-level encryption for the most sensitive PII". AES-256-GCM (authenticated:
 * tampering is DETECTED, not silently decrypted to garbage), keyed by a 32-byte
 * master key supplied via the secret manager / env, never the repo.
 *
 * Ciphertext is a self-describing, versioned string so the column can hold a mix of
 * legacy plaintext and encrypted values during/after rollout, and so the algorithm
 * can be rotated later without ambiguity:
 *
 *   enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 *
 * The `enc:v1:` prefix is the discriminator — `isEncrypted` keys off it, so a value
 * that was never encrypted (NULL, empty, or a pre-rollout PAN) is returned as-is by
 * `decryptField`. New writes always encrypt when a key is configured.
 *
 * KEY: 32 bytes, base64-encoded, in `FIELD_ENCRYPTION_KEY`. `loadFieldKey()` returns
 * null when unset (dev/test) — callers then store plaintext (documented dev mode).
 * In production the key MUST be set; `requireFieldKey()` throws if it is missing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256
const PREFIX = 'enc:v1:';

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCryptoError';
  }
}

/** Parse + validate a base64 32-byte key. Throws FieldCryptoError on bad input. */
export function parseKey(b64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(b64, 'base64');
  } catch {
    throw new FieldCryptoError('FIELD_ENCRYPTION_KEY is not valid base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new FieldCryptoError(`FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/** Read the master key from env; null when unset (dev/test → plaintext mode). */
export function loadFieldKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env['FIELD_ENCRYPTION_KEY']?.trim();
  if (!raw) return null;
  return parseKey(raw);
}

/** Like loadFieldKey but throws when unset — use where encryption is mandatory (prod). */
export function requireFieldKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const key = loadFieldKey(env);
  if (!key) throw new FieldCryptoError('FIELD_ENCRYPTION_KEY is required but not set');
  return key;
}

/** True if `value` is a value produced by `encryptField` (has the versioned prefix). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt a plaintext field with AES-256-GCM → `enc:v1:iv:tag:ct` (all base64). */
export function encryptField(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new FieldCryptoError('encrypt: key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a value produced by `encryptField`. A value WITHOUT the `enc:v1:` prefix is
 * assumed to be legacy plaintext and returned unchanged (back-compat during rollout).
 * A malformed or tampered ciphertext throws FieldCryptoError — GCM auth fails closed,
 * so a corrupted PAN is NEVER silently turned into a wrong value.
 */
export function decryptField(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new FieldCryptoError('decrypt: malformed ciphertext envelope');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new FieldCryptoError('decrypt: bad IV length');
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // wrong key, tampered ciphertext, or tampered tag — fail closed.
    throw new FieldCryptoError('decrypt: authentication failed (wrong key or tampered data)');
  }
}

/**
 * Encrypt for storage when a key is configured; otherwise pass through (dev/test).
 * NULL/empty are returned unchanged. This is the function write-sites call.
 */
export function encryptForStorage(value: string | null | undefined, key: Buffer | null): string | null {
  if (value === null || value === undefined || value === '') return null; // normalize empty → NULL
  if (!key) return value; // dev/test: no key → store plaintext (documented)
  if (isEncrypted(value)) return value; // already encrypted, don't double-wrap
  return encryptField(value, key);
}

/**
 * Decrypt a stored value for use. NULL/empty pass through; legacy plaintext passes
 * through; an encrypted value with no key configured throws (can't read prod data in
 * a misconfigured dev) — callers should ensure the key matches the data.
 */
export function decryptFromStorage(value: string | null | undefined, key: Buffer | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncrypted(value)) return value; // legacy plaintext
  if (!key) throw new FieldCryptoError('decrypt: value is encrypted but FIELD_ENCRYPTION_KEY is not set');
  return decryptField(value, key);
}
