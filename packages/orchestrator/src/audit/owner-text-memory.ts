/**
 * The owner's own recent messages, per tenant, so the Audit Gate can accept a
 * figure the OWNER typed earlier in the conversation (Rehearsal Lab finding #5:
 * owner figures were evidence only in the turn they were typed, so one turn later
 * the agent could not repeat the owner's own number and every such reply was held).
 *
 * Only verbatim inbound owner text goes in — never agent output, never OCR. Bounded
 * (last N messages, TTL, tenant cap) and in-memory: after a restart it is empty,
 * which only makes the gate stricter (fail closed), never looser.
 */
export class OwnerTextMemory {
  private readonly byTenant = new Map<string, Array<{ at: number; text: string }>>();

  constructor(
    private readonly maxMessages = 10,
    private readonly ttlMs = 6 * 60 * 60_000,
    private readonly maxTenants = 5_000,
  ) {}

  /** Messages still inside the window, oldest first (excludes the current one). */
  recent(tenantId: string, now = Date.now()): string[] {
    const list = (this.byTenant.get(tenantId) ?? []).filter((m) => now - m.at <= this.ttlMs);
    return list.map((m) => m.text);
  }

  remember(tenantId: string, text: string | undefined, now = Date.now()): void {
    if (!text?.trim()) return;
    const list = (this.byTenant.get(tenantId) ?? []).filter((m) => now - m.at <= this.ttlMs);
    list.push({ at: now, text });
    this.byTenant.delete(tenantId); // re-insert = most recently used last
    this.byTenant.set(tenantId, list.slice(-this.maxMessages));
    if (this.byTenant.size > this.maxTenants)
      this.byTenant.delete(this.byTenant.keys().next().value as string);
  }

  forget(tenantId: string): void {
    this.byTenant.delete(tenantId);
  }
}
