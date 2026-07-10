/** Webhook security — happy paths + PROBES (forged signature, wrong token). */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleVerifyHandshake, verifyWebhookSignature } from '../src/whatsapp/signature.js';

const SECRET = 'meta-app-secret';
const sign = (body: Buffer | string) =>
  `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed raw body', () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('PROBE: rejects a signature over DIFFERENT bytes (tampered body)', () => {
    expect(verifyWebhookSignature(Buffer.from('{"x":2}'), sign('{"x":1}'), SECRET)).toBe(false);
  });

  it('treats BOM, CRLF, trailing newline, and JSON ordering as significant raw bytes', () => {
    const compact = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
    const trailingLf = Buffer.concat([compact, Buffer.from('\n')]);
    const trailingCrlf = Buffer.concat([compact, Buffer.from('\r\n')]);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), compact]);
    const reordered = Buffer.from('{"entry":[],"object":"whatsapp_business_account"}');

    for (const exactBody of [compact, trailingLf, trailingCrlf, bom, reordered]) {
      expect(verifyWebhookSignature(exactBody, sign(exactBody), SECRET)).toBe(true);
    }

    for (const changedBody of [trailingLf, trailingCrlf, bom, reordered]) {
      expect(verifyWebhookSignature(changedBody, sign(compact), SECRET)).toBe(false);
    }
  });

  it('PROBE: rejects missing/malformed headers', () => {
    expect(verifyWebhookSignature('body', undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', 'sha1=abcd', SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', 'sha256=zz-not-hex', SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', 'sha256=' + '0'.repeat(62), SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', 'sha256=' + '0'.repeat(66), SECRET)).toBe(false);
  });
});

describe('handleVerifyHandshake', () => {
  const q = (token: string) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': token,
    'hub.challenge': 'CHALLENGE_123',
  });

  it('echoes the challenge for the right token', () => {
    expect(handleVerifyHandshake(q('tok'), 'tok')).toBe('CHALLENGE_123');
  });

  it('PROBE: rejects the wrong token and wrong mode', () => {
    expect(handleVerifyHandshake(q('wrong'), 'tok')).toBeNull();
    expect(handleVerifyHandshake({ ...q('tok'), 'hub.mode': 'unsubscribe' }, 'tok')).toBeNull();
  });
});
