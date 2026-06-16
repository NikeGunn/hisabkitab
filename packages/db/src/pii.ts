/**
 * PII field encryption boundary for the DB layer (PRD v2.0 §9). Wraps the pure
 * `@hisab/shared` field-crypto with a process-loaded key so write/read sites call a
 * single `encPII` / `decPII`. The key is read ONCE from `FIELD_ENCRYPTION_KEY`
 * (secret manager / env). When unset (dev/test) values are stored as plaintext —
 * a documented dev mode — and the table can hold a mix during rollout because the
 * ciphertext is self-describing (`enc:v1:` prefix). Used for PAN/VAT numbers.
 */
import { encryptForStorage, decryptFromStorage, loadFieldKey } from '@hisab/shared';

// Load the key lazily + once so importing this module never throws on a missing key
// (dev/test), and a key rotation in a long-lived process is picked up on restart.
let cachedKey: Buffer | null | undefined;
function key(): Buffer | null {
  if (cachedKey === undefined) cachedKey = loadFieldKey();
  return cachedKey;
}

/** Encrypt a PII value for storage (NULL/empty → NULL; no key → plaintext). */
export function encPII(value: string | null | undefined): string | null {
  return encryptForStorage(value, key());
}

/** Decrypt a stored PII value (NULL/empty → NULL; legacy plaintext passes through). */
export function decPII(value: string | null | undefined): string | null {
  return decryptFromStorage(value, key());
}

/** Test seam: force the key cache (so a test can flip encryption on/off). */
export function __setPiiKeyForTests(k: Buffer | null): void {
  cachedKey = k;
}
