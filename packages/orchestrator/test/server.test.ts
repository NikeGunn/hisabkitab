/** Webhook routes on the REAL Fastify server (router mocked) — incl. auth PROBES. */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { RouterDeps } from '../src/whatsapp/router.js';

vi.mock('../src/whatsapp/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/whatsapp/router.js')>()),
  processInbound: vi.fn().mockResolvedValue(true),
}));
const { processInbound } = await import('../src/whatsapp/router.js');

const SECRET = 'app-secret-123';
const VERIFY = 'verify-token-123';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

const PAYLOAD = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              { id: 'wamid.s1', from: '977980', timestamp: '1', type: 'text', text: { body: 'hi' } },
            ],
          },
        },
      ],
    },
  ],
});

let app: FastifyInstance;

beforeAll(() => {
  app = buildServer({
    verifyToken: VERIFY,
    appSecret: SECRET,
    awaitProcessing: true,
    deps: {} as RouterDeps, // router is mocked
  });
});

afterAll(() => app.close());

describe('GET /healthz + /livez (Docker/K8s probes)', () => {
  it('both return 200 with no auth', async () => {
    for (const url of ['/healthz', '/livez']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, service: 'orchestrator' });
    }
  });
});

describe('GET /webhook (handshake)', () => {
  it('echoes the challenge for the right verify token', async () => {
    const res = await app.inject({
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=c123`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('c123');
  });

  it('PROBE: 403 on the wrong verify token', async () => {
    const res = await app.inject({
      url: `/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=c123`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhook', () => {
  const post = (body: string, signature?: string) =>
    app.inject({
      method: 'POST',
      url: '/webhook',
      payload: body,
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
    });

  it('accepts a signed payload and routes its messages', async () => {
    const res = await post(PAYLOAD, sign(PAYLOAD));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1 });
    expect(processInbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ waMessageId: 'wamid.s1' }),
    );
  });

  it('PROBE: 401 on a missing or forged signature — body never parsed', async () => {
    expect((await post(PAYLOAD)).statusCode).toBe(401);
    expect((await post(PAYLOAD, 'sha256=' + '0'.repeat(64))).statusCode).toBe(401);
  });

  it('PROBE: 400 on signed-but-malformed JSON', async () => {
    const bad = '{"object": nope}';
    expect((await post(bad, sign(bad))).statusCode).toBe(400);
  });
});
