/**
 * Runtime settings store (migration 0019 `app_settings`). The registry of keys,
 * validators and secret flags is the pure `@hisab/shared` SETTINGS map; this file
 * is only persistence + an in-process cache.
 *
 * Secrets are encrypted with the PII field key (AES-256-GCM, `enc:v1:`). Saving a
 * secret WITHOUT a configured key is refused — a Khalti or Meta credential must
 * never sit in the database as plaintext.
 *
 * Runs on the hisab_orch connection (orchestrator + the payments callback handle);
 * hisab_app has no grant on the table.
 */
import { eq } from 'drizzle-orm';
import {
  SETTINGS,
  isSettingKey,
  resolveSetting,
  settingSource,
  validateSetting,
  type SettingKey,
} from '@hisab/shared';
import type { Db } from './client.js';
import { appSettings, adminEvents } from './schema.js';
import { decPII, encPII, hasPiiKey } from './pii.js';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** All saved settings, secrets decrypted. Unknown (retired) keys are skipped. */
export async function loadSavedSettings(db: Db): Promise<Map<string, string>> {
  const rows = await db.select().from(appSettings);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue;
    out.set(r.key, r.isSecret ? (decPII(r.value) ?? '') : r.value);
  }
  return out;
}

/**
 * Validate + persist one setting and append an admin_events row. Returns the
 * normalized value. The event never contains a secret value — only that it changed.
 */
export async function saveSetting(
  db: Db,
  key: string,
  raw: string,
  actor: string,
  ip?: string,
): Promise<string> {
  if (!isSettingKey(key)) throw new SettingsError(`unknown setting: ${key}`);
  const def = SETTINGS[key];
  const value = validateSetting(key, raw);
  if (def.secret && !hasPiiKey()) {
    throw new SettingsError(
      'FIELD_ENCRYPTION_KEY is not configured on this server, so secrets cannot be stored safely. Set it, then retry.',
    );
  }
  const stored = def.secret ? (encPII(value) as string) : value;
  await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({ key, value: stored, isSecret: def.secret, updatedBy: actor })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: stored, isSecret: def.secret, updatedBy: actor, updatedAt: new Date() },
      });
    await tx.insert(adminEvents).values({
      actor,
      action: 'setting.updated',
      detail: def.secret ? { key, secret: true } : { key, value },
      ip: ip ?? null,
    });
  });
  return value;
}

/** Remove an override so the env/default value applies again. */
export async function clearSetting(db: Db, key: string, actor: string, ip?: string): Promise<void> {
  if (!isSettingKey(key)) throw new SettingsError(`unknown setting: ${key}`);
  await db.transaction(async (tx) => {
    await tx.delete(appSettings).where(eq(appSettings.key, key));
    await tx.insert(adminEvents).values({ actor, action: 'setting.cleared', detail: { key }, ip: ip ?? null });
  });
}

/**
 * Process-local snapshot of the saved settings, refreshed on an interval so every
 * service sees an admin edit within `intervalMs` without a restart. Reads are
 * synchronous (hot path: every webhook / every Khalti call). If a refresh fails the
 * last good snapshot is kept and the error is reported, never swallowed silently.
 */
export class SettingsCache {
  private saved = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private loadedOnce = false;

  constructor(
    private readonly db: Db,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly onError: (err: unknown) => void = (err) =>
      console.error(`[settings] refresh failed: ${String(err)}`),
  ) {}

  async refresh(): Promise<void> {
    this.saved = await loadSavedSettings(this.db);
    this.loadedOnce = true;
  }

  /** Load now, then keep refreshing. Boot fails loudly if the first load fails. */
  async start(intervalMs = 10_000): Promise<this> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch(this.onError);
    }, intervalMs);
    this.timer.unref();
    return this;
  }

  /**
   * Like start(), but a failed first load does NOT throw: the process stays up
   * (liveness must not depend on the DB) and keeps retrying. Until a load
   * succeeds `ready` is false — callers that act on money/credentials must check
   * it rather than fall back to env defaults that an admin may have overridden.
   */
  startLenient(intervalMs = 10_000): this {
    const tick = () => this.refresh().catch(this.onError);
    void tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get ready(): boolean {
    return this.loadedOnce;
  }

  get(key: SettingKey): string | undefined {
    return resolveSetting(key, this.saved, this.env);
  }

  /** Like get, but throws when no value is configured anywhere. */
  require(key: SettingKey): string {
    const v = this.get(key);
    if (v === undefined || v === '') throw new SettingsError(`setting ${key} is not configured`);
    return v;
  }

  bool(key: SettingKey): boolean {
    return this.get(key) === 'true';
  }

  source(key: SettingKey): ReturnType<typeof settingSource> {
    return settingSource(key, this.saved, this.env);
  }
}
