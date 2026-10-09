import { createHash } from 'node:crypto';
import { canonicalize } from '@hisab/shared';

/** Deterministic JSON (sorted keys) — the same canonical form the audit hash-chain uses. */
export const stableJson = (value: unknown): string => canonicalize(value);

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export const digest = (value: unknown): string => sha256Hex(stableJson(value));
