/** Pure unit tests for plan feature-gating (PRD v2.0 §1). */
import { describe, expect, it } from 'vitest';
import { planAllows, planSeats, minPlanFor, checkTeamSeat } from '../src/index.js';

describe('planAllows', () => {
  it('starter has logging + reminders but NOT arap/reports', () => {
    expect(planAllows('starter', 'logging')).toBe(true);
    expect(planAllows('starter', 'vat_reminders')).toBe(true);
    expect(planAllows('starter', 'arap')).toBe(false);
    expect(planAllows('starter', 'reports')).toBe(false);
  });

  it('pro adds arap + the accountant seat, but not reports', () => {
    expect(planAllows('pro', 'arap')).toBe(true);
    expect(planAllows('pro', 'reports')).toBe(false);
    expect(planAllows('pro', 'accountant_seat')).toBe(true);
    expect(planAllows('starter', 'accountant_seat')).toBe(false);
  });

  it('business unlocks everything', () => {
    for (const f of ['logging', 'vat_reminders', 'arap', 'reports', 'accountant_seat'] as const) {
      expect(planAllows('business', f)).toBe(true);
    }
  });

  it('PROBE: an unknown plan denies by default', () => {
    expect(planAllows('enterprise', 'logging')).toBe(false);
    expect(planAllows('', 'reports')).toBe(false);
  });
});

describe('planSeats + minPlanFor', () => {
  it('seat allowances scale with tier', () => {
    expect(planSeats('starter')).toBe(1);
    expect(planSeats('pro')).toBe(3);
    expect(planSeats('business')).toBe(10);
    expect(planSeats('nope')).toBe(0);
  });

  it('points an upgrade prompt at the cheapest unlocking plan', () => {
    expect(minPlanFor('logging')).toBe('starter');
    expect(minPlanFor('arap')).toBe('pro');
    expect(minPlanFor('reports')).toBe('business');
    expect(minPlanFor('accountant_seat')).toBe('pro');
  });
});

describe('checkTeamSeat', () => {
  it('pro: owner + 2 more; accountant, auditor, staff and viewer all fit', () => {
    for (const role of ['accountant', 'auditor', 'staff', 'viewer'] as const) {
      expect(checkTeamSeat('pro', role, 1)).toEqual({ ok: true, seats: 3, used: 1 });
      expect(checkTeamSeat('pro', role, 2)).toEqual({ ok: true, seats: 3, used: 2 });
    }
  });

  it('PROBE: the seat after the last one is refused (boundary exact)', () => {
    expect(checkTeamSeat('pro', 'viewer', 3)).toEqual({ ok: false, reason: 'no_free_seat', seats: 3, used: 3 });
    expect(checkTeamSeat('business', 'auditor', 9).ok).toBe(true);
    expect(checkTeamSeat('business', 'auditor', 10).ok).toBe(false);
  });

  it('starter is the owner alone: nobody else, and an accountant points at Pro', () => {
    expect(checkTeamSeat('starter', 'auditor', 1)).toMatchObject({ ok: false, reason: 'no_free_seat' });
    expect(checkTeamSeat('starter', 'accountant', 1)).toEqual({ ok: false, reason: 'role_not_in_plan', minPlan: 'pro' });
  });

  it('PROBE: owner is never grantable; unknown plan has no seats', () => {
    expect(checkTeamSeat('business', 'owner', 1)).toMatchObject({ ok: false, reason: 'role_not_in_plan' });
    expect(checkTeamSeat('enterprise', 'viewer', 0)).toMatchObject({ ok: false, reason: 'no_free_seat', seats: 0 });
  });

  it('PROBE: a garbled seat count fails closed (never opens a seat)', () => {
    for (const used of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkTeamSeat('business', 'viewer', used).ok).toBe(false);
    }
  });
});
