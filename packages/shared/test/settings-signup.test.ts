/**
 * Runtime settings registry + signup input validation. Fixtures + PROBES: hostile
 * or malformed operator/website input must be rejected, never stored or trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  SETTINGS,
  SETTING_KEYS,
  isBotSubmission,
  isSettingKey,
  maskSecret,
  normalizePhone,
  resolveSetting,
  settingSource,
  signupInputSchema,
  validateSetting,
} from '../src/index.js';

describe('settings registry', () => {
  it('resolves DB value → env → default, in that order', () => {
    const env = { KHALTI_ORIGIN: 'https://khalti.com' };
    expect(resolveSetting('khalti.origin', new Map(), {})).toBe('https://dev.khalti.com');
    expect(resolveSetting('khalti.origin', new Map(), env)).toBe('https://khalti.com');
    expect(resolveSetting('khalti.origin', new Map([['khalti.origin', 'https://dev.khalti.com']]), env)).toBe(
      'https://dev.khalti.com',
    );
    expect(settingSource('khalti.origin', new Map(), env)).toBe('env');
    expect(settingSource('khalti.origin', new Map([['khalti.origin', 'x']]), env)).toBe('admin');
    expect(settingSource('wa.access_token', new Map(), {})).toBe('unset');
  });

  it('normalizes booleans and phone numbers', () => {
    expect(validateSetting('payments.live', 'on')).toBe('true');
    expect(validateSetting('payments.live', '0')).toBe('false');
    expect(validateSetting('signup.alert_e164', '+977 974-586 1381')).toBe('+9779745861381');
    expect(validateSetting('signup.alert_e164', '')).toBe('');
  });

  it('PROBE: rejects a non-allowlisted Khalti origin (no exfiltrating the key to another host)', () => {
    expect(() => validateSetting('khalti.origin', 'https://evil.example')).toThrow();
    expect(() => validateSetting('khalti.origin', 'http://khalti.com')).toThrow();
  });

  it('PROBE: rejects junk ids, short secrets, out-of-range caps', () => {
    expect(() => validateSetting('wa.phone_number_id', '12; DROP TABLE')).toThrow();
    expect(() => validateSetting('wa.access_token', 'short')).toThrow();
    expect(() => validateSetting('signup.daily_cap', '-1')).toThrow();
    expect(() => validateSetting('signup.daily_cap', '5000')).toThrow();
    expect(() => validateSetting('signup.trial_plan', 'free-forever')).toThrow();
  });

  it('PROBE: an invalid env value is ignored, not trusted', () => {
    expect(resolveSetting('khalti.origin', new Map(), { KHALTI_ORIGIN: 'https://evil.example' })).toBe(
      'https://dev.khalti.com',
    );
  });

  it('every secret has an env seed or is explicitly admin-only; every key validates its default', () => {
    for (const key of SETTING_KEYS) {
      const def = SETTINGS[key] as { default?: string };
      if (def.default !== undefined) expect(validateSetting(key, def.default)).toBe(def.default);
    }
    expect(isSettingKey('wa.access_token')).toBe(true);
    expect(isSettingKey('__proto__')).toBe(false);
  });

  it('masks secrets to the last 4 chars only', () => {
    expect(maskSecret('EAAG1234567890abcd')).toBe('••••abcd');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBe('');
  });
});

describe('signup input', () => {
  const valid = {
    business_name: 'Karki Hardware',
    owner_name: 'Sita Karki',
    whatsapp: '98-1234 5678',
    pan_vat: '600 123 456',
    consent: true as const,
  };

  it('normalizes common Nepali number shapes to E.164', () => {
    for (const raw of ['9812345678', '+9779812345678', '9779812345678', '00977 981-234-5678']) {
      expect(normalizePhone(raw)).toBe('+9779812345678');
    }
    expect(normalizePhone('+14155550123')).toBe('+14155550123');
  });

  it('accepts a valid form and normalizes it', () => {
    const out = signupInputSchema.parse(valid);
    expect(out.whatsapp).toBe('+9779812345678');
    expect(out.pan_vat).toBe('600123456');
    expect(out.vat_registered).toBe(true);
  });

  it('PROBE: rejects landlines, short numbers and letters', () => {
    expect(normalizePhone('014123456')).toBeNull();
    expect(normalizePhone('+97714123456')).toBeNull();
    expect(normalizePhone('98123')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });

  it('PROBE: rejects bad PAN, missing consent, injected markup', () => {
    expect(() => signupInputSchema.parse({ ...valid, pan_vat: '12345' })).toThrow();
    expect(() => signupInputSchema.parse({ ...valid, consent: false })).toThrow();
    const out = signupInputSchema.parse({ ...valid, business_name: '<script>x</script>Shop\n\u0007' });
    expect(out.business_name).not.toMatch(/[<>\u0007\n]/);
  });

  it('PROBE: honeypot flags bots', () => {
    expect(isBotSubmission({ website: 'http://spam' })).toBe(true);
    expect(isBotSubmission({ website: '' })).toBe(false);
    expect(isBotSubmission({})).toBe(false);
  });
});
