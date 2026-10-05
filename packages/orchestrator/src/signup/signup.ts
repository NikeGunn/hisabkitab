/**
 * Self-serve signup (hisabkitab.pro/pilot → POST /signup).
 *
 *   form → validate → (pending tenant, number-bound 6-digit code) → WhatsApp
 *   `pairing_code` AUTHENTICATION template to the CLAIMED number → owner sends
 *   `START <code>` (or pastes the code) FROM that number → pairing.ts binds it,
 *   activates the tenant and starts the trial.
 *
 * Nothing on the form is authority: the number becomes the owner's identity only
 * after the owner proves control of it on WhatsApp. Abuse controls (each code is a
 * paid Meta authentication message): honeypot, per-IP bucket (route layer),
 * per-number daily limit, global daily cap, one live code per business.
 */
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { appendAudit, encPII, schema, type Db } from '@hisab/db';
import {
  SIGNUP_CODES_PER_NUMBER_PER_DAY,
  SIGNUP_CODE_TTL_MINUTES,
  isBotSubmission,
  signupInputSchema,
} from '@hisab/shared';
import { issuePairingCode } from '../onboarding/pairing.js';

export const PAIRING_TEMPLATE = 'pairing_code';
export const ADMIN_SIGNUP_ALERT_TEMPLATE = 'admin_account_update';

export interface SignupSettings {
  enabled(): boolean;
  dailyCap(): number;
  /** Public sender number (+977…) for the wa.me deep link; undefined = not set. */
  senderE164(): string | undefined;
  /** Admin's WhatsApp for new-signup alerts; undefined/empty = off. */
  alertE164(): string | undefined;
}

export interface SignupDeps {
  db: Db; // hisab_orch
  sendAuthCode(to: string, template: string, code: string): Promise<void>;
  sendTemplate(to: string, template: string, params: string[]): Promise<void>;
  settings: SignupSettings;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

export type SignupResult =
  | { status: 'code_sent'; sender_e164?: string; wa_link?: string; expires_minutes: number }
  | { status: 'invalid'; errors: Record<string, string> }
  | { status: 'closed' }
  | { status: 'busy' }
  | { status: 'rate_limited' }
  | { status: 'already_registered'; sender_e164?: string; wa_link?: string }
  | { status: 'send_failed' };

/** wa.me link that opens a chat with HisabKitab pre-filled with "START ". */
export function waLink(senderE164: string | undefined): string | undefined {
  if (!senderE164) return undefined;
  return `https://wa.me/${senderE164.replace(/^\+/, '')}?text=${encodeURIComponent('START ')}`;
}

export async function handleSignup(deps: SignupDeps, body: unknown): Promise<SignupResult> {
  const now = deps.now?.() ?? new Date();
  const sender = deps.settings.senderE164() || undefined;

  let input;
  try {
    input = signupInputSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const errors: Record<string, string> = {};
      for (const issue of err.issues) {
        const field = String(issue.path[0] ?? 'form');
        errors[field] ??= issue.message;
      }
      return { status: 'invalid', errors };
    }
    throw err;
  }

  // Bot: pretend success, do nothing (no template spend, no row).
  if (isBotSubmission(input)) {
    deps.log?.('signup honeypot tripped');
    return { status: 'code_sent', expires_minutes: SIGNUP_CODE_TTL_MINUTES };
  }
  if (!deps.settings.enabled()) return { status: 'closed' };

  const phone = input.whatsapp;
  const dayAgo = new Date(now.getTime() - 86_400_000);

  // All decisions for one number happen under a per-number advisory lock, so two
  // racing submissions can never create two pending businesses or exceed limits.
  const decision = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'signup:' + phone}))`);

    const [{ n: sentToday } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.pairingCodes)
      .where(and(isNotNull(schema.pairingCodes.phoneE164), gt(schema.pairingCodes.createdAt, dayAgo)));
    if (sentToday >= deps.settings.dailyCap()) return { kind: 'busy' as const };

    const [{ n: forNumber } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.pairingCodes)
      .where(and(eq(schema.pairingCodes.phoneE164, phone), gt(schema.pairingCodes.createdAt, dayAgo)));
    if (forNumber >= SIGNUP_CODES_PER_NUMBER_PER_DAY) return { kind: 'rate_limited' as const };

    // Already an active member of any business? They should just message us.
    const [member] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.users.whatsappE164, phone), eq(schema.memberships.status, 'active')))
      .limit(1);
    const [owned] = await tx
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.whatsappE164, phone))
      .limit(1);
    if (member || owned) return { kind: 'already_registered' as const };

    // Re-use this number's still-pending business (a resend), else create one.
    const [pending] = await tx
      .select({ tenantId: schema.pairingCodes.tenantId })
      .from(schema.pairingCodes)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.pairingCodes.tenantId))
      .where(and(eq(schema.pairingCodes.phoneE164, phone), eq(schema.tenants.status, 'pending')))
      .orderBy(desc(schema.pairingCodes.createdAt))
      .limit(1);

    const fields = {
      businessName: input.business_name,
      ownerName: input.owner_name,
      panOrVatNo: encPII(input.pan_vat) as string,
      vatRegistered: input.vat_registered,
      contactEmail: input.email ?? null,
      signupSource: 'web' as const,
    };
    let tenantId: string;
    if (pending) {
      tenantId = pending.tenantId;
      await tx.update(schema.tenants).set(fields).where(eq(schema.tenants.id, tenantId));
    } else {
      const [t] = await tx.insert(schema.tenants).values(fields).returning({ id: schema.tenants.id });
      tenantId = t!.id;
    }
    const code = await issuePairingCode(tx, tenantId, { phoneE164: phone, digits: 6 });
    await appendAudit(tx, tenantId, {
      actor: 'system',
      action: 'signup.code_issued',
      detail: { source: 'web', resend: Boolean(pending) },
    });
    return { kind: 'issue' as const, tenantId, code, resend: Boolean(pending) };
  });

  if (decision.kind === 'busy') return { status: 'busy' };
  if (decision.kind === 'rate_limited') return { status: 'rate_limited' };
  if (decision.kind === 'already_registered') {
    const link = waLink(sender);
    return { status: 'already_registered', ...(sender ? { sender_e164: sender } : {}), ...(link ? { wa_link: link } : {}) };
  }

  try {
    await deps.sendAuthCode(phone, PAIRING_TEMPLATE, decision.code);
  } catch (err) {
    // Burn the code we could not deliver (and say so) — never leave a usable code
    // the owner never received.
    await deps.db
      .update(schema.pairingCodes)
      .set({ expiresAt: sql`now()` })
      .where(eq(schema.pairingCodes.code, decision.code));
    deps.log?.('signup code send failed', { error: String(err) });
    return { status: 'send_failed' };
  }

  await deps.db.insert(schema.adminEvents).values({
    actor: 'website',
    action: decision.resend ? 'signup.code_resent' : 'signup.created',
    detail: { tenant_id: decision.tenantId, business: input.business_name, phone_tail: phone.slice(-4) },
  });

  const alertTo = deps.settings.alertE164();
  if (alertTo && !decision.resend) {
    // best-effort: an alert failure must never fail the owner's signup
    await deps
      .sendTemplate(alertTo, ADMIN_SIGNUP_ALERT_TEMPLATE, [input.business_name])
      .catch((err) => deps.log?.('admin signup alert failed', { error: String(err) }));
  }

  const link = waLink(sender);
  return {
    status: 'code_sent',
    ...(sender ? { sender_e164: sender } : {}),
    ...(link ? { wa_link: link } : {}),
    expires_minutes: SIGNUP_CODE_TTL_MINUTES,
  };
}
