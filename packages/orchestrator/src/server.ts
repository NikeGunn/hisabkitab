/**
 * Fastify webhook server (PRD v1.0 §12):
 *   GET  /webhook — Meta verification handshake
 *   POST /webhook — signature check on the RAW body, ACK 200 immediately,
 *                   process messages asynchronously (Meta retries on slow ACKs)
 *   GET  /healthz
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { metricsResponse } from '@hisab/shared';
import { handleVerifyHandshake, verifyWebhookSignature } from './whatsapp/signature.js';
import { parseDeliveryStatuses, parseInboundWebhook } from './whatsapp/inbound.js';
import { processInbound, type RouterDeps } from './whatsapp/router.js';
import { metrics, metricsRegistry, inboundCtx, rootLogger } from './obs.js';

export interface ServerOptions {
  verifyToken: string;
  appSecret: string;
  deps: RouterDeps;
  /** Awaited in tests for determinism; fire-and-forget in production. */
  awaitProcessing?: boolean;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  // Keep the raw bytes — the HMAC is over them, not the re-serialized JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  // Liveness/readiness probe (Docker/K8s). No auth, no DB call.
  const health = () => ({ ok: true, service: 'orchestrator' });
  app.get('/healthz', health);
  app.get('/livez', health);

  // Prometheus scrape (P14 §8). Aggregate, low-cardinality counters/histograms
  // only — never a tenant id, phone number, or message body.
  app.get('/metrics', (_req, reply) => {
    const m = metricsResponse(metricsRegistry);
    return reply.code(m.status).header('content-type', m.contentType).send(m.body);
  });

  app.get('/webhook', (req, reply) => {
    const challenge = handleVerifyHandshake(req.query as Record<string, unknown>, opts.verifyToken);
    if (challenge === null) return reply.code(403).send('forbidden');
    return reply.code(200).send(challenge);
  });

  app.post('/webhook', async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifyWebhookSignature(raw, signature, opts.appSecret)) {
      return reply.code(401).send({ error: 'bad signature' });
    }

    let messages;
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
      messages = parseInboundWebhook(payload);
    } catch {
      return reply.code(400).send({ error: 'malformed payload' });
    }

    // Outbound delivery outcomes: log + count every one; a failure is a WARN with
    // Meta's error code so an undelivered reminder/reply is never silent.
    for (const st of parseDeliveryStatuses(payload)) {
      const code = st.errors[0] ? String(st.errors[0].code) : 'none';
      metrics.waDelivery({ status: st.status, code });
      const fields = {
        correlation_id: st.waMessageId,
        status: st.status,
        recipient_tail: st.recipientTail,
        ...(st.errors.length ? { errors: st.errors } : {}),
      };
      if (st.status === 'failed') rootLogger.warn('whatsapp delivery failed', fields);
      else rootLogger.info('whatsapp delivery status', fields);
    }

    const work = Promise.allSettled(
      messages.map((m) => {
        // One correlation id per inbound message (the wa_message_id) threads the
        // whole pipeline; every line below is greppable back to this message.
        const ctx = inboundCtx(m.waMessageId);
        return processInbound(opts.deps, m, ctx).catch((err) => {
          ctx.metrics.error({ component: 'process-inbound' });
          ctx.log.error('processInbound failed', { error: String(err) });
          opts.deps.log?.(`processInbound(${m.waMessageId}) failed: ${String(err)}`);
        });
      }),
    );
    if (opts.awaitProcessing) await work;
    return reply.code(200).send({ received: messages.length });
  });

  return app;
}
