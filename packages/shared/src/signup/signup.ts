/**
 * Website signup input (pilot form → POST /signup). Pure validation only; the
 * orchestrator owns the side effects (tenant row, verification code, WhatsApp).
 *
 * Trust model: nothing here is authority. The WhatsApp number is only CLAIMED by
 * the form; it becomes the owner's identity only after the owner proves control by
 * messaging `START <code>` FROM that number (code is bound to it server-side).
 */
import { z } from 'zod';

/**
 * Normalize a phone number typed by a Nepali owner into E.164. Accepts the common
 * shapes: 98XXXXXXXX / 97XXXXXXXX (10-digit mobile), with +977 / 977 / 00977
 * prefixes, spaces and dashes. Other countries must be typed with a leading '+'.
 * Returns null when it is not a plausible mobile number.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s().-]/g, '');
  if (!s) return null;
  let e164: string;
  if (/^9[678]\d{8}$/.test(s)) e164 = `+977${s}`;
  else if (/^977(9[678]\d{8})$/.test(s)) e164 = `+${s}`;
  else if (/^00977(9[678]\d{8})$/.test(s)) e164 = `+${s.slice(2)}`;
  else if (/^\+[1-9]\d{7,14}$/.test(s)) e164 = s;
  else return null;
  // A Nepali number must be a 10-digit 9x mobile (WhatsApp-capable), not a landline.
  if (e164.startsWith('+977') && !/^\+9779[678]\d{8}$/.test(e164)) return null;
  return e164;
}

/** Strip control characters + collapse whitespace: names are shown in admin + WhatsApp. */
const cleanText = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(2, 'too short').max(max, 'too long'));

export const signupInputSchema = z.object({
  business_name: cleanText(120),
  owner_name: cleanText(80),
  whatsapp: z
    .string()
    .max(30)
    .transform((v, ctx) => {
      const e = normalizePhone(v);
      if (!e) {
        ctx.addIssue({ code: 'custom', message: 'enter a valid WhatsApp mobile number, e.g. 98XXXXXXXX' });
        return z.NEVER;
      }
      return e;
    }),
  // Nepal PAN and VAT numbers are both 9 digits.
  pan_vat: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{9}$/, 'PAN/VAT number must be 9 digits')),
  vat_registered: z.boolean().default(true),
  email: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : undefined))
    .pipe(z.union([z.undefined(), z.string().email('enter a valid email')])),
  consent: z.literal(true, { message: 'please accept the terms to continue' }),
  // Honeypot: a hidden field real browsers leave empty. Bots fill it.
  website: z.string().max(200).optional(),
});

export type SignupInput = z.infer<typeof signupInputSchema>;

/** True when the honeypot was filled — treat as a bot (respond OK, do nothing). */
export function isBotSubmission(input: { website?: string | undefined }): boolean {
  return Boolean(input.website && input.website.trim() !== '');
}

/** Signup verification codes are 6 digits (pilot pairing codes stay 4–8). */
export const SIGNUP_CODE_DIGITS = 6;
/** A code stays valid this long. Matches the pairing_code template's expiry footer. */
export const SIGNUP_CODE_TTL_MINUTES = 15;
/** Codes per number per rolling 24h (stops SMS-pumping style abuse of our template spend). */
export const SIGNUP_CODES_PER_NUMBER_PER_DAY = 3;
/** Wrong START attempts from the bound number before its code is burned. */
export const SIGNUP_MAX_FAILED_ATTEMPTS = 5;
