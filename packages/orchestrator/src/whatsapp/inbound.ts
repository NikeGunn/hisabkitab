/**
 * Inbound webhook payload parsing — zod on every external input (CLAUDE.md §4).
 * Normalizes Meta's envelope into flat InboundMessage records. Delivery status
 * updates (sent/delivered/read/failed) are parsed separately by
 * parseDeliveryStatuses; unknown change fields are ignored, never errors.
 */
import { z } from 'zod';

const mediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(), // sender phone, digits only (no '+'), e.g. 9779801234567
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    document: mediaSchema.optional(),
    audio: mediaSchema.optional(),
  })
  .loose();

const webhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          changes: z.array(
            z
              .object({
                field: z.string(),
                value: z
                  .object({
                    messages: z.array(messageSchema).optional(),
                    metadata: z.object({ phone_number_id: z.string().optional() }).loose().optional(),
                  })
                  .loose(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

export interface InboundMedia {
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}

export interface InboundMessage {
  waMessageId: string;
  /** E.164 with leading '+', normalized from Meta's bare digits. */
  fromE164: string;
  /**
   * The business number the message was SENT TO (Meta metadata.phone_number_id).
   * One Meta app can serve several products' numbers; the router only answers
   * messages addressed to HisabKitab's own sender.
   */
  toPhoneNumberId?: string;
  timestamp: string;
  kind: 'text' | 'image' | 'document' | 'audio' | 'unsupported';
  text?: string;
  media?: InboundMedia;
}

/** Throws ZodError on a malformed envelope; returns [] for status-only payloads. */
export function parseInboundWebhook(payload: unknown): InboundMessage[] {
  const parsed = webhookSchema.parse(payload);
  if (parsed.object !== 'whatsapp_business_account') return [];

  const out: InboundMessage[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      for (const m of change.value.messages ?? []) {
        const to = change.value.metadata?.phone_number_id;
        const base = {
          waMessageId: m.id,
          fromE164: m.from.startsWith('+') ? m.from : `+${m.from}`,
          timestamp: m.timestamp,
          ...(to ? { toPhoneNumberId: to } : {}),
        };
        if (m.type === 'text' && m.text) {
          out.push({ ...base, kind: 'text', text: m.text.body });
        } else if (m.type === 'image' && m.image) {
          out.push({
            ...base,
            kind: 'image',
            text: m.image.caption,
            media: {
              mediaId: m.image.id,
              mimeType: m.image.mime_type ?? 'image/jpeg',
              caption: m.image.caption,
            },
          });
        } else if (m.type === 'document' && m.document) {
          out.push({
            ...base,
            kind: 'document',
            text: m.document.caption,
            media: {
              mediaId: m.document.id,
              mimeType: m.document.mime_type ?? 'application/pdf',
              filename: m.document.filename,
              caption: m.document.caption,
            },
          });
        } else if (m.type === 'audio' && m.audio) {
          // voice is v2.0 P12 — surfaced as "coming soon" by the router
          out.push({
            ...base,
            kind: 'audio',
            media: { mediaId: m.audio.id, mimeType: m.audio.mime_type ?? 'audio/ogg' },
          });
        } else {
          out.push({ ...base, kind: 'unsupported' });
        }
      }
    }
  }
  return out;
}

// ── Delivery statuses ────────────────────────────────────────────────────────
// Meta reports the fate of every OUTBOUND message asynchronously here: an
// "accepted" send can still fail later (131030 recipient not allowed, 131047
// 24h window closed, template errors). Without this, those failures were silent.

const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    recipient_id: z.string().optional(),
    errors: z
      .array(z.object({ code: z.number(), title: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

export interface DeliveryStatus {
  waMessageId: string;
  status: string;
  /** Last 4 digits only: a phone number is PII and must not reach the logs. */
  recipientTail?: string;
  errors: { code: number; title?: string }[];
}

/**
 * Tolerant by design: each status entry is validated on its own and a malformed
 * one is skipped, so a status we don't understand can never 400 the webhook or
 * disturb processing of the messages that arrived in the same envelope.
 */
export function parseDeliveryStatuses(payload: unknown): DeliveryStatus[] {
  const out: DeliveryStatus[] = [];
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown } })?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const raw of statuses) {
        const st = statusSchema.safeParse(raw);
        if (!st.success) continue;
        out.push({
          waMessageId: st.data.id,
          status: st.data.status,
          ...(st.data.recipient_id ? { recipientTail: st.data.recipient_id.slice(-4) } : {}),
          errors: (st.data.errors ?? []).map((e) => ({
            code: e.code,
            ...(e.title ? { title: e.title } : {}),
          })),
        });
      }
    }
  }
  return out;
}
