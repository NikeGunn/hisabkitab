/**
 * Runtime settings registry — the ONE place that knows every operator-editable
 * setting: its validator, whether it is a secret, which env var seeds it, and how
 * the admin panel should label it. Pure (no I/O) so it is shared by the DB store,
 * the orchestrator, the payments service and the admin UI.
 *
 * Resolution order for a key (see `resolveSetting`):
 *   1. a value saved in the `app_settings` table (edited in the admin panel)
 *   2. the env var named in `env` (deploy-time default, back-compat)
 *   3. the registry `default`
 * So a fresh deploy behaves exactly as before, and an operator can override any of
 * these at runtime (new WhatsApp number, production Khalti key) without a redeploy.
 */
import { z } from 'zod';

export type SettingGroup = 'whatsapp' | 'payments' | 'signup';

export interface SettingDef {
  group: SettingGroup;
  label: string;
  help: string;
  /** Secrets are encrypted at rest and never echoed back to the admin UI. */
  secret: boolean;
  /** Env var that seeds this setting when nothing is saved in the DB. */
  env?: string;
  default?: string;
  /** Normalizes + validates a raw string. Throws ZodError on bad input. */
  schema: z.ZodType<string>;
  /** Fixed options for a select box (also enforced by `schema`). */
  options?: readonly string[];
}

const digits = (what: string) =>
  z.string().trim().regex(/^\d{5,25}$/, `${what} must be digits only`);
const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) =>
    ['1', 'true', 'on', 'yes'].includes(v) ? 'true' : ['', '0', 'false', 'off', 'no'].includes(v) ? 'false' : v,
  )
  .pipe(z.enum(['true', 'false']));
const optionalE164 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.union([z.literal(''), z.string().regex(/^\+[1-9]\d{7,14}$/, 'use international format, e.g. +9779812345678')]));
const secretText = (min: number) => z.string().trim().min(min, `must be at least ${min} characters`);
const intIn = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a whole number')
    .refine((v) => Number(v) >= min && Number(v) <= max, `must be between ${min} and ${max}`);

export const KHALTI_ORIGINS = ['https://dev.khalti.com', 'https://khalti.com'] as const;

export const SETTINGS = {
  // ---------------------------------------------------------------- WhatsApp
  'wa.phone_number_id': {
    group: 'whatsapp',
    label: 'Sender phone number ID',
    help: 'Meta Cloud API phone number ID HisabKitab sends from and answers on. Messages to any other number on the app are ignored.',
    secret: false,
    env: 'WA_PHONE_NUMBER_ID',
    schema: digits('Phone number ID'),
  },
  'wa.business_account_id': {
    group: 'whatsapp',
    label: 'WhatsApp Business Account ID',
    help: 'Account that owns the sender number and its message templates.',
    secret: false,
    env: 'WA_BUSINESS_ACCOUNT_ID',
    schema: digits('Business account ID'),
  },
  'wa.sender_e164': {
    group: 'whatsapp',
    label: 'Sender number (public)',
    help: 'The number customers message, in +977… format. Shown on the signup page and used for the wa.me link.',
    secret: false,
    env: 'WA_SENDER_E164',
    schema: optionalE164,
  },
  'wa.access_token': {
    group: 'whatsapp',
    label: 'System user access token',
    help: 'Permanent Meta system-user token (whatsapp_business_messaging + management).',
    secret: true,
    env: 'WA_ACCESS_TOKEN',
    schema: secretText(20),
  },
  'wa.app_secret': {
    group: 'whatsapp',
    label: 'App secret',
    help: 'Meta app secret used to verify the webhook signature (X-Hub-Signature-256).',
    secret: true,
    env: 'WA_APP_SECRET',
    schema: secretText(8),
  },
  'wa.webhook_verify_token': {
    group: 'whatsapp',
    label: 'Webhook verify token',
    help: 'Shared string Meta echoes during the webhook handshake.',
    secret: true,
    env: 'WA_WEBHOOK_VERIFY_TOKEN',
    schema: secretText(8),
  },
  // ---------------------------------------------------------------- payments
  'khalti.secret_key': {
    group: 'payments',
    label: 'Khalti secret key',
    help: 'Live secret key from the Khalti merchant dashboard (or the sandbox key while testing).',
    secret: true,
    env: 'KHALTI_SECRET_KEY',
    schema: secretText(8),
  },
  'khalti.origin': {
    group: 'payments',
    label: 'Khalti environment',
    help: 'https://dev.khalti.com = sandbox (test money). https://khalti.com = production (real money).',
    secret: false,
    env: 'KHALTI_ORIGIN',
    default: 'https://dev.khalti.com',
    options: KHALTI_ORIGINS,
    schema: z.enum(KHALTI_ORIGINS),
  },
  'payments.live': {
    group: 'payments',
    label: 'Subscription billing live',
    help: 'Off = owners see prices but no Khalti link is created. On = real payment links (sandbox or production, per the environment above).',
    secret: false,
    env: 'PAYMENTS_LIVE',
    default: 'false',
    options: ['false', 'true'],
    schema: bool,
  },
  // ---------------------------------------------------------------- signup
  'signup.enabled': {
    group: 'signup',
    label: 'Website signup open',
    help: 'Off = the pilot form on hisabkitab.pro politely refuses new signups.',
    secret: false,
    default: 'true',
    options: ['true', 'false'],
    schema: bool,
  },
  'signup.daily_cap': {
    group: 'signup',
    label: 'Max signups per day',
    help: 'Hard ceiling on verification codes sent per day (each costs a Meta authentication message).',
    secret: false,
    default: '50',
    schema: intIn(0, 1000),
  },
  'signup.trial_plan': {
    group: 'signup',
    label: 'Trial plan',
    help: 'Plan a newly verified business starts its free trial on.',
    secret: false,
    default: 'pro',
    options: ['starter', 'pro', 'business'],
    schema: z.enum(['starter', 'pro', 'business']),
  },
  'signup.alert_e164': {
    group: 'signup',
    label: 'Admin alert WhatsApp',
    help: 'Your number. Gets a WhatsApp alert for every new signup. Leave empty to disable.',
    secret: false,
    env: 'ADMIN_ALERT_E164',
    default: '',
    schema: optionalE164,
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** Validate + normalize a raw admin input for `key`. Throws ZodError on bad input. */
export function validateSetting(key: SettingKey, raw: string): string {
  return (SETTINGS[key].schema as z.ZodType<string>).parse(raw);
}

/**
 * Resolve the effective value: saved DB value → env → default. Returns undefined
 * when none is set (caller decides whether that is fatal). An env value that does
 * not pass validation is ignored rather than trusted.
 */
export function resolveSetting(
  key: SettingKey,
  saved: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const db = saved.get(key);
  if (db !== undefined) return db;
  const def: SettingDef = SETTINGS[key];
  const fromEnv = def.env ? env[def.env] : undefined;
  if (fromEnv !== undefined && fromEnv !== '') {
    const ok = (def.schema as z.ZodType<string>).safeParse(fromEnv);
    if (ok.success) return ok.data;
  }
  return def.default;
}

/** Where the effective value came from — shown in the admin panel. */
export function settingSource(
  key: SettingKey,
  saved: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): 'admin' | 'env' | 'default' | 'unset' {
  if (saved.has(key)) return 'admin';
  const def: SettingDef = SETTINGS[key];
  if (def.env && env[def.env]) {
    if ((def.schema as z.ZodType<string>).safeParse(env[def.env]).success) return 'env';
  }
  return def.default !== undefined ? 'default' : 'unset';
}

/** Mask a secret for display: keeps the last 4 characters only. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}
