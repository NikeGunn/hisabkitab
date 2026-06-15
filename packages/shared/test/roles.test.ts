/** Pure unit tests for RBAC (PRD v2.0 §3). Drives the whole permission matrix
 *  from one table, then proves deny-by-default with adversarial probes. */
import { describe, expect, it } from 'vitest';
import { can, assertCan, isRole, RoleError, ROLES, CAPABILITIES, type Role, type Capability } from '../src/index.js';

// The PRD §3 matrix, transcribed once. ✅ = allowed. Tests below are generated
// from this, so adding a capability/role forces an explicit decision here.
const MATRIX: Record<Role, Record<Capability, boolean>> = {
  owner: { record_entry: true, confirm_entry: true, generate_report: true, prepare_vat: true, move_money: true, manage_billing: true },
  accountant: { record_entry: true, confirm_entry: true, generate_report: true, prepare_vat: true, move_money: false, manage_billing: false },
  staff: { record_entry: true, confirm_entry: false, generate_report: false, prepare_vat: false, move_money: false, manage_billing: false },
  viewer: { record_entry: false, confirm_entry: false, generate_report: true, prepare_vat: false, move_money: false, manage_billing: false },
};

describe('can() — full PRD §3 matrix', () => {
  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      const allowed = MATRIX[role][cap];
      it(`${role} ${allowed ? 'MAY' : 'may NOT'} ${cap}`, () => {
        expect(can(role, cap)).toBe(allowed);
      });
    }
  }

  it('the matrix and the code agree on table shape (no orphan caps)', () => {
    for (const role of ROLES) {
      expect(Object.keys(MATRIX[role]).sort()).toEqual([...CAPABILITIES].sort());
    }
  });
});

describe('headline guarantees', () => {
  it('only the owner can move money or manage billing', () => {
    for (const cap of ['move_money', 'manage_billing'] as const) {
      expect(can('owner', cap)).toBe(true);
      expect(can('accountant', cap)).toBe(false);
      expect(can('staff', cap)).toBe(false);
      expect(can('viewer', cap)).toBe(false);
    }
  });

  it('a viewer can read reports but can never write', () => {
    expect(can('viewer', 'generate_report')).toBe(true);
    expect(can('viewer', 'record_entry')).toBe(false);
    expect(can('viewer', 'confirm_entry')).toBe(false);
  });
});

describe('assertCan / RoleError', () => {
  it('passes silently when allowed', () => {
    expect(() => assertCan('owner', 'move_money')).not.toThrow();
  });

  it('throws a typed RoleError when denied', () => {
    try {
      assertCan('staff', 'confirm_entry');
      throw new Error('expected RoleError');
    } catch (e) {
      expect(e).toBeInstanceOf(RoleError);
      expect((e as RoleError).role).toBe('staff');
      expect((e as RoleError).capability).toBe('confirm_entry');
    }
  });
});

describe('PROBES — deny by default', () => {
  it('PROBE: a fabricated/unknown role is refused EVERY capability', () => {
    for (const cap of CAPABILITIES) {
      expect(can('superadmin', cap)).toBe(false);
      expect(can('', cap)).toBe(false);
      expect(can('Owner', cap)).toBe(false); // case-sensitive: not a real role
    }
    expect(isRole('superadmin')).toBe(false);
  });

  it('PROBE: staff cannot confirm an entry (no save without owner/accountant)', () => {
    expect(can('staff', 'confirm_entry')).toBe(false);
    expect(() => assertCan('staff', 'confirm_entry')).toThrow(RoleError);
  });

  it('PROBE: a viewer cannot record a draft entry', () => {
    expect(() => assertCan('viewer', 'record_entry')).toThrow(RoleError);
  });

  it('PROBE: an accountant cannot move money even though they can confirm', () => {
    expect(can('accountant', 'confirm_entry')).toBe(true);
    expect(() => assertCan('accountant', 'move_money')).toThrow(RoleError);
  });
});
