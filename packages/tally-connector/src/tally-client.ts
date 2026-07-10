/**
 * Minimal HTTP client for the LOCAL TallyPrime XML server (default localhost:9000).
 * Hard limits at this boundary: request timeout + response size cap — a hung or
 * runaway Tally can stall one job, never the connector.
 */
export interface TallyClientOptions {
  baseUrl: string; // e.g. http://localhost:9000
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class TallyHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyHttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5_000_000;

export class TallyClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: TallyClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  /** GET / — TallyPrime answers a plain "…Server is Running" banner when up. */
  async ping(): Promise<boolean> {
    try {
      const text = await this.request('GET');
      return /running/i.test(text);
    } catch {
      return false;
    }
  }

  /** POST one XML request envelope, return the raw XML response text. */
  async post(xml: string): Promise<string> {
    return this.request('POST', xml);
  }

  private async request(method: 'GET' | 'POST', body?: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.opts.baseUrl, {
        method,
        ...(body !== undefined
          ? { body, headers: { 'content-type': 'text/xml;charset=utf-8' } }
          : {}),
        signal: controller.signal,
      });
      if (!res.ok) throw new TallyHttpError(`Tally answered HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxBytes) {
        throw new TallyHttpError(
          `Tally response exceeds ${this.maxBytes} bytes — refine the query`,
        );
      }
      return text;
    } catch (err) {
      if (err instanceof TallyHttpError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new TallyHttpError(`Tally did not answer within ${this.timeoutMs} ms`);
      }
      throw new TallyHttpError(
        `cannot reach TallyPrime at ${this.opts.baseUrl}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
