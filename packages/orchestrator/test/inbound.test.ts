/** Meta envelope parsing — text/image/document/status payloads + malformed PROBE. */
import { describe, expect, it } from 'vitest';
import { parseDeliveryStatuses, parseInboundWebhook } from '../src/whatsapp/inbound.js';

const envelope = (messages: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { messages } }] }],
});

describe('parseInboundWebhook', () => {
  it('parses a text message and normalizes the sender to E.164', () => {
    const [m] = parseInboundWebhook(
      envelope([
        {
          id: 'wamid.1',
          from: '9779801234567',
          timestamp: '1718000000',
          type: 'text',
          text: { body: 'add catering 9000' },
        },
      ]),
    );
    expect(m).toMatchObject({
      waMessageId: 'wamid.1',
      fromE164: '+9779801234567',
      kind: 'text',
      text: 'add catering 9000',
    });
  });

  it('parses image and document media with captions', () => {
    const msgs = parseInboundWebhook(
      envelope([
        {
          id: 'wamid.2',
          from: '977980',
          timestamp: '1',
          type: 'image',
          image: { id: 'media1', mime_type: 'image/jpeg', caption: 'bill' },
        },
        {
          id: 'wamid.3',
          from: '977980',
          timestamp: '2',
          type: 'document',
          document: { id: 'media2', mime_type: 'application/pdf', filename: 'inv.pdf' },
        },
      ]),
    );
    expect(msgs[0]).toMatchObject({
      kind: 'image',
      media: { mediaId: 'media1', mimeType: 'image/jpeg' },
      text: 'bill',
    });
    expect(msgs[1]).toMatchObject({
      kind: 'document',
      media: { mediaId: 'media2', filename: 'inv.pdf' },
    });
  });

  it('maps audio and unknown types for the coming-soon path', () => {
    const msgs = parseInboundWebhook(
      envelope([
        { id: 'wamid.4', from: '1', timestamp: '1', type: 'audio', audio: { id: 'media3' } },
        { id: 'wamid.5', from: '1', timestamp: '1', type: 'sticker' },
      ]),
    );
    expect(msgs.map((m) => m.kind)).toEqual(['audio', 'unsupported']);
  });

  it('returns [] for status-only deliveries (no messages array)', () => {
    expect(
      parseInboundWebhook({
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] },
        ],
      }),
    ).toEqual([]);
  });

  it('PROBE: throws on a malformed envelope instead of guessing', () => {
    expect(() => parseInboundWebhook({ entry: 'nope' })).toThrow();
    expect(() => parseInboundWebhook(null)).toThrow();
  });
});

describe('parseDeliveryStatuses', () => {
  const statusEnvelope = (statuses: unknown[], messages?: unknown[]) => ({
    object: 'whatsapp_business_account',
    entry: [
      { changes: [{ field: 'messages', value: { statuses, ...(messages ? { messages } : {}) } }] },
    ],
  });

  it('parses sent/delivered with only the last 4 recipient digits', () => {
    const out = parseDeliveryStatuses(
      statusEnvelope([
        { id: 'wamid.1', status: 'sent', recipient_id: '9779705651002', timestamp: '1' },
        { id: 'wamid.1', status: 'delivered', recipient_id: '9779705651002', timestamp: '2' },
      ]),
    );
    expect(out).toEqual([
      { waMessageId: 'wamid.1', status: 'sent', recipientTail: '1002', errors: [] },
      { waMessageId: 'wamid.1', status: 'delivered', recipientTail: '1002', errors: [] },
    ]);
    expect(JSON.stringify(out)).not.toContain('97797056');
  });

  it('PROBE: an accepted-then-failed send surfaces the Meta error code (131030)', () => {
    const [st] = parseDeliveryStatuses(
      statusEnvelope([
        {
          id: 'wamid.2',
          status: 'failed',
          recipient_id: '15550001111',
          errors: [{ code: 131030, title: 'Recipient phone number not in allowed list' }],
        },
      ]),
    );
    expect(st).toMatchObject({ status: 'failed', errors: [{ code: 131030 }] });
  });

  it('PROBE: a malformed status is skipped, never throws, and leaves messages parseable', () => {
    const payload = statusEnvelope(
      [{ status: 'sent' /* no id */ }, 'garbage', { id: 'wamid.3', status: 'read' }],
      [{ id: 'wamid.in', from: '977980', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    );
    expect(parseDeliveryStatuses(payload)).toEqual([
      { waMessageId: 'wamid.3', status: 'read', errors: [] },
    ]);
    expect(parseInboundWebhook(payload)).toHaveLength(1);
    expect(parseDeliveryStatuses({ entry: 'nope' })).toEqual([]);
    expect(parseDeliveryStatuses(null)).toEqual([]);
  });
});
