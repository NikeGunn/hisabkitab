'use client';

import { useState, type FormEvent } from 'react';

/**
 * Pilot signup. Posts to the HisabKitab API, which sends a one-time verification
 * code to the owner's WhatsApp. The owner then sends "START <code>" to HisabKitab
 * from that same number, which proves they control it. Nothing here is trusted
 * by the server; all validation is repeated there.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.hisabkitab.pro';

type Result =
  | { status: 'code_sent'; sender_e164?: string; wa_link?: string; expires_minutes: number }
  | { status: 'already_registered'; sender_e164?: string; wa_link?: string }
  | { status: 'invalid'; errors: Record<string, string> }
  | { status: 'send_failed'; reason?: 'recipient' | 'service' }
  | { status: 'closed' | 'busy' | 'rate_limited' | 'error' };

const MESSAGES: Record<string, string> = {
  closed: 'New signups are paused for a moment. Please try again later or email hello@hisabkitab.pro.',
  busy: 'We are onboarding a lot of businesses today. Please try again tomorrow, or email hello@hisabkitab.pro.',
  rate_limited: 'Too many attempts. Please wait a while before requesting another code.',
  send_failed:
    'We could not deliver a WhatsApp message to that number. Check that it is your WhatsApp number and try again.',
  send_failed_service:
    'We could not send your code right now because of a problem on our side, not your number. We have been alerted. Please try again later or email hello@hisabkitab.pro.',
  error: 'Something went wrong on our side. Please try again in a minute.',
};

const field =
  'mt-1.5 w-full rounded-control border border-hairline bg-surface px-4 py-3 text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

export function SignupForm() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = {
      business_name: String(fd.get('business_name') ?? ''),
      owner_name: String(fd.get('owner_name') ?? ''),
      whatsapp: String(fd.get('whatsapp') ?? ''),
      pan_vat: String(fd.get('pan_vat') ?? ''),
      vat_registered: fd.get('vat_registered') === 'on',
      email: String(fd.get('email') ?? '') || undefined,
      consent: fd.get('consent') === 'on',
      website: String(fd.get('website') ?? ''),
    };
    setBusy(true);
    setErrors({});
    try {
      const res = await fetch(`${API_BASE}/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({ status: 'error' }))) as Result;
      if (data.status === 'invalid') setErrors(data.errors);
      setResult(data);
    } catch {
      setResult({ status: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // a failure on OUR side (e.g. sender misconfigured) must never blame the owner's number
  const notice =
    result && result.status !== 'invalid'
      ? result.status === 'send_failed' && result.reason === 'service'
        ? MESSAGES.send_failed_service
        : MESSAGES[result.status]
      : undefined;

  if (result && (result.status === 'code_sent' || result.status === 'already_registered')) {
    const sent = result.status === 'code_sent';
    return (
      <div className="card p-8 text-center">
        <div className="text-4xl">{sent ? '📲' : '👋'}</div>
        <h3 className="mt-4 font-serif text-2xl font-semibold text-ink">
          {sent ? 'Check your WhatsApp' : 'You are already with us'}
        </h3>
        <p className="mx-auto mt-3 max-w-md text-muted">
          {sent ? (
            <>
              We sent a 6-digit code to your WhatsApp. Copy it, then send{' '}
              <b className="text-ink">START</b> followed by the code to HisabKitab
              {result.sender_e164 ? <> on <b className="text-ink">{result.sender_e164}</b></> : null}. The code works
              for {result.expires_minutes} minutes and only from your number.
            </>
          ) : (
            <>This number is already set up. Just message HisabKitab on WhatsApp to continue.</>
          )}
        </p>
        {result.wa_link ? (
          <a href={result.wa_link} className="btn-primary mt-6 inline-flex" target="_blank" rel="noopener noreferrer">
            Open WhatsApp →
          </a>
        ) : null}
        {sent ? (
          <p className="mt-6 text-sm text-muted">
            No code after a minute?{' '}
            <button className="underline hover:text-ink" onClick={() => setResult(null)}>
              Try again
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  const err = (name: string) =>
    errors[name] ? <span className="mt-1 block text-sm text-red-600">{errors[name]}</span> : null;

  return (
    <form onSubmit={onSubmit} className="card space-y-5 p-6 sm:p-8" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block text-sm font-medium text-ink">
          Business name
          <input name="business_name" required maxLength={120} className={field} autoComplete="organization" />
          {err('business_name')}
        </label>
        <label className="block text-sm font-medium text-ink">
          Your name
          <input name="owner_name" required maxLength={80} className={field} autoComplete="name" />
          {err('owner_name')}
        </label>
        <label className="block text-sm font-medium text-ink">
          WhatsApp number
          <input
            name="whatsapp"
            required
            inputMode="tel"
            placeholder="98XXXXXXXX"
            className={field}
            autoComplete="tel"
          />
          {err('whatsapp')}
        </label>
        <label className="block text-sm font-medium text-ink">
          PAN / VAT number
          <input name="pan_vat" required inputMode="numeric" maxLength={11} placeholder="9 digits" className={field} />
          {err('pan_vat')}
        </label>
      </div>
      <label className="block text-sm font-medium text-ink">
        Email <span className="font-normal text-muted">(optional)</span>
        <input name="email" type="email" maxLength={120} className={field} autoComplete="email" />
        {err('email')}
      </label>
      {/* honeypot: hidden from people, visible to naive bots */}
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <label className="flex items-center gap-3 text-sm text-ink">
        <input type="checkbox" name="vat_registered" defaultChecked className="h-4 w-4 accent-primary" />
        My business is VAT registered
      </label>
      <label className="flex items-start gap-3 text-sm text-muted">
        <input type="checkbox" name="consent" className="mt-0.5 h-4 w-4 accent-primary" />
        <span>
          I agree to the <a href="/terms" className="underline">Terms</a> and{' '}
          <a href="/privacy" className="underline">Privacy Policy</a>, and to receive WhatsApp messages from
          HisabKitab about my account.
        </span>
      </label>
      {err('consent')}
      {notice ? (
        <p className="rounded-control border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{notice}</p>
      ) : null}
      <button type="submit" disabled={busy} className="btn-primary w-full justify-center disabled:opacity-60">
        {busy ? 'Sending code…' : 'Send my WhatsApp code →'}
      </button>
      <p className="text-center text-xs text-muted">
        Free during the pilot. No card needed. You approve every entry.
      </p>
    </form>
  );
}
