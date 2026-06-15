/**
 * Every gate decision (pass/hold + reason) is written to `audit_log` —
 * the literal "traced on audit before delivering to the user" requirement
 * (PRD v1.1 §4.3). Memory implementation for tests / dry runs.
 */
import { appendAudit, createDb, withTenant, type DbHandle } from '@hisab/db';
import type { GateDecision } from './gate.js';

export interface GateLogEntry {
  tenantId: string;
  sessionId: string;
  decision: GateDecision;
  /** First 500 chars of the audited outbound message. */
  messagePreview: string;
}

export interface GateLogger {
  log(entry: GateLogEntry): Promise<void>;
}

export class MemoryGateLogger implements GateLogger {
  readonly entries: GateLogEntry[] = [];
  log(entry: GateLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export class DbGateLogger implements GateLogger {
  private readonly handle: DbHandle;
  constructor(databaseUrl: string) {
    this.handle = createDb(databaseUrl);
  }
  async log(entry: GateLogEntry): Promise<void> {
    await withTenant(this.handle.db, entry.tenantId, async (tx) => {
      await appendAudit(tx, entry.tenantId, {
        actor: 'system',
        action: entry.decision.action === 'deliver' ? 'audit_gate_pass' : 'audit_gate_hold',
        detail: {
          sessionId: entry.sessionId,
          reasons: entry.decision.action === 'hold' ? entry.decision.reasons : [],
          messagePreview: entry.messagePreview.slice(0, 500),
        },
      });
    });
  }
  close(): Promise<void> {
    return this.handle.close();
  }
}
