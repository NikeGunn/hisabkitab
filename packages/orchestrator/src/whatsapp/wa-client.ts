/**
 * WhatsApp Cloud API (Meta Graph) client. Free-form text replies ride the 24h
 * service window (every send here is inbound-triggered); proactive sends must
 * use the pre-approved Utility templates (templates.ts).
 *
 * `baseUrl` is injectable so tests/verification drive a local stub instead of
 * graph.facebook.com — the client code path stays identical.
 *
 * Transient Graph failures (429 / 5xx / network) are retried with backoff
 * (PRD §7 Phase 7); a 4xx (bad token / bad request) fails fast.
 */
import { withRetry } from '../resilience/retry.js';

export interface WaClientOptions {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version; bump deliberately, not implicitly. */
  graphVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** retry attempts for transient Graph failures (default 3; set 1 to disable). */
  retryAttempts?: number;
}

export interface WaMediaMeta {
  url: string;
  mimeType: string;
  fileSizeBytes: number;
}

export class WaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WaError';
  }
}

export class WaClient {
  private readonly base: string;
  private readonly version: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: WaClientOptions) {
    this.base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
    this.version = opts.graphVersion ?? 'v23.0';
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    // Retry only transient failures (429/5xx/network). A WaError carries .status,
    // so a 4xx (bad token / bad payload) fails fast instead of burning retries.
    return withRetry(
      async () => {
        const res = await this.fetch(`${this.base}/${this.version}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${this.opts.accessToken}`,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
          },
        });
        if (!res.ok) {
          throw new WaError(`graph ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
        }
        return res.json();
      },
      { attempts: this.opts.retryAttempts ?? 3 },
    );
  }

  /** Free-form text inside the 24h service window. `to` is E.164 (with or without '+'). */
  async sendText(to: string, body: string): Promise<void> {
    await this.request(`/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
  }

  /** Pre-approved Utility template (the only legal proactive send). */
  async sendTemplate(to: string, templateName: string, bodyParams: string[], lang = 'en'): Promise<void> {
    await this.request(`/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: lang },
          components: bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      }),
    });
  }

  /**
   * Upload bytes to the Cloud API media store, returning the media id.
   * Used to deliver generated report PDFs (multipart, so NOT via `request`).
   */
  async uploadMedia(bytes: Buffer, mimeType: string, filename: string): Promise<string> {
    return withRetry(
      async () => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
        const res = await this.fetch(`${this.base}/${this.version}/${this.opts.phoneNumberId}/media`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.accessToken}` },
          body: form,
        });
        if (!res.ok) throw new WaError(`media upload → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
        return (await res.json() as { id: string }).id;
      },
      { attempts: this.opts.retryAttempts ?? 3 },
    );
  }

  /**
   * Send a document (PDF report) inside the 24h service window. Uploads the bytes
   * first, then sends a document message with a one-line caption.
   */
  async sendDocument(to: string, bytes: Buffer, filename: string, caption: string, mimeType = 'application/pdf'): Promise<void> {
    const mediaId = await this.uploadMedia(bytes, mimeType, filename);
    await this.request(`/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/^\+/, ''),
        type: 'document',
        document: { id: mediaId, filename, caption },
      }),
    });
  }

  /** Step 1 of media download: resolve the short-lived CDN URL. */
  async fetchMediaMeta(mediaId: string): Promise<WaMediaMeta> {
    const meta = (await this.request(`/${mediaId}`, { method: 'GET' })) as {
      url: string;
      mime_type: string;
      file_size: number;
    };
    return { url: meta.url, mimeType: meta.mime_type, fileSizeBytes: meta.file_size };
  }

  /** Step 2: download the bytes (same bearer; URL is NOT under /vXX.X). */
  async downloadMedia(meta: WaMediaMeta): Promise<Buffer> {
    const res = await this.fetch(meta.url, {
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
    });
    if (!res.ok) throw new WaError(`media download → ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
