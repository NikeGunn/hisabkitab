/**
 * Billing guard for proactive templates. Meta can silently re-categorise an
 * approved UTILITY template as MARKETING (it did to three of ours on 2026-10-08:
 * "Reply renew" read as a sales prompt). MARKETING bills at the highest rate and
 * needs opt-in, so a re-categorised template must NEVER go out unnoticed.
 *
 * Every WaClient.sendTemplate asks this guard first. It knows each template's LIVE
 * category from Meta (cached, refreshed every few minutes) and refuses to send one
 * that is now MARKETING — the send fails like any Graph error (schedulers release
 * their latch and retry tomorrow, so once the wording is fixed it just works).
 *
 * Verdicts (CLAUDE.md §8 taxonomy):
 *   PASS    live category is UTILITY/AUTHENTICATION → send
 *   FAIL    live category is MARKETING (observed and wrong) → refuse, alert
 *   BLOCKED could not read the category (Graph down, never loaded) → send on the
 *           category declared in templates.ts, which a unit test pins to
 *           UTILITY/AUTHENTICATION. Deliberate availability trade-off: a Meta
 *           outage must not stop signup codes; the last KNOWN category still wins,
 *           so a template once seen as MARKETING stays refused through an outage.
 */
export type TemplateCategory = 'UTILITY' | 'AUTHENTICATION' | 'MARKETING' | string;
export type GuardVerdict = 'PASS' | 'FAIL' | 'BLOCKED';

/** Pure decision: may this template be sent, given its live category (if known)? */
export function templateSendVerdict(live: TemplateCategory | undefined): GuardVerdict {
  if (live === undefined) return 'BLOCKED';
  return live === 'MARKETING' ? 'FAIL' : 'PASS';
}

export class TemplateBillingBlocked extends Error {
  constructor(readonly templateName: string) {
    super(
      `template "${templateName}" is categorised MARKETING by Meta — refused to avoid marketing charges. ` +
        'Reword it as a plain account notice under a new name (templates.ts) and resubmit.',
    );
    this.name = 'TemplateBillingBlocked';
  }
}

export interface CategoryGuardOptions {
  /** Live name → category map from Meta. Throws on Graph failure. */
  fetchCategories: () => Promise<Map<string, TemplateCategory>>;
  /** Which account the map belongs to; a change (admin swaps the account) forces a reload. */
  scope?: () => string;
  ttlMs?: number;
  /** After a failed lookup, wait this long before asking Meta again (default 60s). */
  retryAfterMs?: number;
  now?: () => number;
  /** Called on every refusal (log + metric + operator alert). */
  onBlocked?: (templateName: string) => void;
  /** Called when the live categories can't be read (verdict BLOCKED). */
  onLookupError?: (err: unknown) => void;
}

export class TemplateCategoryGuard {
  private known = new Map<string, TemplateCategory>();
  private loadedAt = -Infinity;
  private loadedScope: string | undefined;
  private nextTryAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: CategoryGuardOptions) {}

  private async refresh(): Promise<void> {
    const now = this.opts.now?.() ?? Date.now();
    const scope = this.opts.scope?.();
    if (scope !== this.loadedScope) {
      // Another account's categories say nothing about this one.
      this.known = new Map();
      this.loadedAt = -Infinity;
      this.nextTryAt = -Infinity;
      this.loadedScope = scope;
    }
    if (now - this.loadedAt < (this.opts.ttlMs ?? 5 * 60_000)) return;
    if (now < this.nextTryAt) return; // Meta was unreachable a moment ago; don't hammer it
    this.inflight ??= this.opts
      .fetchCategories()
      .then((map) => {
        this.known = map; // replace: a renamed/deleted template must not linger
        this.loadedAt = this.opts.now?.() ?? Date.now();
      })
      .catch((err: unknown) => {
        // keep the last known map; a template once seen MARKETING stays refused
        this.nextTryAt = (this.opts.now?.() ?? Date.now()) + (this.opts.retryAfterMs ?? 60_000);
        this.opts.onLookupError?.(err);
      })
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
  }

  /** Throws TemplateBillingBlocked when the template must not be sent. */
  async assertSendable(templateName: string): Promise<GuardVerdict> {
    await this.refresh();
    const verdict = templateSendVerdict(this.known.get(templateName));
    if (verdict === 'FAIL') {
      this.opts.onBlocked?.(templateName);
      throw new TemplateBillingBlocked(templateName);
    }
    return verdict;
  }

  /** Categories as last seen (admin panel / diagnostics). */
  snapshot(): ReadonlyMap<string, TemplateCategory> {
    return this.known;
  }
}

/** Read every template's live category from the WhatsApp Business Account. */
export function graphCategoryFetcher(opts: {
  creds: () => { accessToken: string; businessAccountId: string };
  baseUrl?: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): () => Promise<Map<string, TemplateCategory>> {
  const base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const version = opts.graphVersion ?? 'v23.0';
  return async () => {
    const { accessToken, businessAccountId } = opts.creds();
    const res = await (opts.fetchImpl ?? fetch)(
      `${base}/${version}/${businessAccountId}/message_templates?fields=name,category,status&limit=250`,
      // Bounded: a hanging Graph call must not stall every template send behind it.
      { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) },
    );
    if (!res.ok) throw new Error(`template categories → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { name: string; category: string; status: string }[] };
    const map = new Map<string, TemplateCategory>();
    for (const row of body.data ?? []) {
      // several languages/versions may exist; the APPROVED one is what gets sent
      if (!map.has(row.name) || row.status === 'APPROVED') map.set(row.name, row.category);
    }
    return map;
  };
}
