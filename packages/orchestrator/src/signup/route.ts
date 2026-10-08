/**
 * POST /signup — the public endpoint behind the hisabkitab.pro pilot form.
 * CORS is limited to the website origins; a per-IP token bucket sits in front of
 * the per-number / global limits inside handleSignup. Responses never contain a
 * code or another business's data.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TenantRateLimiter } from '../resilience/rate-limit.js';
import { handleSignup, type SignupDeps, type SignupResult } from './signup.js';

export const SIGNUP_ALLOWED_ORIGINS = [
  'https://hisabkitab.pro',
  'https://www.hisabkitab.pro',
  'http://localhost:3000',
];

const STATUS_CODE: Record<SignupResult['status'], number> = {
  code_sent: 200,
  under_review: 202,
  already_registered: 200,
  invalid: 400,
  closed: 503,
  busy: 503,
  rate_limited: 429,
  send_failed: 502,
};

function cors(req: FastifyRequest, reply: FastifyReply): void {
  const origin = req.headers.origin;
  if (origin && SIGNUP_ALLOWED_ORIGINS.includes(origin)) {
    reply
      .header('access-control-allow-origin', origin)
      .header('vary', 'Origin')
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '600');
  }
}

export function registerSignup(
  app: FastifyInstance,
  deps: SignupDeps,
  limiter = new TenantRateLimiter({ capacity: 5, refillPerSec: 5 / 3600 }),
): void {
  app.options('/signup', async (req, reply) => {
    cors(req, reply);
    return reply.code(204).send();
  });

  app.post('/signup', async (req, reply) => {
    cors(req, reply);
    reply.header('cache-control', 'no-store');
    const ip = req.ip; // resolved via trustProxy (Caddy hop only)
    if (!limiter.take(`signup:${ip}`).allowed) {
      return reply.code(429).send({ status: 'rate_limited' });
    }
    let body: unknown = req.body;
    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'));
      } catch {
        return reply.code(400).send({ status: 'invalid', errors: { form: 'malformed request' } });
      }
    }
    try {
      const result = await handleSignup(deps, body);
      return reply.code(STATUS_CODE[result.status]).send(result);
    } catch (err) {
      deps.log?.('signup failed', { error: String(err) });
      return reply.code(500).send({ status: 'error' });
    }
  });
}
