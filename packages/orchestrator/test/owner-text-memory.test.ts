import { describe, expect, it } from 'vitest';
import { OwnerTextMemory } from '../src/audit/owner-text-memory.js';
import { addOwnerFigures, auditOutbound, newTurnEvidence } from '../src/audit/gate.js';

describe('OwnerTextMemory — owner figures stay gate evidence across turns (finding #5)', () => {
  it('a figure the owner typed one turn ago verifies the agent repeating it', () => {
    const mem = new OwnerTextMemory();
    mem.remember('t1', 'paid Rs 11,300 to Sharma', 1_000);
    const ev = newTurnEvidence();
    addOwnerFigures(ev, [...mem.recent('t1', 2_000), 'yes'].join('\n'));
    expect(auditOutbound('Saving Rs 11,300 as you said.', ev)).toEqual({ action: 'deliver' });
  });

  it('PROBE: a derived figure the owner never typed is still held', () => {
    const mem = new OwnerTextMemory();
    mem.remember('t1', 'paid Rs 11,300', 1_000);
    const ev = newTurnEvidence();
    addOwnerFigures(ev, mem.recent('t1', 2_000).join('\n'));
    expect(auditOutbound('VAT is Rs 1,300.', ev).action).toBe('hold');
  });

  it("PROBE: another tenant's figures never leak in", () => {
    const mem = new OwnerTextMemory();
    mem.remember('other', 'Rs 9,999');
    expect(mem.recent('t1')).toEqual([]);
  });

  it('PROBE: expires after the TTL and keeps only the last N messages', () => {
    const mem = new OwnerTextMemory(2, 1_000);
    mem.remember('t1', 'a 1', 0);
    mem.remember('t1', 'b 2', 10);
    mem.remember('t1', 'c 3', 20);
    expect(mem.recent('t1', 30)).toEqual(['b 2', 'c 3']);
    expect(mem.recent('t1', 5_000)).toEqual([]);
  });

  it('bounds the number of tenants (oldest evicted)', () => {
    const mem = new OwnerTextMemory(10, 1e9, 2);
    mem.remember('a', 'x');
    mem.remember('b', 'x');
    mem.remember('c', 'x');
    expect(mem.recent('a')).toEqual([]);
    expect(mem.recent('c')).toEqual(['x']);
  });
});
